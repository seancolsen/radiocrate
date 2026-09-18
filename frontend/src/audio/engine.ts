// The playback engine: a pair of long-lived `<audio>` elements plus the play
// context (history / current / queue) they navigate.
//
// Everything that advances playback lives *here*, off the UI: the queue of
// upcoming track ids is snapshotted when playback starts, and the element's
// `ended` handler pulls from it directly. Those handlers fire from the browser's
// media-event dispatch, which keeps running while the PWA is backgrounded and
// the device is locked — so a track ending auto-advances to the next one with no
// help from React, the store, or a repaint. The UI is a *subscriber* to that
// (`EngineEvents`), never the driver.
//
// ## Why two elements
//
// A backgrounded page is only kept alive as a side effect of *actually
// rendering audio*: that is what holds Android's audio focus, keeps the tab out
// of Chrome's freezer, and keeps its network loads unthrottled. The moment a
// track ends, that exemption lapses. A design that then has to open a fresh
// stream — DNS, TLS, a service-worker cold start, the first media bytes — is
// asking the platform for network and CPU in the one window where it is least
// inclined to give them. On stricter Android builds the load simply stalls until
// the app is foregrounded again, which reads to the user as "playback stops
// after one track, and jumps to the next when I open the app".
//
// So the next track is loaded *while the current one is still playing*, into a
// second element held paused and buffered. The `ended` handler then only has to
// swap which element is active and call `play()` on data that is already in
// memory — no network on the critical path, and the gap in rendered audio is one
// JS task rather than a round trip. Every fetch the engine performs happens in
// the safe window: while audio is playing.
//
// Priming waits its turn, though. On a slow connection two streams at once
// starve the one being listened to, so the standby only starts fetching once the
// active element's own download has settled: it fires `suspend` with its network
// idle, meaning the file is fully fetched (or the browser has buffered as far
// ahead as it intends to). A fresh load on the active element likewise drops a
// prime still in flight. A boundary reached before the prime is ready falls back
// to a fresh load.

import { trackStreamUrl } from "api-client";

/** The audio-streaming quality preference: "higher" streams the source file
 * as-is; "lower" asks the backend to transcode lossless sources down to Opus
 * (lossy sources stream unchanged either way). Persisted by the app store,
 * defaulting to "higher". Defined here, beside its one consumer, so the engine
 * imports nothing from either frontend's store. */
export type AudioQualityPref = "higher" | "lower";

/** Maps the persisted quality preference to the backend's `quality` query
 * param: "higher" streams the source as-is (the param is omitted, matching
 * the server's default); "lower" requests the Opus transcode. */
function streamQualityParam(pref: AudioQualityPref): string | undefined {
  return pref === "lower" ? "opus128" : undefined;
}

/** What the engine reports back to its owner. Every callback can fire while the
 * app is backgrounded (the browser keeps dispatching media events), so the store
 * must treat them as arriving at any time — not just in response to a click. */
export interface EngineEvents {
  /** The loaded track changed on the engine's own initiative: an auto-advance
   * when a track ended, or a lock-screen / headset next-previous. */
  onTrackChange: (id: string) => void;
  /** A track counts as a completed play: it reached its end, or it was skipped
   * away from after passing its halfway mark. The owner logs each. */
  onPlayCompleted: (id: string) => void;
  /** The last track ended with an empty queue — nothing left to play. */
  onQueueDry: () => void;
  /** Transport state moved (play / pause / position / duration). The owner
   * re-reads the getters below; deliberately coarse, since the bar only shows a
   * play-pause glyph and a progress bar. */
  onTransport: () => void;
}

/** Artwork for the lock screen and notification shade. The collection has no
 * cover art, so this is the app icon — which still beats the generic globe the
 * OS falls back to for a web page. */
const ARTWORK: MediaImage[] = [
  { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
  { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
];

/** `navigator.audioSession` (Safari 17+ / iOS 16.4+): declaring the session type
 * `playback` is what tells iOS this is a music app rather than incidental page
 * audio — without it a home-screen PWA's audio stops when the screen locks, and
 * the ringer switch mutes it. Not in lib.dom yet. */
interface AudioSessionNavigator {
  audioSession?: { type: string };
}

/** `HTMLMediaElement.HAVE_METADATA`, spelled out so the engine loads outside a
 * browser (its tests run in plain Node). */
const HAVE_METADATA = 1;

/** `HTMLMediaElement.NETWORK_IDLE`: the element has a resource but isn't
 * fetching any of it right now. */
const NETWORK_IDLE = 1;

/** Ten milliseconds of silent WAV, for {@link AudioEngine.unlock} to play on a
 * standby element with nothing loaded yet. Inline, so it costs no fetch. */
const SILENCE =
  "data:audio/wav;base64,UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";

/** Whether `t` falls inside one of `ranges`. */
function inRanges(ranges: TimeRanges, t: number): boolean {
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= t && t <= ranges.end(i)) return true;
  }
  return false;
}

export class AudioEngine {
  /** The two interchangeable players: one active, one holding the next track
   * pre-buffered. Roles swap on every auto-advance — see {@link handoff}. */
  private readonly elements: readonly [HTMLAudioElement, HTMLAudioElement];
  /** Which of {@link elements} is the active player. */
  private activeIndex: 0 | 1 = 0;
  private readonly events: EngineEvents;
  /** `navigator.mediaSession`, absent on browsers that don't support it. */
  private readonly media: MediaSession | undefined;

  /** The currently loaded track id. */
  private current: string | undefined;
  /** Tracks played before the current one, nearest last — the "previous" stack. */
  private history: string[] = [];
  /** Tracks queued after the current one, next up at the front. */
  private queue: string[] = [];
  /** The track id the standby element is buffering, if any. */
  private primed: string | undefined;
  /** Set once a browser has refused to play the standby element (see
   * {@link unlock}). From then on the engine advances by reloading the single
   * element it knows it is allowed to use — the pre-two-element behavior. */
  private handoffBlocked = false;
  /** Whether the Media Session transport actions (play/pause/next/…) are
   * currently wired to this engine. {@link stop} unwires them so a hardware or
   * Bluetooth control can't resume a track that's been closed; {@link load}
   * wires them back for whatever plays next. */
  private mediaHandlersInstalled = false;
  /** Whether the engine believes it should be producing sound. Distinguishes "the
   * user paused" from "the platform stalled us", which is what makes the
   * resume-on-foreground check safe. */
  private wantPlaying = false;
  /** Reads the live streaming-quality preference, consulted on every `load`. */
  private readonly getQuality: () => AudioQualityPref;
  /** The `quality` param the active element's stream was requested with, so a
   * restart (see {@link seek}) asks for the same stream even if the preference
   * has changed since. */
  private activeQuality: string | undefined;
  /** The same, for the stream the standby element is buffering. */
  private primedQuality: string | undefined;
  /** Where the active element's timeline starts within the track, in seconds.
   * Zero unless a seek restarted a transcode part-way in: the element then
   * counts from zero again, so everything it reports is shifted by this much. */
  private offset = 0;
  /** The current track's length according to the library, from
   * {@link setMetadata}. A transcode is streamed as it's encoded — no
   * `Content-Length`, no range support — so its element reports an infinite
   * duration, and this is the only length it has. */
  private knownDuration: number | null = null;

  constructor(events: EngineEvents, getQuality: () => AudioQualityPref) {
    this.events = events;
    this.getQuality = getQuality;

    // Both elements are created up front and kept in the document (hidden) for
    // the app's lifetime. iOS ties the permission earned by the first
    // user-gesture `play()` to *the element it was called on*, so an element
    // conjured later — at a track boundary, with no gesture in sight — would
    // never be allowed to start. Creating both now lets {@link unlock} claim
    // that permission for the pair while a real gesture is still on the stack.
    this.elements = [this.createElement(), this.createElement()];

    this.media =
      "mediaSession" in navigator ? navigator.mediaSession : undefined;

    const nav = navigator as Navigator & AudioSessionNavigator;
    if (nav.audioSession) nav.audioSession.type = "playback";

    this.installHandlers();
  }

  /** The element currently playing. */
  private get audio(): HTMLAudioElement {
    return this.elements[this.activeIndex];
  }

  /** The element holding the next track, pre-buffered and paused. */
  private get standby(): HTMLAudioElement {
    return this.elements[this.activeIndex === 0 ? 1 : 0];
  }

  // ── Transport state (read by the now-playing bar) ──────────────────────────

  get isPlaying(): boolean {
    return !this.audio.paused && !this.audio.ended;
  }

  get position(): number {
    const t = this.audio.currentTime;
    return this.offset + (Number.isFinite(t) ? t : 0);
  }

  /** The current track's duration, or `null` while neither the library nor a
   * finished download has supplied one.
   *
   * The library's length wins. The element's own is trusted only once its
   * download has settled: while a stream is still arriving, a browser may
   * report the length of what it has so far, which grows as bytes land. */
  get duration(): number | null {
    if (this.knownDuration !== null) return this.knownDuration;
    const el = this.audio;
    const d = el.duration;
    const fetched =
      el.readyState >= HAVE_METADATA && el.networkState === NETWORK_IDLE;
    return fetched && Number.isFinite(d) && d > 0 ? this.offset + d : null;
  }

  /** Whether a track is queued after the current one. */
  get hasNext(): boolean {
    return this.queue.length > 0;
  }

  // ── Commands ───────────────────────────────────────────────────────────────

  /** Loads and plays `current`, establishing the play context around it:
   * `preceding` are the tracks before it (nearest last) that "previous" walks
   * back through, `upcoming` the ones after it that auto-advance and "next" walk
   * forward through. */
  setPlaylist(preceding: string[], current: string, upcoming: string[]): void {
    // Starting a fresh track abandons whatever was playing. If that track was
    // already past its halfway mark it counts as a completed play — note it
    // before `load` swaps in the new track's position.
    this.notePlayCompleted(false);
    this.history = preceding;
    this.queue = upcoming;
    this.load(current);
    // Called from a click or a keyboard command, so a user gesture is on the
    // stack right now — the only moment the standby element can be unlocked.
    this.unlock();
  }

  /** Replaces the play context around the current track — `preceding` and
   * `upcoming` computed fresh, e.g. after the query it came from re-ran and the
   * surrounding rows shifted — without touching what's actually playing. Drops
   * a standby prime that no longer matches the new `upcoming[0]` and re-primes
   * if one is now due. */
  updateQueue(preceding: string[], upcoming: string[]): void {
    if (this.current === undefined) return;
    this.history = preceding;
    this.queue = upcoming;
    this.yieldStandby();
    this.primeNext();
    this.events.onTransport(); // hasNext may have changed
  }

  play(): void {
    this.wantPlaying = true;
    void this.audio.play().catch(() => {});
    this.setPlaybackState("playing");
  }

  pause(): void {
    this.wantPlaying = false;
    this.audio.pause();
    this.setPlaybackState("paused");
  }

  /** Skips to the next queued track; a no-op with an empty queue. */
  skipNext(): void {
    this.goNext(false);
  }

  /** Stops playback and tears down the play context and OS media session. */
  stop(): void {
    this.wantPlaying = false;
    for (const el of this.elements) {
      el.pause();
      el.removeAttribute("src");
    }
    this.current = undefined;
    this.primed = undefined;
    this.offset = 0;
    this.knownDuration = null;
    this.history = [];
    this.queue = [];
    if (this.media) {
      this.media.metadata = null;
      this.media.playbackState = "none";
    }
    // Clearing metadata alone leaves the transport actions wired: a hardware
    // or Bluetooth "play" press would still reach `this.play()` and call
    // `.play()` on an element with no `src`, which silently no-ops but still
    // flips `playbackState` back to "playing". Unwiring the actions means a
    // closed track genuinely can't be resumed from outside the app.
    this.teardownMediaActionHandlers();
    this.events.onTransport();
  }

  /** Takes the current track's library metadata: its title and artist for the
   * OS / lock-screen "now playing" display, and its length for the transport
   * (see {@link knownDuration}). */
  setMetadata(
    title: string | null,
    artist: string | null,
    duration: number | null,
  ): void {
    this.knownDuration = duration !== null && duration > 0 ? duration : null;
    this.updatePositionState();
    this.events.onTransport();
    if (!this.media) return;
    this.media.metadata = new MediaMetadata({
      title: title ?? "",
      artist: artist ?? "",
      artwork: ARTWORK,
    });
  }

  /** Whether playback of the current track has reached its halfway point —
   * the threshold at which an abandoned track still counts as a play. `false`
   * when the duration isn't known yet. */
  get pastHalfway(): boolean {
    const d = this.duration;
    return d !== null && this.position >= d * 0.5;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private createElement(): HTMLAudioElement {
    const audio = new Audio();
    // "auto" is what lets the standby element pull the next track down ahead of
    // time; without it the browser fetches metadata only and the boundary is
    // back to needing the network.
    audio.preload = "auto";
    audio.style.display = "none";
    document.body.appendChild(audio);
    return audio;
  }

  /** Starts `id` on the active element, from scratch. The slow path: used for
   * the first track, for "previous", and whenever the standby element isn't
   * already holding the track we want. */
  private load(id: string): void {
    // A retry of the same track (see `handoffFailed`) keeps the length its
    // metadata fetch already supplied.
    if (id !== this.current) this.knownDuration = null;
    this.offset = 0;
    this.activeQuality = streamQualityParam(this.getQuality());
    this.audio.src = trackStreamUrl(id, this.activeQuality);
    this.audio.load();
    this.wantPlaying = true;
    void this.audio.play().catch(() => {});
    this.current = id;
    this.setPlaybackState("playing");
    // A previous `stop()` may have unwired the transport actions; this track
    // is resumable again, so wire them back.
    if (!this.mediaHandlersInstalled) this.installMediaActionHandlers();
    // The next track is primed once this one has downloaded (see `suspend`).
    this.yieldStandby();
  }

  /** Makes way for a fresh fetch on the active element. A prime still
   * downloading would share the connection with it, so it's dropped;
   * {@link primeNext} starts it again once the active track has downloaded. A
   * prime of the right track that's already fully fetched costs nothing, so it
   * stays. */
  private yieldStandby(): void {
    if (this.primed === undefined) return;
    const fetched = this.standby.networkState === NETWORK_IDLE;
    if (this.primed === this.queue[0] && fetched) return;
    this.releaseStandby();
  }

  /** Empties the standby element. `load()` with no `src` is what aborts a fetch
   * in flight; removing the attribute alone lets it run on. */
  private releaseStandby(): void {
    const el = this.standby;
    el.pause();
    el.removeAttribute("src");
    el.load();
    this.primed = undefined;
  }

  /** Points the standby element at whatever is next in the queue, so the next
   * boundary can be crossed without touching the network. It only starts a
   * fetch once the active element has finished its own, so the two never share
   * a slow connection. Cheap and idempotent: re-priming the track already
   * primed does nothing, and an empty queue releases the buffer. */
  private primeNext(): void {
    if (this.handoffBlocked) return;
    const next = this.queue[0];
    const el = this.standby;
    if (next === undefined) {
      if (this.primed !== undefined) this.releaseStandby();
      return;
    }
    if (this.primed === next && el.getAttribute("src")) return;
    if (this.audio.networkState !== NETWORK_IDLE) return;
    el.pause();
    this.primedQuality = streamQualityParam(this.getQuality());
    el.src = trackStreamUrl(next, this.primedQuality);
    el.load();
    this.primed = next;
  }

  /** Crosses a track boundary using the pre-buffered standby element: swap roles
   * and play. Deliberately synchronous and network-free — this runs from the
   * `ended` handler of a page that has, for the moment, stopped rendering audio
   * and is therefore at its most freezable. */
  private handoff(id: string): void {
    this.activeIndex = this.activeIndex === 0 ? 1 : 0;
    this.activeQuality = this.primedQuality;
    this.offset = 0;
    this.knownDuration = null;
    this.current = id;
    this.wantPlaying = true;
    void this.audio.play().catch(() => this.handoffFailed(id));
    // The outgoing element is the standby now. `ended` already stopped it; a
    // *skip* did not, and a skipped track may still be downloading.
    this.releaseStandby();
    this.setPlaybackState("playing");
    // Primes straight away if the incoming track finished downloading while it
    // waited; otherwise its `suspend` will.
    this.primeNext();
  }

  /** The standby element was refused playback — Safari grants that permission
   * per element, and only against a user gesture, so a browser that ignores
   * {@link unlock} can only ever play the one element. Fall back to the element
   * that does have permission and never hand off again. */
  private handoffFailed(id: string): void {
    if (this.current !== id) return; // superseded by a later navigation
    this.handoffBlocked = true;
    const stranded = this.audio;
    stranded.pause();
    stranded.removeAttribute("src");
    stranded.load(); // abort its fetch, which would compete with the reload
    this.activeIndex = this.activeIndex === 0 ? 1 : 0;
    this.load(id);
  }

  /** Claims playback permission for the standby element while a user gesture is
   * still on the stack. Muted so the listener hears nothing of the next track;
   * the element is returned to the start and unmuted before it is ever needed.
   * With nothing primed yet (the usual case, since priming waits on the active
   * download) it borrows {@link SILENCE} to play, and gives it back after. */
  private unlock(): void {
    if (this.handoffBlocked) return;
    const el = this.standby;
    const borrowed = !el.getAttribute("src");
    if (borrowed) el.src = SILENCE;
    el.muted = true;
    void el
      .play()
      .then(() => {
        el.pause();
        if (!borrowed) {
          el.currentTime = 0;
        } else if (el.getAttribute("src") === SILENCE) {
          // Not already replaced by a prime.
          el.removeAttribute("src");
          el.load();
        }
        el.muted = false;
      })
      .catch(() => {
        el.muted = false;
      });
  }

  /** Advances to the next queued track, pushing the current one onto the history
   * stack. Returns `false` (leaving playback untouched) when the queue is empty.
   * `ended` is `true` when the current track reached its end (auto-advance)
   * rather than being skipped, which decides whether it's logged as a completed
   * play. */
  private goNext(ended: boolean): boolean {
    const next = this.queue.shift();
    if (next === undefined) {
      // Nothing to advance to. A track that ended still counts as a completed
      // play; a skip with an empty queue leaves the current track playing, so it
      // doesn't.
      if (ended) this.notePlayCompleted(true);
      return false;
    }
    // Decided before the move (it reads the outgoing element's position) but
    // reported after it: `onPlayCompleted` and `onTrackChange` both put requests
    // on the wire, and nothing may share the boundary with getting audio going
    // again.
    const completed = this.completedPlay(ended);
    const previous = this.current;
    if (this.primed === next) this.handoff(next);
    else this.load(next);
    if (previous !== undefined) this.history.push(previous);
    if (completed !== undefined) this.events.onPlayCompleted(completed);
    this.events.onTrackChange(next);
    return true;
  }

  /** Steps back to the previous track, returning the current one to the front of
   * the queue. Skipping back logs the abandoned track as a play if it played
   * past its halfway mark. */
  private goPrev(): boolean {
    const prev = this.history.pop();
    if (prev === undefined) return false;
    const completed = this.completedPlay(false);
    if (this.current !== undefined) this.queue.unshift(this.current);
    this.load(prev);
    if (completed !== undefined) this.events.onPlayCompleted(completed);
    this.events.onTrackChange(prev);
    return true;
  }

  /** The track to report as a completed play when leaving the current one, or
   * `undefined` for none — either unconditionally (`force`, when it reached its
   * end) or when it played at least halfway. Must be called before the outgoing
   * element stops being the active one. */
  private completedPlay(force: boolean): string | undefined {
    const id = this.current;
    if (id === undefined) return undefined;
    return force || this.pastHalfway ? id : undefined;
  }

  /** Reports the current track as a completed play, on the same terms as
   * {@link completedPlay}, when there is no move to sequence it against. */
  private notePlayCompleted(force: boolean): void {
    const id = this.completedPlay(force);
    if (id !== undefined) this.events.onPlayCompleted(id);
  }

  private setPlaybackState(state: MediaSessionPlaybackState): void {
    if (this.media) this.media.playbackState = state;
  }

  /** Reports position and duration to the OS so the lock-screen scrubber stays
   * in sync. Silently skipped until the duration is known. */
  private updatePositionState(): void {
    const duration = this.duration;
    if (!this.media?.setPositionState || duration === null) return;
    this.media.setPositionState({
      duration,
      playbackRate: 1,
      position: Math.min(Math.max(this.position, 0), duration),
    });
  }

  /** Moves the playhead to `seconds`, clamped to the track.
   *
   * A file served whole seeks in place: the browser range-requests whatever it
   * needs. A transcode can't — it has no length and no range support — so it
   * seeks in place only within what it has already buffered. Anywhere else the
   * stream is restarted from the target (see {@link restartAt}). */
  seek(seconds: number): void {
    const duration = this.duration;
    let target = Math.max(seconds, 0);
    if (duration !== null) target = Math.min(target, duration);
    const el = this.audio;
    const local = target - this.offset;
    const inPlace =
      local >= 0 &&
      // Before its metadata loads, the element keeps the position as where to
      // start once it does — nor could it tell a transcode from a file yet.
      (el.readyState < HAVE_METADATA ||
        Number.isFinite(el.duration) ||
        inRanges(el.buffered, local));
    if (inPlace) el.currentTime = local;
    else this.restartAt(target);
  }

  /** Re-requests the current track's transcode starting at `target` seconds,
   * via the backend's `start` param. The new stream's timeline begins at zero,
   * which {@link offset} accounts for. */
  private restartAt(target: number): void {
    const id = this.current;
    if (id === undefined) return;
    const duration = this.duration;
    if (duration !== null && target >= duration) {
      // Nothing left to stream: finish the track, as `ended` would.
      if (!this.goNext(true)) this.events.onQueueDry();
      return;
    }
    const start = Math.round(target * 1000) / 1000;
    const el = this.audio;
    this.offset = start;
    el.src = trackStreamUrl(id, this.activeQuality, start);
    el.load();
    this.yieldStandby();
    if (this.wantPlaying) void el.play().catch(() => {});
    this.updatePositionState();
    this.events.onTransport();
  }

  private seekBy(offset: number): void {
    this.seek(this.position + offset);
  }

  /** Registers the browser callbacks that drive playback off the UI: the audio
   * elements' own events, and (where supported) the Media Session transport
   * actions — lock-screen, notification-shade, Bluetooth and headset controls,
   * which are what make the PWA behave like a native player. */
  private installHandlers(): void {
    const transport = () => this.events.onTransport();
    for (const el of this.elements) {
      // The standby element loads and buffers while the active one plays; only
      // the active one's events describe the transport the user can see.
      const active = () => el === this.audio;

      el.addEventListener("play", () => {
        if (active()) transport();
      });
      el.addEventListener("pause", () => {
        if (active()) transport();
      });
      el.addEventListener("durationchange", () => {
        if (!active()) return;
        this.updatePositionState();
        transport();
      });
      el.addEventListener("timeupdate", () => {
        if (!active()) return;
        this.updatePositionState();
        transport();
      });

      // The active track's download has settled, so the connection is free to
      // prime the next one. `primeNext` checks the network really went idle.
      // A settled download is also what makes the element's duration
      // trustworthy (see `duration`), so the bar re-reads it.
      el.addEventListener("suspend", () => {
        if (!active()) return;
        this.primeNext();
        this.updatePositionState();
        transport();
      });

      // Auto-advance when the current track finishes. This fires from the
      // browser's media-event dispatch, so it keeps working while the app is
      // backgrounded or the screen is locked. `goNext(true)` logs the finished
      // track as a completed play whether or not there's a next one.
      el.addEventListener("ended", () => {
        if (!active()) return;
        if (!this.goNext(true)) this.events.onQueueDry();
      });

      // A stream that fails to load (network drop, deleted file) leaves the
      // track in the bar, paused, for the user to skip past — deliberately *not*
      // auto-advancing, which would silently race through an entire queue on a
      // dropped connection. The same failure on the *standby* element is not
      // user-visible at all: drop the prime and let the boundary fall back to a
      // fresh load.
      el.addEventListener("error", () => {
        if (!active()) {
          this.primed = undefined;
          return;
        }
        if (this.current === undefined) return; // teardown, not a real failure
        console.error("audio stream failed", el.error?.message ?? "");
        this.wantPlaying = false;
        this.setPlaybackState("paused");
        transport();
      });
    }

    // Last-resort recovery. If the platform stalled a boundary anyway — the
    // element is loaded and we believe we should be playing, but it is sitting
    // paused — getting the app back on screen lifts every restriction that could
    // have caused it, so try again there.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      if (!this.wantPlaying || this.current === undefined) return;
      if (!this.audio.paused || this.audio.ended) return;
      void this.audio.play().catch(() => {});
    });

    this.installMediaActionHandlers();
  }

  /** Registers (or re-registers) the Media Session transport actions —
   * lock-screen, notification-shade, Bluetooth and headset controls. Paired
   * with {@link teardownMediaActionHandlers}, which {@link stop} uses to make
   * sure a closed track can't be resumed from outside the app. */
  private installMediaActionHandlers(): void {
    const media = this.media;
    if (!media) return;
    this.setMediaActionHandler("play", () => this.play());
    this.setMediaActionHandler("pause", () => this.pause());
    this.setMediaActionHandler("nexttrack", () => this.goNext(false));
    this.setMediaActionHandler("previoustrack", () => this.goPrev());
    this.setMediaActionHandler("seekbackward", (d) =>
      this.seekBy(-(d.seekOffset ?? 10)),
    );
    this.setMediaActionHandler("seekforward", (d) =>
      this.seekBy(d.seekOffset ?? 10),
    );
    this.setMediaActionHandler("seekto", (d) => {
      if (d.seekTime != null) this.seek(d.seekTime);
    });
    this.mediaHandlersInstalled = true;
  }

  /** Unregisters every Media Session transport action, so a hardware or
   * Bluetooth control has nothing left to call. */
  private teardownMediaActionHandlers(): void {
    if (!this.mediaHandlersInstalled) return;
    this.setMediaActionHandler("play", null);
    this.setMediaActionHandler("pause", null);
    this.setMediaActionHandler("nexttrack", null);
    this.setMediaActionHandler("previoustrack", null);
    this.setMediaActionHandler("seekbackward", null);
    this.setMediaActionHandler("seekforward", null);
    this.setMediaActionHandler("seekto", null);
    this.mediaHandlersInstalled = false;
  }

  private setMediaActionHandler(
    action: MediaSessionAction,
    handler: MediaSessionActionHandler | null,
  ): void {
    try {
      this.media?.setActionHandler(action, handler);
    } catch {
      // An action this browser doesn't know about — nothing to degrade.
    }
  }
}
