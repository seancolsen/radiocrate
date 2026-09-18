import { beforeEach, describe, expect, it, vi } from "vitest";
import { AudioEngine, type AudioQualityPref } from "./engine";

/** Just enough of an `<audio>` element for the engine. Its transport state is
 * plain fields, which a test sets to stage what the browser would report. */
class FakeAudio extends EventTarget {
  src = "";
  currentTime = 0;
  duration = Number.NaN;
  readyState = 0;
  paused = true;
  ended = false;
  muted = false;
  networkState = 0;
  preload = "";
  style = {};
  bufferedRanges: [number, number][] = [];

  constructor() {
    super();
    created.push(this);
  }

  get buffered(): TimeRanges {
    const ranges = this.bufferedRanges;
    return {
      length: ranges.length,
      start: (i: number) => ranges[i]![0],
      end: (i: number) => ranges[i]![1],
    };
  }

  load(): void {
    this.currentTime = 0;
    this.duration = Number.NaN;
    this.readyState = 0;
    this.bufferedRanges = [];
    this.networkState = this.src ? NETWORK_LOADING : 0;
  }

  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
  }

  getAttribute(name: string): string | null {
    return name === "src" && this.src ? this.src : null;
  }

  removeAttribute(name: string): void {
    if (name === "src") this.src = "";
  }
}

const NETWORK_IDLE = 1;
const NETWORK_LOADING = 2;

/** Just enough of `navigator.mediaSession` to see which transport actions the
 * engine has wired up: `handlers.get(action)` is the last handler passed to
 * `setActionHandler`, `null` once it's been torn down. */
function fakeMediaSession() {
  const handlers = new Map<string, unknown>();
  return {
    metadata: null as unknown,
    playbackState: "none" as MediaSessionPlaybackState,
    setActionHandler: (action: string, handler: unknown) => {
      handlers.set(action, handler);
    },
    handlers,
  };
}

let created: FakeAudio[] = [];
let quality: AudioQualityPref = "lower";

function setup() {
  const events = {
    onTrackChange: vi.fn(),
    onPlayCompleted: vi.fn(),
    onQueueDry: vi.fn(),
    onTransport: vi.fn(),
  };
  const engine = new AudioEngine(events, () => quality);
  return { engine, events };
}

/** Plays track `t1` and stages its element as the backend's transcode looks
 * to a browser: metadata loaded, an infinite duration, the first 30s buffered. */
function playTranscode(engine: AudioEngine): FakeAudio {
  engine.setPlaylist([], "t1", []);
  const el = created[0]!;
  el.readyState = 4;
  el.duration = Number.POSITIVE_INFINITY;
  el.bufferedRanges = [[0, 30]];
  return el;
}

/** Stages `el` as a browser reports a finished download: network idle, then
 * `suspend`. */
function finishDownload(el: FakeAudio): void {
  el.networkState = NETWORK_IDLE;
  el.dispatchEvent(new Event("suspend"));
}

beforeEach(() => {
  created = [];
  quality = "lower";
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("document", {
    body: { appendChild: () => {} },
    addEventListener: () => {},
  });
});

describe("the next track", () => {
  const t2 = "/api/tracks/t2/stream?quality=opus128";
  const t3 = "/api/tracks/t3/stream?quality=opus128";

  it("isn't fetched until the current track has downloaded", () => {
    const { engine } = setup();
    engine.setPlaylist([], "t1", ["t2"]);
    const [active, standby] = created;
    expect(standby!.src).not.toContain("/api/");

    active!.dispatchEvent(new Event("suspend")); // still loading: no effect
    expect(standby!.src).not.toContain("/api/");

    finishDownload(active!);
    expect(standby!.src).toBe(t2);
  });

  it("is primed at once after a handoff to a track already downloaded", () => {
    const { engine } = setup();
    engine.setPlaylist([], "t1", ["t2", "t3"]);
    const [first, second] = created;
    finishDownload(first!);
    second!.networkState = NETWORK_IDLE;

    first!.dispatchEvent(new Event("ended"));

    expect(second!.paused).toBe(false);
    expect(first!.src).toBe(t3);
  });

  it("waits after a handoff to a track still downloading", () => {
    const { engine } = setup();
    engine.setPlaylist([], "t1", ["t2", "t3"]);
    const [first, second] = created;
    finishDownload(first!);

    engine.skipNext();

    expect(second!.paused).toBe(false);
    expect(first!.src).toBe("");
    expect(first!.networkState).toBe(0); // the skipped track's fetch is aborted

    finishDownload(second!);
    expect(first!.src).toBe(t3);
  });

  it("is dropped mid-download when another track starts", () => {
    const { engine } = setup();
    engine.setPlaylist([], "t1", ["t2"]);
    const [active, standby] = created;
    finishDownload(active!);
    expect(standby!.src).toBe(t2);

    engine.setPlaylist([], "t5", ["t6"]);

    expect(standby!.src).not.toContain("/api/");
    finishDownload(active!);
    expect(standby!.src).toBe("/api/tracks/t6/stream?quality=opus128");
  });
});

describe("a transcoded stream", () => {
  it("takes its duration from the library", () => {
    const { engine } = setup();
    const el = playTranscode(engine);
    expect(engine.duration).toBeNull();

    engine.setMetadata("Title", "Artist", 200);
    expect(engine.duration).toBe(200);

    el.currentTime = 99;
    expect(engine.pastHalfway).toBe(false);
    el.currentTime = 101;
    expect(engine.pastHalfway).toBe(true);
  });

  it("seeks in place within what it has buffered", () => {
    const { engine } = setup();
    const el = playTranscode(engine);
    engine.setMetadata(null, null, 200);
    const src = el.src;

    engine.seek(20);

    expect(el.src).toBe(src);
    expect(el.currentTime).toBe(20);
  });

  it("restarts from the target when seeking past its buffer", () => {
    const { engine } = setup();
    const el = playTranscode(engine);
    engine.setMetadata(null, null, 200);

    engine.seek(120.25);

    expect(el.src).toBe("/api/tracks/t1/stream?quality=opus128&start=120.25");
    expect(engine.position).toBe(120.25);
    el.currentTime = 5;
    expect(engine.position).toBe(125.25);
    expect(engine.duration).toBe(200);
    expect(el.paused).toBe(false);
  });

  it("restarts again when seeking back before the restart point", () => {
    const { engine } = setup();
    const el = playTranscode(engine);
    engine.setMetadata(null, null, 200);
    engine.seek(120);
    el.readyState = 4;
    el.duration = Number.POSITIVE_INFINITY;
    el.bufferedRanges = [[0, 10]];

    engine.seek(125);
    expect(el.currentTime).toBe(5);

    engine.seek(60);
    expect(el.src).toBe("/api/tracks/t1/stream?quality=opus128&start=60");
    expect(engine.position).toBe(60);
  });

  it("restarts at the quality it was loaded with", () => {
    const { engine } = setup();
    const el = playTranscode(engine);
    engine.setMetadata(null, null, 200);
    quality = "higher";

    engine.seek(120);

    expect(el.src).toBe("/api/tracks/t1/stream?quality=opus128&start=120");
  });

  it("stays paused across a restart", () => {
    const { engine } = setup();
    const el = playTranscode(engine);
    engine.setMetadata(null, null, 200);
    engine.pause();

    engine.seek(120);

    expect(el.paused).toBe(true);
  });

  it("finishes the track on a seek to its end", () => {
    const { engine, events } = setup();
    playTranscode(engine);
    engine.setMetadata(null, null, 200);

    engine.seek(500);

    expect(events.onPlayCompleted).toHaveBeenCalledWith("t1");
    expect(events.onQueueDry).toHaveBeenCalled();
  });

  it("drops its offset and duration when the next track loads", () => {
    const { engine } = setup();
    playTranscode(engine);
    engine.setMetadata(null, null, 200);
    engine.seek(120);

    engine.setPlaylist([], "t2", []);

    expect(engine.position).toBe(0);
    expect(engine.duration).toBeNull();
  });
});

describe("a file served whole", () => {
  it("seeks in place, even outside its buffer", () => {
    quality = "higher";
    const { engine } = setup();
    engine.setPlaylist([], "t1", []);
    const el = created[0]!;
    el.readyState = 4;
    el.duration = 180;
    el.bufferedRanges = [[0, 10]];

    engine.seek(120);

    expect(el.src).toBe("/api/tracks/t1/stream");
    expect(el.currentTime).toBe(120);
  });
});

describe("closing the current track", () => {
  it("unwires the Media Session transport actions, so a hardware control can't resume it", () => {
    const media = fakeMediaSession();
    vi.stubGlobal("navigator", { mediaSession: media });
    const { engine } = setup();
    engine.setPlaylist([], "t1", []);
    expect(media.handlers.get("play")).toBeTypeOf("function");

    engine.stop();

    for (const action of [
      "play",
      "pause",
      "nexttrack",
      "previoustrack",
      "seekbackward",
      "seekforward",
      "seekto",
    ]) {
      expect(media.handlers.get(action)).toBeNull();
    }
  });

  it("wires the actions back when another track starts", () => {
    const media = fakeMediaSession();
    vi.stubGlobal("navigator", { mediaSession: media });
    const { engine } = setup();
    engine.setPlaylist([], "t1", []);
    engine.stop();

    engine.setPlaylist([], "t2", []);

    expect(media.handlers.get("play")).toBeTypeOf("function");
    expect(media.handlers.get("nexttrack")).toBeTypeOf("function");
  });
});

describe("updating the queue in place", () => {
  it("replaces preceding/upcoming without restarting the current track", () => {
    const { engine, events } = setup();
    engine.setPlaylist([], "t1", ["t2"]);
    const el = created[0]!;
    const src = el.src;
    events.onTransport.mockClear();

    engine.updateQueue(["t0"], ["t5"]);

    expect(el.src).toBe(src);
    expect(engine.hasNext).toBe(true);
    expect(events.onTransport).toHaveBeenCalled();
  });

  it("advances into the replaced queue, not the old one", () => {
    const { engine, events } = setup();
    engine.setPlaylist([], "t1", ["t2"]);

    engine.updateQueue([], ["t5"]);
    engine.skipNext();

    expect(events.onTrackChange).toHaveBeenCalledWith("t5");
  });

  it("is a no-op with nothing loaded", () => {
    const { engine, events } = setup();

    engine.updateQueue([], ["t5"]);

    expect(engine.hasNext).toBe(false);
    expect(events.onTransport).not.toHaveBeenCalled();
  });
});

describe("the duration", () => {
  it("is unknown while the stream is still downloading", () => {
    quality = "higher";
    const { engine } = setup();
    engine.setPlaylist([], "t1", []);
    const el = created[0]!;
    el.readyState = 4;
    el.duration = 12; // what has arrived so far

    expect(engine.duration).toBeNull();
    expect(engine.pastHalfway).toBe(false);
  });

  it("comes from the element once its download has finished", () => {
    quality = "higher";
    const { engine, events } = setup();
    engine.setPlaylist([], "t1", []);
    const el = created[0]!;
    el.readyState = 4;
    el.duration = 180;
    events.onTransport.mockClear();

    finishDownload(el);

    expect(engine.duration).toBe(180);
    expect(events.onTransport).toHaveBeenCalled();
  });

  it("comes from the library before the download has finished", () => {
    quality = "higher";
    const { engine } = setup();
    engine.setPlaylist([], "t1", []);
    const el = created[0]!;
    el.readyState = 4;
    el.duration = 12;

    engine.setMetadata(null, null, 180);

    expect(engine.duration).toBe(180);
  });

  it("prefers the library over the element", () => {
    quality = "higher";
    const { engine } = setup();
    engine.setPlaylist([], "t1", []);
    const el = created[0]!;
    el.readyState = 4;
    el.duration = 180.4;
    finishDownload(el);

    engine.setMetadata(null, null, 180);

    expect(engine.duration).toBe(180);
  });
});
