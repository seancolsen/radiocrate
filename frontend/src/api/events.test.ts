import { afterEach, describe, expect, it, vi } from "vitest";
import { openChangeStream, SseParser } from "./events";

describe("SseParser", () => {
  it("splits messages however the stream is cut", () => {
    const parser = new SseParser();
    const text =
      'event: hello\ndata: {"epoch":"e"}\n\n:\n\nevent: changed\r\ndata: a\r\ndata: b\r\n\r\n';
    const messages = [...text].flatMap((char) => parser.push(char));
    expect(messages).toEqual([
      { event: "hello", data: '{"epoch":"e"}' },
      { event: "changed", data: "a\nb" },
    ]);
  });

  it("drops keep-alive comments and unknown fields", () => {
    const parser = new SseParser();
    expect(parser.push(":\n\nid: 3\nretry: 10\n\ndata:x\n\n")).toEqual([
      { event: "message", data: "x" },
    ]);
  });
});

/** A `fetch` answering `/api/events` with a stream the test writes to. */
function streamingFetch() {
  const connections: {
    push: (text: string) => void;
    end: () => void;
    signal: AbortSignal;
  }[] = [];
  const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
      },
    });
    const signal = init!.signal!;
    signal.addEventListener("abort", () => {
      try {
        controller.error(new DOMException("aborted", "AbortError"));
      } catch {
        // Already closed.
      }
    });
    connections.push({
      push: (text) => controller.enqueue(new TextEncoder().encode(text)),
      end: () => controller.close(),
      signal,
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  });
  return { fetchImpl, connections };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("openChangeStream", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reports the hello and each change", async () => {
    const { fetchImpl, connections } = streamingFetch();
    const onHello = vi.fn();
    const onChanged = vi.fn();
    const stream = openChangeStream({ onHello, onChanged }, fetchImpl);
    stream.open();
    stream.open();
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    connections[0].push(
      'event: hello\ndata: {"epoch":"e","versions":{"sources":1}}\n\n',
    );
    connections[0].push(
      'event: changed\ndata: {"topic":"sources","version":2,"origin":null}\n\n',
    );
    await flush();
    expect(onHello).toHaveBeenCalledWith({
      epoch: "e",
      versions: { sources: 1 },
    });
    expect(onChanged).toHaveBeenCalledWith({
      topic: "sources",
      version: 2,
      origin: null,
    });
    stream.close();
    expect(connections[0].signal.aborted).toBe(true);
  });

  it("reconnects after the stream ends, until closed", async () => {
    vi.useFakeTimers();
    const { fetchImpl, connections } = streamingFetch();
    const onDown = vi.fn();
    const stream = openChangeStream(
      { onHello: () => {}, onChanged: () => {}, onDown },
      fetchImpl,
    );
    stream.open();
    await vi.advanceTimersByTimeAsync(0);
    connections[0].end();
    await vi.advanceTimersByTimeAsync(0);
    expect(onDown).toHaveBeenCalledWith("The server closed the stream");
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    stream.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("backs off from a server that refuses it", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response("nope", { status: 502 })),
    );
    const onDown = vi.fn();
    const stream = openChangeStream(
      { onHello: () => {}, onChanged: () => {}, onDown },
      fetchImpl,
    );
    stream.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(onDown).toHaveBeenLastCalledWith("502 nope");
    // 1 s, then 2 s, then 4 s (give or take a quarter, which this test pins
    // to nothing).
    await vi.advanceTimersByTimeAsync(1001);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1500);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    stream.close();
  });
});
