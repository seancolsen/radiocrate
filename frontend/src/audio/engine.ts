// The playback engine: one long-lived `<audio>` element plus the play context
// (history / current / queue) it navigates.
//
// Everything that advances playback lives *here*, off the UI: the queue of
// upcoming track ids is snapshotted when playback starts, and the element's
// `ended` handler pulls from it directly. Those handlers fire from the browser's
// media-event dispatch, which keeps running while the PWA is backgrounded and
// the device is locked — so a track ending auto-advances to the next one with no
// help from Solid, the store, or a repaint. The UI is a *subscriber* to that
// (`EngineEvents`), never the driver.

import { trackStreamUrl } from "api-client";
import type { AudioQualityPref } from "../state/store";

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

export class AudioEngine {
  private readonly audio: HTMLAudioElement;
  private readonly events: EngineEvents;
  /** `navigator.mediaSession`, absent on browsers that don't support it. */
  private readonly media: MediaSession | undefined;

  /** The currently loaded track id. */
  private current: string | undefined;
  /** Tracks played before the current one, nearest last — the "previous" stack. */
  private history: string[] = [];
  /** Tracks queued after the current one, next up at the front. */
  private queue: string[] = [];
  /** Reads the live streaming-quality preference, consulted on every `load`. */
  private readonly getQuality: () => AudioQualityPref;

  constructor(events: EngineEvents, getQuality: () => AudioQualityPref) {
    this.events = events;
    this.getQuality = getQuality;

    const audio = new Audio();
    audio.preload = "auto";
    // Kept in the document (hidden) for the app's lifetime. iOS ties the
    // permission earned by the first user-gesture `play()` to *this element*, so
    // recreating it per track would break every later background auto-advance.
    audio.style.display = "none";
    document.body.appendChild(audio);
    this.audio = audio;

    this.media =
      "mediaSession" in navigator ? navigator.mediaSession : undefined;

    const nav = navigator as Navigator & AudioSessionNavigator;
    if (nav.audioSession) nav.audioSession.type = "playback";

    this.installHandlers();
  }

  // ── Transport state (read by the now-playing bar) ──────────────────────────

  get isPlaying(): boolean {
    return !this.audio.paused && !this.audio.ended;
  }

  get position(): number {
    const t = this.audio.currentTime;
    return Number.isFinite(t) ? t : 0;
  }

  /** The current track's duration, or `null` before metadata has loaded. */
  get duration(): number | null {
    const d = this.audio.duration;
    return Number.isFinite(d) && d > 0 ? d : null;
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
  }

  play(): void {
    void this.audio.play().catch(() => {});
    this.setPlaybackState("playing");
  }

  pause(): void {
    this.audio.pause();
    this.setPlaybackState("paused");
  }

  /** Skips to the next queued track; a no-op with an empty queue. */
  skipNext(): void {
    this.goNext(false);
  }

  /** Stops playback and tears down the play context and OS media session. */
  stop(): void {
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.current = undefined;
    this.history = [];
    this.queue = [];
    if (this.media) {
      this.media.metadata = null;
      this.media.playbackState = "none";
    }
    this.events.onTransport();
  }

  /** Updates the OS / lock-screen "now playing" metadata for the current track. */
  setMetadata(title: string | null, artist: string | null): void {
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

  private load(id: string): void {
    this.audio.src = trackStreamUrl(id, streamQualityParam(this.getQuality()));
    this.audio.load();
    void this.audio.play().catch(() => {});
    this.current = id;
    this.setPlaybackState("playing");
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
    this.notePlayCompleted(ended);
    if (this.current !== undefined) this.history.push(this.current);
    this.load(next);
    this.events.onTrackChange(next);
    return true;
  }

  /** Steps back to the previous track, returning the current one to the front of
   * the queue. Skipping back logs the abandoned track as a play if it played
   * past its halfway mark. */
  private goPrev(): boolean {
    const prev = this.history.pop();
    if (prev === undefined) return false;
    this.notePlayCompleted(false);
    if (this.current !== undefined) this.queue.unshift(this.current);
    this.load(prev);
    this.events.onTrackChange(prev);
    return true;
  }

  /** Reports the current track as a completed play — either unconditionally
   * (`force`, when it reached its end) or when it played at least halfway. */
  private notePlayCompleted(force: boolean): void {
    const id = this.current;
    if (id === undefined) return;
    if (force || this.pastHalfway) this.events.onPlayCompleted(id);
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

  private seekBy(offset: number): void {
    const duration = this.duration;
    let target = Math.max(this.position + offset, 0);
    if (duration !== null) target = Math.min(target, duration);
    this.audio.currentTime = target;
  }

  /** Registers the browser callbacks that drive playback off the UI: the audio
   * element's own events, and (where supported) the Media Session transport
   * actions — lock-screen, notification-shade, Bluetooth and headset controls,
   * which are what make the PWA behave like a native player. */
  private installHandlers(): void {
    const transport = () => this.events.onTransport();
    this.audio.addEventListener("play", transport);
    this.audio.addEventListener("pause", transport);
    this.audio.addEventListener("durationchange", () => {
      this.updatePositionState();
      transport();
    });
    this.audio.addEventListener("timeupdate", () => {
      this.updatePositionState();
      transport();
    });

    // Auto-advance when the current track finishes. This fires from the
    // browser's media-event dispatch, so it keeps working while the app is
    // backgrounded or the screen is locked. `goNext(true)` logs the finished
    // track as a completed play whether or not there's a next one.
    this.audio.addEventListener("ended", () => {
      if (!this.goNext(true)) this.events.onQueueDry();
    });

    // A stream that fails to load (network drop, deleted file) leaves the track
    // in the bar, paused, for the user to skip past — deliberately *not*
    // auto-advancing, which would silently race through an entire queue on a
    // dropped connection.
    this.audio.addEventListener("error", () => {
      if (this.current === undefined) return; // teardown, not a real failure
      console.error("audio stream failed", this.audio.error?.message ?? "");
      this.setPlaybackState("paused");
      transport();
    });

    const media = this.media;
    if (!media) return;
    const on = (
      action: MediaSessionAction,
      handler: MediaSessionActionHandler,
    ) => {
      try {
        media.setActionHandler(action, handler);
      } catch {
        // An action this browser doesn't know about — nothing to degrade.
      }
    };
    on("play", () => this.play());
    on("pause", () => this.pause());
    on("nexttrack", () => this.goNext(false));
    on("previoustrack", () => this.goPrev());
    on("seekbackward", (d) => this.seekBy(-(d.seekOffset ?? 10)));
    on("seekforward", (d) => this.seekBy(d.seekOffset ?? 10));
    on("seekto", (d) => {
      if (d.seekTime != null) this.audio.currentTime = d.seekTime;
    });
  }
}
