// The playback engine: a pair of long-lived `<audio>` elements (and, on
// Android, a third that keeps the media session alive) plus the play context
// (history / current / queue) they navigate.
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
//
// ## Why a keep-alive (Android)
//
// A third element loops ten seconds of silence for as long as playback is meant
// to be running. It looks like a hack; it's the page-side form of what Android
// asks native players to do, and it has to stay until Chrome does it itself.
//
// The problem: two elements keep the network off a track boundary, but not a
// moment with nothing playing. The outgoing track fires `ended`, and only then
// does the incoming one start. Since Chrome 155 on Android 17 (October 2026),
// that moment is enough to lose the right to be heard: on a locked phone the
// incoming track plays two to five seconds, then goes silent — still "playing",
// position advancing, decoder running — until the app is opened or a
// lock-screen control is pressed. A `play()` the page issues itself after a
// pause fares worse: Chrome pauses the element again ~70 ms later.
//
// Why, as best we've been able to trace it (verified on the device with the
// playback log, then explained by research into the Android docs and Chromium
// source):
//
// - Android 17's "background audio hardening" requires an app playing from the
//   background to hold a foreground service with *while-in-use* capability,
//   which a service started from the background doesn't get — only one started
//   while the app was visible, or from a notification tap or media key.
//   Violations fail silently: playback is muted, and audio focus requests fail.
//   It binds apps that target API 37.
//   https://developer.android.com/about/versions/17/changes/bg-audio
// - Chrome 155 is the first Chrome to target API 37
//   (https://chromium-review.googlesource.com/c/chromium/src/+/8353288), which
//   is why this began with a Chrome update rather than the OS one.
// - Chrome holds its media-playback foreground service only while its media
//   session has a player playing, and drops it at once when the session goes
//   idle on a locked device — which a track's `ended` does. The next `play()`
//   restarts it from the background, without while-in-use, so it's muted.
//   Android's guidance is the opposite — keep the service through gaps under
//   ten minutes — and the lock-screen tap works because it's an exempt start.
// - When Chrome's audio focus request is refused, it pauses the player: that's
//   the stray pause after a page-initiated `play()`.
//
// So the fix is never to let Chrome's session go idle while the user means to
// be listening. The keep-alive starts with the first track, inside the user's
// gesture, while the page is visible — so the service it holds up was started
// legitimately — and keeps it up across every boundary. It stops only when the
// user pauses, playback stops, or a track fails; resuming is then the user's
// own action again, which Android allows.
//
// What it relies on — Chrome internals, not web-platform guarantees:
//
// - Longer than five seconds: Chrome treats shorter media as a one-shot sound,
//   which doesn't hold the session up (`KEEP_ALIVE_SECS`).
// - Unmuted, volume above zero: Chrome counts a never-unmuted player as having
//   no audio, and pauses zero-volume audio in the background.
// - A real `<audio>` element: Web Audio is an "ambient" player Chrome ignores
//   for audio focus, and would be muted itself.
// - Never paused and replayed by the page while hidden: that `play()` can't
//   reclaim the service (see above), and gets paused.
//
// Silence is below Chrome's audibility threshold; that's fine today (it still
// counts as a playing player), but a future rule against inaudible background
// media could break this. Others hit the same wall the same week and landed on
// the same fix (https://github.com/radio4000/r4-svelte/pull/223).
//
// Alternatives considered: starting the next track before the current one
// ends is fragile (it must be audible and already playing at `ended`); a
// single element fed by Media Source Extensions would never end between tracks
// and is the principled replacement — gapless, too — but Chrome's MSE takes
// neither raw FLAC nor Ogg, so the server would have to remux into fMP4/WebM.
//
// It can go once Chrome keeps its media service through short gaps — not
// merely once a Chrome stops targeting API 37. The target change was reverted
// on Chromium's main branch (M158) two weeks after landing, for an unrelated
// reason, and is bound to come back. To test the real thing: drop the
// keep-alive, play from a locked phone across a boundary, and
// read the playback log (About → Playback log) — or `adb logcat | grep
// AudioHardening`, which logs "background playback muted" when it bites.

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

/** Which way the engine moved from one track to another. */
export type TrackStep = "next" | "previous";

/** What the engine reports back to its owner. Every callback can fire while the
 * app is backgrounded (the browser keeps dispatching media events), so the store
 * must treat them as arriving at any time — not just in response to a click. */
export interface EngineEvents {
  /** The loaded track changed on the engine's own initiative: an auto-advance
   * when a track ended, or a lock-screen / headset next-previous. `step` says
   * which way it went: forward to the front of the queue (`"next"`), or back
   * to the last track of the history (`"previous"`). */
  onTrackChange: (id: string, step: TrackStep) => void;
  /** A track counts as a completed play: it reached its end, or it was skipped
   * away from after passing its halfway mark. The owner logs each. */
  onPlayCompleted: (id: string) => void;
  /** The last track ended with an empty queue — nothing left to play. */
  onQueueDry: () => void;
  /** Transport state moved (play / pause / position / duration). The owner
   * re-reads the getters below; deliberately coarse, since the bar only shows a
   * play-pause glyph and a progress bar. */
  onTransport: () => void;
  /** An element has just started fetching a stream from the backend — a
   * request the owner may want to stay out of the way of (see
   * `api/idleQueue.ts`). */
  onStreamRequest: () => void;
}

/** Where the engine reports what it does, for diagnosing playback that goes
 * wrong out of sight — see `playbackLog.ts`, which is what implements it. */
export interface EngineTrace {
  add(kind: string, detail?: string): void;
  /** Persists what's been added; called when the page may be about to stop. */
  flush(): void;
}

/** The element events traced, beyond the ones the engine acts on. `progress`
 * and `timeupdate` are left out: they fire several times a second, and the
 * heartbeat already samples what they'd show. */
const TRACED_EVENTS = [
  "loadstart",
  "loadedmetadata",
  "loadeddata",
  "canplay",
  "canplaythrough",
  "play",
  "playing",
  "pause",
  "waiting",
  "stalled",
  "suspend",
  "emptied",
  "abort",
  "ended",
  "error",
  "seeking",
  "seeked",
  "volumechange",
  "ratechange",
] as const;

/** Page events traced: visibility, and the Page Lifecycle API's `freeze` and
 * `resume`, which Chrome fires around freezing a backgrounded page. */
const TRACED_PAGE_EVENTS = [
  "visibilitychange",
  "freeze",
  "resume",
  "pagehide",
  "pageshow",
] as const;

/** How often the heartbeat samples the players while the page is hidden —
 * where the trouble is — and while it's visible. */
const HIDDEN_HEARTBEAT_MS = 3000;
const VISIBLE_HEARTBEAT_MS = 15000;

/** Chrome's count of audio bytes an element has decoded: it climbs while the
 * media pipeline is running, whatever comes out of the speaker. */
interface DecodedByteCount {
  webkitAudioDecodedByteCount?: number;
}

/** A track id, shortened for the trace. */
/** Whether two lists of track ids are the same, in the same order. */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function shortId(id: string | undefined): string {
  return id === undefined ? "none" : id.slice(0, 8);
}

/** An element's `src`, shortened for the trace: the track id and query. */
function shortSrc(src: string | null): string {
  if (!src) return "none";
  if (src.startsWith("data:")) return "silence";
  const m = /\/api\/tracks\/([^/]+)\/stream(\?.*)?$/.exec(src);
  return m ? `${shortId(decodeURIComponent(m[1]!))}${m[2] ?? ""}` : src;
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
  audioSession?: {
    type: string;
    /** Read only by the trace: whether the platform has the session active,
     * inactive or interrupted. */
    state?: string;
    addEventListener?: (type: string, listener: () => void) => void;
  };
}

/** `HTMLMediaElement.HAVE_METADATA`, spelled out so the engine loads outside a
 * browser (its tests run in plain Node). */
const HAVE_METADATA = 1;

/** `HTMLMediaElement.HAVE_FUTURE_DATA`: enough is buffered to play on from
 * the current position. Below it, a playing element is waiting for data. */
const HAVE_FUTURE_DATA = 3;

/** `HTMLMediaElement.NETWORK_IDLE`: the element has a resource but isn't
 * fetching any of it right now. */
const NETWORK_IDLE = 1;

/** A stretch of the current track that has been downloaded, as `[start, end]`
 * in seconds into the track. */
export type LoadedRange = readonly [number, number];

/** What a failed load says once the server has been asked for the stream
 * itself and handed it over (see {@link AudioEngine.diagnose}): the trouble was
 * in the browser's hands, and the element's error code is all there is to go
 * on. Codes from `MediaError`. */
export function mediaErrorMessage(code: number | undefined): string {
  switch (code) {
    case 2: // MEDIA_ERR_NETWORK
      return "The connection dropped while loading";
    case 3: // MEDIA_ERR_DECODE
      return "The file couldn't be decoded";
    case 4: // MEDIA_ERR_SRC_NOT_SUPPORTED
      return "This browser can't play the file's format";
    default:
      return "The track couldn't be loaded";
  }
}

/** What a failed load says when the server refused the stream with `status`.
 * The stream endpoint's own refusals are short plain-text reasons; anything
 * else (a proxy's HTML login page, say) is described by its status alone. */
export function streamRefusalMessage(
  status: number,
  contentType: string | null,
  body: string,
): string {
  const reason = contentType?.startsWith("text/plain") ? body.trim() : "";
  if (status === 404) {
    return reason === "track not found"
      ? "Track not found in the library"
      : "File not found on disk";
  }
  if (reason !== "" && reason.length <= 120) {
    return `The server couldn't stream the track: ${reason}`;
  }
  return `The server couldn't stream the track (HTTP ${status})`;
}

/** Ten milliseconds of silent WAV, for {@link AudioEngine.unlock} to play on a
 * standby element with nothing loaded yet. Inline, so it costs no fetch. */
const SILENCE =
  "data:audio/wav;base64,UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";

/** How long the keep-alive's loop of silence is. Chrome classes media of five
 * seconds or less as a transient one-shot sound, which doesn't hold its media
 * session (or the foreground service behind it) up; this is comfortably past
 * that. See "Why a keep-alive" above. */
const KEEP_ALIVE_SECS = 10;

/** `seconds` of silent WAV — 8 kHz, 8-bit mono, so 8 KB a second — for the
 * keep-alive. Built here rather than fetched, so it costs no request. */
export function silentWav(seconds: number): Blob {
  const rate = 8000;
  const samples = rate * seconds;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      bytes[offset + i] = text.charCodeAt(i);
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true); // sample rate
  view.setUint32(28, rate, true); // byte rate
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples, true);
  bytes.fill(0x80, 44); // 8-bit PCM is unsigned: 0x80 is the zero line
  return new Blob([bytes], { type: "audio/wav" });
}

/** Whether `t` falls inside one of `ranges`. */
function inRanges(ranges: TimeRanges, t: number): boolean {
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= t && t <= ranges.end(i)) return true;
  }
  return false;
}

/** What the app drives playback through: the engine itself, or a stand-in
 * that plays nothing in the store's tests (see `AppEnv.createPlayer`). */
export type Player = Pick<
  AudioEngine,
  | "setQueue"
  | "updateQueue"
  | "play"
  | "pause"
  | "skipNext"
  | "skipPrevious"
  | "seek"
  | "stop"
  | "setMetadata"
  | "traceContext"
  | "isPlaying"
  | "loading"
  | "buffered"
  | "error"
  | "position"
  | "duration"
  | "hasNext"
  | "pastHalfway"
>;

export class AudioEngine {
  /** The two interchangeable players: one active, one holding the next track
   * pre-buffered. Roles swap on every auto-advance — see {@link handoff}. */
  private readonly elements: readonly [HTMLAudioElement, HTMLAudioElement];
  /** Which of {@link elements} is the active player. */
  private activeIndex: 0 | 1 = 0;
  /** On Android, the element looping silence so playback never stops between
   * tracks (see "Why a keep-alive" above); `undefined` elsewhere. */
  private readonly keepAlive: HTMLAudioElement | undefined;
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
  /** Why the current track failed to load, as the bar says it; `null` while
   * it hasn't. Set once {@link diagnose} has found out. */
  private failure: string | null = null;
  /** The request {@link diagnose} has out to find out why the current track
   * failed, so a move to another track can abort it. */
  private diagnosis: AbortController | undefined;
  /** A track whose prime failed (its file is missing, say), so it isn't
   * re-fetched on every `suspend` only to fail again. */
  private primeFailed: string | undefined;
  /** Where to report what happens, if anywhere. */
  private readonly tracer: EngineTrace | undefined;
  /** The last heartbeat's wall-clock time and track position, so the next can
   * say how far each moved in between. */
  private lastBeat: { wall: number; position: number } | undefined;

  constructor(
    events: EngineEvents,
    getQuality: () => AudioQualityPref,
    tracer?: EngineTrace,
  ) {
    this.events = events;
    this.getQuality = getQuality;
    this.tracer = tracer;

    // Both elements are created up front and kept in the document (hidden) for
    // the app's lifetime. iOS ties the permission earned by the first
    // user-gesture `play()` to *the element it was called on*, so an element
    // conjured later — at a track boundary, with no gesture in sight — would
    // never be allowed to start. Creating both now lets {@link unlock} claim
    // that permission for the pair while a real gesture is still on the stack.
    this.elements = [this.createElement(), this.createElement()];
    // Android only: that's where Chrome's media service and Android's
    // background-audio rules make it necessary (see "Why a keep-alive"), and
    // elsewhere a silent player is a risk for nothing — iOS, say, could pick
    // it for its lock-screen "now playing".
    if (/Android/i.test(navigator.userAgent)) {
      const keepAlive = this.createElement();
      keepAlive.loop = true;
      keepAlive.src = URL.createObjectURL(silentWav(KEEP_ALIVE_SECS));
      this.keepAlive = keepAlive;
    }

    this.media =
      "mediaSession" in navigator ? navigator.mediaSession : undefined;

    const nav = navigator as Navigator & AudioSessionNavigator;
    if (nav.audioSession) nav.audioSession.type = "playback";

    this.installHandlers();
    if (tracer) this.installDiagnostics(tracer);
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

  /** Whether the current track is meant to be sounding but is waiting on data:
   * a fresh load before its first note, a seek past what's buffered, a stall
   * mid-track — or a failure still being looked into (see {@link diagnose}). */
  get loading(): boolean {
    if (this.current === undefined) return false;
    if (this.diagnosis !== undefined) return true;
    if (this.failure !== null) return false;
    const el = this.audio;
    return (
      !el.paused &&
      !el.ended &&
      (el.readyState < HAVE_FUTURE_DATA || el.seeking)
    );
  }

  /** The stretches of the current track downloaded so far, in seconds into
   * the track. */
  get buffered(): LoadedRange[] {
    if (this.current === undefined) return [];
    const ranges = this.audio.buffered;
    const out: LoadedRange[] = [];
    for (let i = 0; i < ranges.length; i++) {
      out.push([this.offset + ranges.start(i), this.offset + ranges.end(i)]);
    }
    return out;
  }

  /** Why the current track couldn't be played, or `null`. */
  get error(): string | null {
    return this.failure;
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
  setQueue(preceding: string[], current: string, upcoming: string[]): void {
    this.trace(
      "cmd:set-queue",
      () => `${shortId(current)} upcoming=${upcoming.length}`,
    );
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
   * surrounding rows shifted, or a track was queued — without touching what's
   * actually playing. `preceding: null` keeps the history as it is. Drops a
   * standby prime that no longer matches the new `upcoming[0]` and re-primes if
   * one is now due; an `upcoming` the same as the queue already held leaves
   * the standby element alone, since a prime still downloading would
   * otherwise be thrown away only to be fetched again. */
  updateQueue(preceding: string[] | null, upcoming: string[]): void {
    if (this.current === undefined) return;
    if (preceding !== null) this.history = preceding;
    if (sameIds(this.queue, upcoming)) return;
    this.trace("update-queue", () => `next=${shortId(upcoming[0])}`);
    this.queue = upcoming;
    this.yieldStandby();
    this.primeNext();
    this.events.onTransport(); // hasNext may have changed
  }

  play(): void {
    this.trace("cmd:play");
    // A track that failed to load has nothing to resume: load it again.
    const id = this.current;
    if (id !== undefined && (this.failure !== null || this.audio.error)) {
      this.load(id);
      this.events.onTransport();
      return;
    }
    this.wantPlaying = true;
    void this.startPlaying(this.audio, "resume").catch(() => {});
    this.holdSession();
    this.setPlaybackState("playing");
  }

  pause(): void {
    this.trace("cmd:pause");
    this.wantPlaying = false;
    this.audio.pause();
    this.releaseSession();
    this.setPlaybackState("paused");
  }

  /** Skips to the next queued track; a no-op with an empty queue. */
  skipNext(): void {
    this.goNext(false);
  }

  /** Steps back to the previous track; a no-op with none before it. */
  skipPrevious(): void {
    this.goPrev();
  }

  /** Stops playback and tears down the play context and OS media session. */
  stop(): void {
    this.trace("cmd:stop");
    this.wantPlaying = false;
    for (const el of this.elements) {
      el.pause();
      el.removeAttribute("src");
      // Without this, a download in flight runs on to the end of the file.
      el.load();
    }
    this.releaseSession();
    this.clearFailure();
    this.current = undefined;
    this.primed = undefined;
    this.primeFailed = undefined;
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
    this.trace("metadata", () => `duration=${duration}`);
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

  /** Writes the circumstances to the trace — the page, the quality, the
   * browser — so a log, or a stretch of one, says what it was recorded
   * under. */
  traceContext(): void {
    const session = (navigator as Navigator & AudioSessionNavigator)
      .audioSession;
    this.trace(
      "context",
      () =>
        `vis=${document.visibilityState} quality=${this.getQuality()} audioSession=${session ? `${session.type}/${session.state ?? "?"}` : "absent"} ua=${navigator.userAgent}`,
    );
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
    this.clearFailure();
    // A prime that failed under the last track gets another chance under this
    // one: it may have been a dropped connection rather than a missing file.
    this.primeFailed = undefined;
    this.trace("load", () => `${shortId(id)} on ${this.name(this.audio)}`);
    this.activeQuality = streamQualityParam(this.getQuality());
    this.fetchStream(this.audio, trackStreamUrl(id, this.activeQuality));
    this.wantPlaying = true;
    void this.startPlaying(this.audio, "load").catch(() => {});
    this.holdSession();
    this.current = id;
    this.setPlaybackState("playing");
    // A previous `stop()` may have unwired the transport actions; this track
    // is resumable again, so wire them back.
    if (!this.mediaHandlersInstalled) this.installMediaActionHandlers();
    // The next track is primed once this one has downloaded (see `suspend`).
    this.yieldStandby();
  }

  /** Points `el` at the stream `url` and starts fetching it. */
  private fetchStream(el: HTMLAudioElement, url: string): void {
    el.src = url;
    el.load();
    this.events.onStreamRequest();
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
    this.trace("release-standby", () => this.describe(el));
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
    if (this.primeFailed === next) return;
    if (this.audio.networkState !== NETWORK_IDLE) return;
    el.pause();
    this.trace("prime", () => `${shortId(next)} on ${this.name(el)}`);
    this.primedQuality = streamQualityParam(this.getQuality());
    this.fetchStream(el, trackStreamUrl(next, this.primedQuality));
    this.primed = next;
  }

  /** Crosses a track boundary using the pre-buffered standby element: swap roles
   * and play. Deliberately synchronous and network-free — this runs from the
   * `ended` handler of a page that has, for the moment, stopped rendering audio
   * and is therefore at its most freezable. */
  private handoff(id: string): void {
    this.trace(
      "handoff",
      () => `${shortId(id)} to ${this.describe(this.standby)}`,
    );
    this.activeIndex = this.activeIndex === 0 ? 1 : 0;
    this.activeQuality = this.primedQuality;
    this.offset = 0;
    this.knownDuration = null;
    this.clearFailure();
    this.primeFailed = undefined;
    this.current = id;
    this.wantPlaying = true;
    void this.startPlaying(this.audio, "handoff").catch(() =>
      this.handoffFailed(id),
    );
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
    this.trace("handoff-failed", () => shortId(id));
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
    this.trace("unlock", () => this.describe(el));
    void this.startPlaying(el, "unlock")
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
    this.trace(
      "next",
      () => `${shortId(next)} ended=${ended} primed=${this.primed === next}`,
    );
    const completed = this.completedPlay(ended);
    const previous = this.current;
    if (this.primed === next) this.handoff(next);
    else this.load(next);
    if (previous !== undefined) this.history.push(previous);
    if (completed !== undefined) this.events.onPlayCompleted(completed);
    this.events.onTrackChange(next, "next");
    return true;
  }

  /** Steps back to the previous track, returning the current one to the front of
   * the queue. Skipping back logs the abandoned track as a play if it played
   * past its halfway mark. */
  private goPrev(): boolean {
    const prev = this.history.pop();
    if (prev === undefined) return false;
    this.trace("prev", () => shortId(prev));
    const completed = this.completedPlay(false);
    if (this.current !== undefined) this.queue.unshift(this.current);
    this.load(prev);
    if (completed !== undefined) this.events.onPlayCompleted(completed);
    this.events.onTrackChange(prev, "previous");
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

  /** Starts the keep-alive, if there is one and it isn't going already.
   * Called wherever playback starts. It only gets anywhere from a user's
   * action, or while the page is visible: once Chrome's media service has
   * lapsed, a `play()` from a hidden page is refused (see "Why a keep-alive").
   * That's why {@link releaseSession} is never called on the engine's own
   * initiative. */
  private holdSession(): void {
    const keepAlive = this.keepAlive;
    if (keepAlive?.paused) {
      void this.startPlaying(keepAlive, "keep-alive").catch(() => {});
    }
  }

  /** Stops the keep-alive: playback is meant to stop too. Only for a stop the
   * user asked for (pause, stop) or can't be helped (a failed track) — never
   * between tracks, which is the gap the keep-alive exists to cover. */
  private releaseSession(): void {
    this.keepAlive?.pause();
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
    this.trace("cmd:seek", () => seconds.toFixed(2));
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
    this.trace("restart", () => `${shortId(id)} at ${start}`);
    this.offset = start;
    this.clearFailure();
    this.fetchStream(el, trackStreamUrl(id, this.activeQuality, start));
    this.yieldStandby();
    if (this.wantPlaying) void this.startPlaying(el, "restart").catch(() => {});
    this.updatePositionState();
    this.events.onTransport();
  }

  /** Finds out why `id`'s stream from `src` failed, and reports it as the
   * track's {@link error}. A media element only says *that* a load failed, not
   * what the server answered, so this asks the server again — for a single byte
   * — and reads its refusal. A server that hands the stream over leaves the
   * element's own error code to explain it. */
  private async diagnose(
    id: string,
    src: string,
    code: number | undefined,
  ): Promise<void> {
    this.diagnosis?.abort();
    const controller = new AbortController();
    this.diagnosis = controller;
    let message: string;
    try {
      const response = await fetch(src, {
        headers: { Range: "bytes=0-0" },
        signal: controller.signal,
      });
      message = response.ok
        ? mediaErrorMessage(code)
        : streamRefusalMessage(
            response.status,
            response.headers.get("content-type"),
            await response.text(),
          );
    } catch {
      if (controller.signal.aborted) return; // moved on to another track
      message = "Couldn't reach the server";
    } finally {
      // Drops whatever a stream that was handed over still had to send.
      controller.abort();
    }
    if (this.diagnosis !== controller || this.current !== id) return;
    this.diagnosis = undefined;
    this.trace("failure", () => `${shortId(id)} ${message}`);
    this.failure = message;
    this.events.onTransport();
  }

  /** Forgets the current track's failure, and stops looking into it. */
  private clearFailure(): void {
    this.diagnosis?.abort();
    this.diagnosis = undefined;
    this.failure = null;
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

      // Registered first, so each event's line comes before anything the
      // handlers below go on to do about it.
      if (this.tracer) {
        for (const type of TRACED_EVENTS) {
          el.addEventListener(type, () =>
            this.trace(`ev:${type}`, () => this.describe(el)),
          );
        }
      }

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
      // What moves `loading` and `buffered`, for the bar's spinner and the
      // timeline's loaded stretch.
      for (const type of [
        "waiting",
        "playing",
        "canplay",
        "seeking",
        "seeked",
        "progress",
      ]) {
        el.addEventListener(type, () => {
          if (active()) transport();
        });
      }

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
      // track in the bar, paused, saying why, for the user to retry or skip
      // past — deliberately *not* auto-advancing, which would silently race
      // through an entire queue on a dropped connection, or a collection whose
      // drive is unplugged. The same failure on the *standby* element is not
      // user-visible at all: drop the prime and let the boundary fall back to a
      // fresh load, which will show the failure if it happens again.
      el.addEventListener("error", () => {
        if (!active()) {
          this.primeFailed = this.primed;
          this.primed = undefined;
          return;
        }
        const id = this.current;
        if (id === undefined) return; // teardown, not a real failure
        const src = el.getAttribute("src");
        if (!src) return;
        console.error("audio stream failed", el.error?.message ?? "");
        this.wantPlaying = false;
        this.releaseSession();
        this.setPlaybackState("paused");
        void this.diagnose(id, src, el.error?.code);
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
      this.trace("visible-retry");
      void this.startPlaying(this.audio, "visible-retry").catch(() => {});
      this.holdSession();
    });

    // The keep-alive's own transport, which nothing else reports: if Chrome
    // pauses it, that's the moment the page stands to lose its audio.
    if (this.keepAlive && this.tracer) {
      const keepAlive = this.keepAlive;
      for (const type of ["play", "playing", "pause", "error"]) {
        keepAlive.addEventListener(type, () =>
          this.trace(`ev:${type}`, () => this.describe(keepAlive)),
        );
      }
    }

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
    const traced: MediaSessionActionHandler | null =
      handler && this.tracer
        ? (details) => {
            this.trace(`session:${action}`, () =>
              details.seekTime != null ? `to ${details.seekTime}` : "",
            );
            handler(details);
          }
        : handler;
    try {
      this.media?.setActionHandler(action, traced);
    } catch {
      // An action this browser doesn't know about — nothing to degrade.
    }
  }

  // ── Diagnostics ────────────────────────────────────────────────────────────

  /** Reports `kind` to the tracer, if there is one. `detail` is a thunk so an
   * engine without one never pays for describing its state. */
  private trace(kind: string, detail?: () => string): void {
    if (this.tracer) this.tracer.add(kind, detail?.());
  }

  /** Calls `play()` on `el`, tracing how the browser answers it. */
  private startPlaying(el: HTMLAudioElement, why: string): Promise<void> {
    const playing = el.play();
    if (this.tracer) {
      playing.then(
        () => this.trace("play-ok", () => `${why} ${this.name(el)}`),
        (err: unknown) =>
          this.trace(
            "play-rejected",
            () =>
              `${why} ${this.name(el)} ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
          ),
      );
    }
    return playing;
  }

  /** `A` or `B`, starred while it's the active element; `K`, the keep-alive. */
  private name(el: HTMLAudioElement): string {
    if (el === this.keepAlive) return "K";
    return `${el === this.elements[0] ? "A" : "B"}${el === this.audio ? "*" : ""}`;
  }

  /** One element's state, in a line's worth of `key=value`s. */
  private describe(el: HTMLAudioElement): string {
    const parts = [
      this.name(el),
      `t=${el.currentTime.toFixed(2)}`,
      `rs=${el.readyState}`,
      `ns=${el.networkState}`,
      el.ended ? "ended" : el.paused ? "paused" : "playing",
    ];
    if (el.muted) parts.push("muted");
    if (el.volume !== 1) parts.push(`vol=${el.volume}`);
    if (el.error) parts.push(`err=${el.error.code}:${el.error.message}`);
    const ranges: string[] = [];
    for (let i = 0; i < el.buffered.length; i++) {
      ranges.push(
        `${el.buffered.start(i).toFixed(1)}-${el.buffered.end(i).toFixed(1)}`,
      );
    }
    parts.push(`buf=${ranges.join(",") || "none"}`);
    const decoded = (el as HTMLAudioElement & DecodedByteCount)
      .webkitAudioDecodedByteCount;
    if (decoded !== undefined) parts.push(`dec=${decoded}`);
    parts.push(`src=${shortSrc(el.getAttribute("src"))}`);
    return parts.join(" ");
  }

  /** Traces the page around the players — its visibility and lifecycle, the
   * network, the audio session where there is one — and starts the heartbeat.
   * Only an engine with a tracer does any of this. */
  private installDiagnostics(tracer: EngineTrace): void {
    const session = (navigator as Navigator & AudioSessionNavigator)
      .audioSession;
    this.traceContext();
    session?.addEventListener?.("statechange", () =>
      this.trace("audio-session", () => `state=${session.state ?? "?"}`),
    );

    for (const type of TRACED_PAGE_EVENTS) {
      document.addEventListener(type, () => {
        this.trace(
          `page:${type}`,
          () => `vis=${document.visibilityState} ${this.describe(this.audio)}`,
        );
        // Any of these can be the last moment the page runs for a while.
        tracer.flush();
      });
    }
    for (const type of ["online", "offline"]) {
      window.addEventListener(type, () => this.trace(`net:${type}`));
    }

    // The engine lives as long as the app, so the interval is never cleared.
    setInterval(() => this.heartbeat(), HIDDEN_HEARTBEAT_MS);
  }

  /** Samples both players while a track is loaded — often while the page is
   * hidden, rarely while it's on screen. Each beat says how far the wall clock
   * and the track position moved since the last: a track whose position keeps
   * pace with the clock is playing, whatever the speaker says; a long gap
   * between beats means the page wasn't running at all. */
  private heartbeat(): void {
    if (this.current === undefined) {
      this.lastBeat = undefined;
      return;
    }
    const wall = Date.now();
    const last = this.lastBeat;
    const hidden = document.visibilityState === "hidden";
    if (!hidden && last && wall - last.wall < VISIBLE_HEARTBEAT_MS) return;
    const position = this.position;
    this.lastBeat = { wall, position };
    const session = (navigator as Navigator & AudioSessionNavigator)
      .audioSession;
    this.trace("hb", () => {
      const moved = last
        ? ` dwall=${((wall - last.wall) / 1000).toFixed(1)} dpos=${(position - last.position).toFixed(1)}`
        : "";
      const os = `ms=${this.media?.playbackState ?? "-"}${session ? ` as=${session.state ?? "?"}` : ""}`;
      const keepAlive = this.keepAlive
        ? ` | K ${this.keepAlive.paused ? "paused" : "playing"} t=${this.keepAlive.currentTime.toFixed(1)}`
        : "";
      return `${shortId(this.current)} vis=${document.visibilityState}${moved} ${os} | ${this.describe(this.audio)} | ${this.describe(this.standby)}${keepAlive}`;
    });
  }
}
