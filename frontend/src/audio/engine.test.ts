import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AudioEngine,
  silentWav,
  streamRefusalMessage,
  type AudioQualityPref,
} from "./engine";

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
  loop = false;
  volume = 1;
  seeking = false;
  error: { code: number; message: string } | null = null;
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
    this.error = null;
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
    onStreamRequest: vi.fn(),
  };
  const engine = new AudioEngine(events, () => quality);
  return { engine, events };
}

/** Plays track `t1` and stages its element as the backend's transcode looks
 * to a browser: metadata loaded, an infinite duration, the first 30s buffered. */
function playTranscode(engine: AudioEngine): FakeAudio {
  engine.setQueue([], "t1", []);
  const el = created[0]!;
  el.readyState = 4;
  el.duration = Number.POSITIVE_INFINITY;
  el.bufferedRanges = [[0, 30]];
  el.dispatchEvent(new Event("loadedmetadata"));
  return el;
}

/** Stages `el` as a browser reports a stream that has played out: stopped at
 * `at` seconds into the stream, then `ended`. */
function endAt(el: FakeAudio, at: number): void {
  el.currentTime = at;
  el.paused = true;
  el.ended = true;
  el.dispatchEvent(new Event("ended"));
}

/** Stages a restarted transcode on `el` as the browser reports its metadata. */
function restreamed(el: FakeAudio): void {
  el.ended = false;
  el.readyState = 4;
  el.duration = Number.POSITIVE_INFINITY;
  el.dispatchEvent(new Event("loadedmetadata"));
}

/** Stages `el` as a browser reports a stream it couldn't load: the error, then
 * the `error` event. */
function failLoad(el: FakeAudio, code = 4): void {
  el.error = { code, message: "" };
  el.paused = true;
  el.dispatchEvent(new Event("error"));
}

/** Has `fetch` answer every request with `response`, recording the requests. */
function serve(response: () => Response) {
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    () => Promise.resolve(response()),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** Lets pending promise callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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
  // Asking the server why a stream failed: no answer, unless a test gives one.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => {})),
  );
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
    engine.setQueue([], "t1", ["t2"]);
    const [active, standby] = created;
    expect(standby!.src).not.toContain("/api/");

    active!.dispatchEvent(new Event("suspend")); // still loading: no effect
    expect(standby!.src).not.toContain("/api/");

    finishDownload(active!);
    expect(standby!.src).toBe(t2);
  });

  it("is primed at once after a handoff to a track already downloaded", () => {
    const { engine } = setup();
    engine.setQueue([], "t1", ["t2", "t3"]);
    const [first, second] = created;
    finishDownload(first!);
    second!.networkState = NETWORK_IDLE;

    first!.dispatchEvent(new Event("ended"));

    expect(second!.paused).toBe(false);
    expect(first!.src).toBe(t3);
  });

  it("waits after a handoff to a track still downloading", () => {
    const { engine } = setup();
    engine.setQueue([], "t1", ["t2", "t3"]);
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
    engine.setQueue([], "t1", ["t2"]);
    const [active, standby] = created;
    finishDownload(active!);
    expect(standby!.src).toBe(t2);

    engine.setQueue([], "t5", ["t6"]);

    expect(standby!.src).not.toContain("/api/");
    finishDownload(active!);
    expect(standby!.src).toBe("/api/tracks/t6/stream?quality=opus128");
  });
});

describe("stream requests", () => {
  it("are reported as each fetch starts: the track, then the next one primed", () => {
    const { engine, events } = setup();
    engine.setQueue([], "t1", ["t2"]);
    expect(events.onStreamRequest).toHaveBeenCalledTimes(1);
    finishDownload(created[0]!);
    expect(events.onStreamRequest).toHaveBeenCalledTimes(2);
  });

  it("are reported for a restart, too", () => {
    const { engine, events } = setup();
    playTranscode(engine);
    events.onStreamRequest.mockClear();
    engine.seek(60);
    expect(events.onStreamRequest).toHaveBeenCalledTimes(1);
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

    engine.setQueue([], "t2", []);

    expect(engine.position).toBe(0);
    expect(engine.duration).toBeNull();
  });
});

describe("a transcode with a known length", () => {
  /** Plays track `t1` as a transcode the server has given a length: metadata
   * loaded, a finite duration, the first 30 s buffered. */
  function playRangedTranscode(engine: AudioEngine): FakeAudio {
    engine.setQueue([], "t1", []);
    const el = created[0]!;
    el.readyState = 4;
    el.duration = 200;
    el.bufferedRanges = [[0, 30]];
    el.dispatchEvent(new Event("loadedmetadata"));
    return el;
  }

  it("seeks in place beyond its buffer, without restarting the stream", () => {
    const { engine, events } = setup();
    const el = playRangedTranscode(engine);
    engine.setMetadata(null, null, 200);
    events.onStreamRequest.mockClear();

    engine.seek(120.25);

    expect(el.src).toBe("/api/tracks/t1/stream?quality=opus128");
    expect(el.currentTime).toBe(120.25);
    expect(engine.position).toBe(120.25);
    expect(events.onStreamRequest).not.toHaveBeenCalled();
  });

  it("moves on when it ends short of the library's length, like a file", () => {
    const { engine, events } = setup();
    const el = playRangedTranscode(engine);
    engine.setMetadata(null, null, 376);

    endAt(el, 200);

    expect(el.src).toBe("/api/tracks/t1/stream?quality=opus128");
    expect(events.onPlayCompleted).toHaveBeenCalledWith("t1");
    expect(events.onQueueDry).toHaveBeenCalled();
  });
});

describe("a transcode that ends before the track does", () => {
  it("is restarted where it stopped, without moving on", () => {
    const { engine, events } = setup();
    engine.setQueue([], "t1", ["t2"]);
    const el = created[0]!;
    el.readyState = 4;
    el.duration = Number.POSITIVE_INFINITY;
    el.dispatchEvent(new Event("loadedmetadata"));
    engine.setMetadata(null, null, 376);
    // Played out, a stream may report what it played as its duration.
    el.duration = 127.6;

    endAt(el, 127.6);

    expect(el.src).toBe("/api/tracks/t1/stream?quality=opus128&start=127.6");
    expect(el.paused).toBe(false);
    expect(engine.position).toBe(127.6);
    expect(events.onTrackChange).not.toHaveBeenCalled();
    expect(events.onPlayCompleted).not.toHaveBeenCalled();
  });

  it("is restarted again each time it gets further", () => {
    const { engine, events } = setup();
    const el = playTranscode(engine);
    engine.setMetadata(null, null, 376);
    endAt(el, 127.6);
    restreamed(el);

    endAt(el, 60); // 187.6 s into the track

    expect(el.src).toBe("/api/tracks/t1/stream?quality=opus128&start=187.6");
    expect(events.onQueueDry).not.toHaveBeenCalled();
  });

  it("is let go when a restart gets no further", () => {
    const { engine, events } = setup();
    const el = playTranscode(engine);
    engine.setMetadata(null, null, 376);
    endAt(el, 127.6);
    restreamed(el);

    endAt(el, 0.5);

    expect(events.onPlayCompleted).toHaveBeenCalledWith("t1");
    expect(events.onQueueDry).toHaveBeenCalled();
  });

  it("is restarted after a seek, though it had got no further", () => {
    const { engine, events } = setup();
    const el = playTranscode(engine);
    engine.setMetadata(null, null, 376);
    endAt(el, 127.6);
    restreamed(el);
    engine.seek(100); // before the restart point: a new stream from 100 s
    restreamed(el);

    endAt(el, 0.5); // no further than the cut, but after a seek

    expect(el.src).toBe("/api/tracks/t1/stream?quality=opus128&start=100.5");
    expect(events.onQueueDry).not.toHaveBeenCalled();
  });

  it("moves on as usual when it ends at the track's length", () => {
    const { engine, events } = setup();
    const el = playTranscode(engine);
    engine.setMetadata(null, null, 376);

    endAt(el, 375.2);

    expect(events.onPlayCompleted).toHaveBeenCalledWith("t1");
    expect(events.onQueueDry).toHaveBeenCalled();
  });

  it("moves on when the library has no length for the track", () => {
    const { engine, events } = setup();
    const el = playTranscode(engine);

    endAt(el, 127.6);

    expect(events.onQueueDry).toHaveBeenCalled();
  });
});

describe("a file served whole", () => {
  it("moves on when it ends, even short of the library's length", () => {
    const { engine, events } = setup();
    engine.setQueue([], "t1", []);
    const el = created[0]!;
    el.readyState = 4;
    el.duration = 300;
    el.dispatchEvent(new Event("loadedmetadata"));
    engine.setMetadata(null, null, 376);

    endAt(el, 300);

    expect(events.onPlayCompleted).toHaveBeenCalledWith("t1");
    expect(events.onQueueDry).toHaveBeenCalled();
  });

  it("seeks in place, even outside its buffer", () => {
    quality = "higher";
    const { engine } = setup();
    engine.setQueue([], "t1", []);
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
    engine.setQueue([], "t1", []);
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
    engine.setQueue([], "t1", []);
    engine.stop();

    engine.setQueue([], "t2", []);

    expect(media.handlers.get("play")).toBeTypeOf("function");
    expect(media.handlers.get("nexttrack")).toBeTypeOf("function");
  });
});

describe("downloads", () => {
  it("are aborted when playback stops", () => {
    const { engine } = setup();
    engine.setQueue([], "t1", ["t2"]);
    const [active, standby] = created;
    active!.networkState = NETWORK_IDLE;
    active!.dispatchEvent(new Event("suspend")); // primes t2
    active!.networkState = NETWORK_LOADING; // say a range request is out
    expect(standby!.networkState).toBe(NETWORK_LOADING);

    engine.stop();

    // `load()` with no `src` is what aborts; removing the attribute alone
    // leaves the fetch running.
    expect(active!.networkState).toBe(0);
    expect(standby!.networkState).toBe(0);
  });

  it("are replaced when another track starts", () => {
    const { engine } = setup();
    engine.setQueue([], "t1", []);
    const active = created[0]!;
    const load = vi.spyOn(active, "load");

    engine.setQueue([], "t2", []);

    expect(load).toHaveBeenCalled();
    expect(active.src).toBe("/api/tracks/t2/stream?quality=opus128");
  });
});

describe("loading", () => {
  it("is on from the start of a track until it has data to play", () => {
    const { engine } = setup();
    engine.setQueue([], "t1", []);
    expect(engine.loading).toBe(true);
    created[0]!.readyState = 4;
    expect(engine.loading).toBe(false);
  });

  it("is off while paused, though nothing has loaded", () => {
    const { engine } = setup();
    engine.setQueue([], "t1", []);
    engine.pause();
    expect(engine.loading).toBe(false);
  });

  it("is on during a seek", () => {
    const { engine } = setup();
    engine.setQueue([], "t1", []);
    const el = created[0]!;
    el.readyState = 4;
    el.seeking = true;
    expect(engine.loading).toBe(true);
  });

  it("is reported as it changes", () => {
    const { engine, events } = setup();
    engine.setQueue([], "t1", []);
    events.onTransport.mockClear();
    created[0]!.dispatchEvent(new Event("playing"));
    created[0]!.dispatchEvent(new Event("progress"));
    expect(events.onTransport).toHaveBeenCalledTimes(2);
  });
});

describe("the downloaded ranges", () => {
  it("are the active element's, in seconds into the track", () => {
    const { engine } = setup();
    const el = playTranscode(engine);
    expect(engine.buffered).toEqual([[0, 30]]);
    engine.seek(60); // past the buffer: restarts the transcode at 60
    el.bufferedRanges = [[0, 12]];
    expect(engine.buffered).toEqual([[60, 72]]);
  });

  it("are empty with nothing loaded", () => {
    const { engine } = setup();
    expect(engine.buffered).toEqual([]);
  });
});

describe("a track that fails to load", () => {
  it("says the file is missing when the server says so", async () => {
    const fetch = serve(
      () =>
        new Response("file not found on disk", {
          status: 404,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
    );
    const { engine, events } = setup();
    engine.setQueue([], "t1", []);
    failLoad(created[0]!);

    // Still finding out why.
    expect(engine.loading).toBe(true);
    expect(engine.error).toBeNull();

    await settle();
    expect(fetch).toHaveBeenCalledWith(
      "/api/tracks/t1/stream?quality=opus128",
      expect.objectContaining({ headers: { Range: "bytes=0-0" } }),
    );
    expect(engine.error).toBe("File not found on disk");
    expect(engine.loading).toBe(false);
    expect(engine.isPlaying).toBe(false);
    expect(events.onTransport).toHaveBeenCalled();
  });

  it("falls back on the element's error when the server hands the stream over", async () => {
    serve(() => new Response("x", { status: 206 }));
    const { engine } = setup();
    engine.setQueue([], "t1", []);
    failLoad(created[0]!, 3);
    await settle();
    expect(engine.error).toBe("The file couldn't be decoded");
  });

  it("says when the server can't be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    const { engine } = setup();
    engine.setQueue([], "t1", []);
    failLoad(created[0]!, 2);
    await settle();
    expect(engine.error).toBe("Couldn't reach the server");
  });

  it("forgets the failure, and stops asking why, when another track starts", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise(() => {});
      }),
    );
    const { engine } = setup();
    engine.setQueue([], "t1", []);
    failLoad(created[0]!);
    expect(signal?.aborted).toBe(false);

    engine.setQueue([], "t2", []);

    expect(signal?.aborted).toBe(true);
    expect(engine.error).toBeNull();
  });

  it("is loaded again on play", async () => {
    serve(() => new Response("file not found on disk", { status: 404 }));
    const { engine } = setup();
    engine.setQueue([], "t1", []);
    const el = created[0]!;
    failLoad(el);
    await settle();
    const load = vi.spyOn(el, "load");

    engine.play();

    expect(load).toHaveBeenCalled();
    expect(el.src).toBe("/api/tracks/t1/stream?quality=opus128");
    expect(engine.error).toBeNull();
    expect(engine.isPlaying).toBe(true);
  });

  it("isn't primed again and again while the current track plays", () => {
    const { engine, events } = setup();
    engine.setQueue([], "t1", ["t2"]);
    const [active, standby] = created;
    finishDownload(active!);
    expect(standby!.src).toContain("/t2/");
    failLoad(standby!);
    events.onStreamRequest.mockClear();

    finishDownload(active!);

    expect(events.onStreamRequest).not.toHaveBeenCalled();
  });
});

describe("a refused stream's message", () => {
  it("tells a missing track from a missing file", () => {
    expect(streamRefusalMessage(404, "text/plain", "track not found")).toBe(
      "Track not found in the library",
    );
    expect(
      streamRefusalMessage(404, "text/plain", "file not found on disk"),
    ).toBe("File not found on disk");
  });

  it("passes on the server's short reasons, but not a page of HTML", () => {
    expect(streamRefusalMessage(500, "text/plain", "unsupported codec")).toBe(
      "The server couldn't stream the track: unsupported codec",
    );
    expect(streamRefusalMessage(403, "text/html", "<html>…</html>")).toBe(
      "The server couldn't stream the track (HTTP 403)",
    );
  });
});

describe("updating the queue in place", () => {
  it("replaces preceding/upcoming without restarting the current track", () => {
    const { engine, events } = setup();
    engine.setQueue([], "t1", ["t2"]);
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
    engine.setQueue([], "t1", ["t2"]);

    engine.updateQueue([], ["t5"]);
    engine.skipNext();

    expect(events.onTrackChange).toHaveBeenCalledWith("t5", "next");
  });

  it("says which way a skip went", () => {
    const { engine, events } = setup();
    engine.setQueue(["t0"], "t1", ["t2"]);

    engine.skipPrevious();
    expect(events.onTrackChange).toHaveBeenLastCalledWith("t0", "previous");
    engine.skipNext();
    expect(events.onTrackChange).toHaveBeenLastCalledWith("t1", "next");
  });

  it("keeps the history when handed none", () => {
    const { engine, events } = setup();
    engine.setQueue(["t0"], "t1", ["t2"]);

    engine.updateQueue(null, ["t5"]);
    engine.skipPrevious();

    expect(events.onTrackChange).toHaveBeenCalledWith("t0", "previous");
  });

  it("leaves a prime under way alone when the queue hasn't changed", () => {
    const { engine, events } = setup();
    engine.setQueue([], "t1", ["t2"]);
    finishDownload(created[0]!);
    expect(created[1]!.src).toContain("t2");
    events.onStreamRequest.mockClear();

    engine.updateQueue([], ["t2"]);

    expect(created[1]!.src).toContain("t2");
    expect(events.onStreamRequest).not.toHaveBeenCalled();
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
    engine.setQueue([], "t1", []);
    const el = created[0]!;
    el.readyState = 4;
    el.duration = 12; // what has arrived so far

    expect(engine.duration).toBeNull();
    expect(engine.pastHalfway).toBe(false);
  });

  it("comes from the element once its download has finished", () => {
    quality = "higher";
    const { engine, events } = setup();
    engine.setQueue([], "t1", []);
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
    engine.setQueue([], "t1", []);
    const el = created[0]!;
    el.readyState = 4;
    el.duration = 12;

    engine.setMetadata(null, null, 180);

    expect(engine.duration).toBe(180);
  });

  it("prefers the library over the element", () => {
    quality = "higher";
    const { engine } = setup();
    engine.setQueue([], "t1", []);
    const el = created[0]!;
    el.readyState = 4;
    el.duration = 180.4;
    finishDownload(el);

    engine.setMetadata(null, null, 180);

    expect(engine.duration).toBe(180);
  });
});

describe("a logging engine", () => {
  /** An engine logging into `lines` — each entry's message, then its details
   * indented — while `enabled` says logging is on. */
  function loggingEngine(enabled: { on: boolean }) {
    vi.useFakeTimers();
    vi.stubGlobal("window", { addEventListener: () => {} });
    vi.stubGlobal("navigator", { userAgent: "test" });
    vi.stubGlobal("document", {
      body: { appendChild: () => {} },
      addEventListener: () => {},
      visibilityState: "hidden",
    });
    // The Resource Timing observer the engine installs, so a test can hand it
    // an entry as the browser would once a player's request finishes.
    let observe: ((entries: unknown[]) => void) | undefined;
    vi.stubGlobal(
      "PerformanceObserver",
      class {
        constructor(callback: (list: { getEntries: () => unknown[] }) => void) {
          observe = (entries) => callback({ getEntries: () => entries });
        }
        observe(): void {}
      },
    );
    const finishRequest = (entry: Record<string, unknown>) =>
      observe?.([entry]);
    const lines: string[] = [];
    const engine = new AudioEngine(
      {
        onTrackChange: () => {},
        onPlayCompleted: () => {},
        onQueueDry: () => {},
        onTransport: () => {},
        onStreamRequest: () => {},
      },
      () => "higher",
      {
        get enabled() {
          return enabled.on;
        },
        add: (source, message, details) => {
          expect(source).toBe("playback");
          lines.push(message, ...(details ?? []).map((d) => `  ${d}`));
        },
      },
    );
    return { engine, lines, finishRequest };
  }

  /** The entries' messages alone, without their details. */
  const messages = (lines: string[]) =>
    lines.filter((l) => !l.startsWith("  "));

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records a track boundary in words: the handoff and the events around it", () => {
    const { engine, lines } = loggingEngine({ on: true });
    engine.setQueue([], "t1", ["t2"]);
    const [first] = created;
    finishDownload(first!);
    first!.dispatchEvent(new Event("ended"));
    vi.advanceTimersByTime(3000);

    const messages = lines.filter((l) => !l.startsWith("  "));
    expect(messages.slice(0, 3)).toEqual([
      "Playback settings",
      "Asked to play track t1, with 1 track after it",
      "Loading track t1 on player A (current)",
    ]);
    expect(messages).toContain(
      "Preloading the next track, track t2, on player B (standby)",
    );
    const ended = messages.indexOf(
      "Player A (current) reached the end of its track",
    );
    const handoff = messages.indexOf(
      "Switching to player B (standby), which has track t2 preloaded",
    );
    expect(ended).toBeGreaterThan(-1);
    expect(ended).toBeLessThan(handoff);

    const status = lines.lastIndexOf("Status: track t2 at 0:00.0");
    expect(status).toBeGreaterThan(-1);
    expect(lines[status + 1]).toBe(
      "  Page hidden \u00b7 lock-screen controls show nothing (no media session)",
    );
    expect(lines[status + 2]).toMatch(
      /^ {2}Player B \(current\): playing at 0:00\.0 .* track t2 \(original file\)$/,
    );
    expect(lines[status + 3]).toMatch(/^ {2}Player A \(standby\): /);
  });

  it("logs nothing while logging is off, and starts when it's turned on", () => {
    const enabled = { on: false };
    const { engine, lines } = loggingEngine(enabled);
    engine.setQueue([], "t1", []);
    vi.advanceTimersByTime(3000);
    expect(lines).toEqual([]);

    enabled.on = true;
    vi.advanceTimersByTime(3000);
    expect(lines[0]).toBe("Status: track t1 at 0:00.0");
  });

  it("says when a player has been downloading with nothing arriving, once per stall, and when data comes back", () => {
    const { engine, lines } = loggingEngine({ on: true });
    engine.setQueue([], "t1", []);
    const el = created[0]!;
    expect(el.networkState).toBe(NETWORK_LOADING);

    vi.advanceTimersByTime(9000);
    expect(messages(lines)).not.toContainEqual(
      expect.stringContaining("without receiving any data"),
    );

    vi.advanceTimersByTime(3000);
    expect(messages(lines)).toContain(
      "Player A (current) has been downloading for 12 s without receiving any data",
    );
    // The status line says how long it's been, too.
    expect(lines.at(-2)).toMatch(/last data 12 s ago/);

    // Still stalled: no second entry.
    vi.advanceTimersByTime(6000);
    expect(
      messages(lines).filter((m) => m.includes("without receiving any data")),
    ).toHaveLength(1);

    el.dispatchEvent(new Event("progress"));
    expect(messages(lines).at(-1)).toBe(
      "Player A (current) is receiving data again, after 18 s without any",
    );
  });

  it("isn't fooled by a player that isn't downloading", () => {
    const { engine, lines } = loggingEngine({ on: true });
    engine.setQueue([], "t1", []);
    finishDownload(created[0]!);
    vi.advanceTimersByTime(30000);
    expect(messages(lines)).not.toContainEqual(
      expect.stringContaining("without receiving any data"),
    );
    expect(lines.join("\n")).not.toContain("last data");
  });

  it("records each player's length, and when it changes", () => {
    const { engine, lines } = loggingEngine({ on: true });
    engine.setQueue([], "t1", []);
    const el = created[0]!;
    vi.advanceTimersByTime(3000);
    expect(lines.at(-2)).toMatch(/Player A \(current\): .* · no length yet · /);

    el.duration = Number.POSITIVE_INFINITY;
    el.dispatchEvent(new Event("durationchange"));
    expect(messages(lines).at(-1)).toBe(
      "Player A (current) now has no length (live stream)",
    );

    el.duration = 376;
    el.dispatchEvent(new Event("durationchange"));
    expect(messages(lines).at(-1)).toBe(
      "Player A (current) now has length 6:16",
    );
    vi.advanceTimersByTime(3000);
    expect(lines.at(-2)).toMatch(/Player A \(current\): .* · length 6:16 · /);
  });

  it("puts the position against the library's length in the status", () => {
    const { engine, lines } = loggingEngine({ on: true });
    engine.setQueue([], "t1", []);
    engine.setMetadata("Title", null, 376);
    created[0]!.currentTime = 127.6;
    vi.advanceTimersByTime(3000);
    expect(messages(lines).at(-1)).toBe("Status: track t1 at 2:07.6 of 6:16");
  });

  it("warns when a track ends well before the library's length, whatever the stream", () => {
    const { engine, lines } = loggingEngine({ on: true });
    engine.setQueue([], "t1", []);
    const el = created[0]!;
    el.readyState = 4;
    el.duration = 300; // a file served whole
    el.dispatchEvent(new Event("loadedmetadata"));
    engine.setMetadata(null, null, 376);

    endAt(el, 127.6);

    const list = messages(lines);
    const ended = list.indexOf(
      "Player A (current) reached the end of its track",
    );
    expect(list[ended + 1]).toBe(
      "Player A (current) stopped 4:08 before the end of track t1 (6:16)",
    );
  });

  it("doesn't warn about a track that ends at its length", () => {
    const { engine, lines } = loggingEngine({ on: true });
    engine.setQueue([], "t1", []);
    engine.setMetadata(null, null, 376);
    endAt(created[0]!, 375.2);
    expect(messages(lines)).not.toContainEqual(
      expect.stringContaining("before the end of"),
    );
  });

  it("records each stream request the players make, from Resource Timing", () => {
    const { engine, lines, finishRequest } = loggingEngine({ on: true });
    engine.setQueue([], "t1", []);

    finishRequest({
      name: "https://music.example/api/tracks/5f62a92b-1a9a/stream?quality=opus128",
      responseStatus: 206,
      encodedBodySize: 2.0 * 1024 * 1024,
      startTime: 1000,
      responseEnd: 372_000,
    });
    finishRequest({
      name: "https://music.example/api/query",
      responseStatus: 200,
      encodedBodySize: 10,
      startTime: 0,
      responseEnd: 5,
    });

    expect(messages(lines).at(-1)).toBe(
      "A download for track 5f62a92b (Opus 128 kbps transcode) finished: response 206, 2.0 MB in 6 min 11 s",
    );
  });
});

describe("on Android", () => {
  /** An engine whose navigator says Android, playing t1 with t2 primed and
   * fully fetched; `keepAlive` is the third element it creates. */
  function androidEngine() {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Linux; Android 10; K) Chrome/155.0.0.0",
    });
    const { engine } = setup();
    engine.setQueue([], "t1", ["t2"]);
    const [first, second, keepAlive] = created;
    finishDownload(first!);
    second!.networkState = NETWORK_IDLE;
    return { engine, first: first!, second: second!, keepAlive: keepAlive! };
  }

  it("loops silence alongside the track", () => {
    const { keepAlive } = androidEngine();
    expect(created).toHaveLength(3);
    expect(keepAlive.loop).toBe(true);
    expect(keepAlive.src).toMatch(/^blob:/);
    expect(keepAlive.paused).toBe(false);
  });

  it("keeps it playing across a track boundary", () => {
    const { first, second, keepAlive } = androidEngine();
    let gap = false;
    first.addEventListener("ended", () => {
      gap ||= keepAlive.paused;
    });
    first.dispatchEvent(new Event("ended"));
    expect(second.paused).toBe(false);
    expect(gap).toBe(false);
    expect(keepAlive.paused).toBe(false);
  });

  it("stops it when the user pauses, and starts it again on play", () => {
    const { engine, keepAlive } = androidEngine();
    engine.pause();
    expect(keepAlive.paused).toBe(true);
    engine.play();
    expect(keepAlive.paused).toBe(false);
  });

  it("stops it when playback stops", () => {
    const { engine, keepAlive } = androidEngine();
    engine.stop();
    expect(keepAlive.paused).toBe(true);
  });

  it("stops it when the track fails to load", () => {
    const { first, keepAlive } = androidEngine();
    first.dispatchEvent(new Event("error"));
    expect(keepAlive.paused).toBe(true);
  });
});

describe("elsewhere", () => {
  it("there's no keep-alive", () => {
    const { engine } = setup();
    engine.setQueue([], "t1", []);
    expect(created).toHaveLength(2);
  });
});

describe("the keep-alive's silence", () => {
  it("is a WAV of the length asked for, all on the zero line", async () => {
    const wav = silentWav(10);
    expect(wav.type).toBe("audio/wav");
    const bytes = new Uint8Array(await wav.arrayBuffer());
    expect(bytes.length).toBe(44 + 80_000);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe("WAVE");
    expect(new DataView(bytes.buffer).getUint32(24, true)).toBe(8000);
    expect(bytes.slice(44).every((b) => b === 0x80)).toBe(true);
  });
});
