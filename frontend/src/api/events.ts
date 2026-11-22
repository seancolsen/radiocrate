// The change stream: `GET /api/events`, the server's word that some kind of
// live data (a topic) has changed on another device. See
// `specs/2026-11-live-updates/spec.md` and `backend/src/changes.rs`.
//
// It's read with `fetch` and a `ReadableStream`, not `EventSource`. That way a
// response that isn't the stream (a sign-in redirect from the proxy in front
// of the server, a refusal) shows up as what it is, and a redirect goes
// through the same sign-in handling every RPC call gets. `EventSource` hides
// the status and retries forever.
//
// Framework-free: this module knows nothing of React or the stores. The
// stores reach it through `AppEnv.openChangeStream`, so their tests drive a
// fake instead.

import {
  AuthRedirectError,
  handleAuthRedirect,
  httpError,
  type EventsHello,
  type TopicChanged,
} from "api-client";

/** Where the stream is served. */
export const EVENTS_URL = "/api/events";

/** What the stream says, as it says it. */
export interface ChangeStreamHandlers {
  /** The first message on every connection: the server's epoch and each
   * topic's version. */
  onHello: (hello: EventsHello) => void;
  /** A topic changed. */
  onChanged: (change: TopicChanged) => void;
  /** The stream couldn't be opened, or dropped: the network, or a server that
   * refused it. It tries again by itself, after a backoff, for as long as it's
   * open. For the log; nothing needs doing. */
  onDown?: (reason: string) => void;
}

/** One change stream, which can be opened and closed any number of times. */
export interface ChangeStream {
  /** Connects, if it isn't already, and keeps reconnecting until closed. */
  open: () => void;
  /** Disconnects, and stops reconnecting. */
  close: () => void;
}

/** Builds a {@link ChangeStream} reporting to `handlers`. */
export type OpenChangeStream = (handlers: ChangeStreamHandlers) => ChangeStream;

/** One Server-Sent Events message: its `event:` name (`"message"` when it has
 * none) and its `data:` lines, joined. */
export interface SseMessage {
  event: string;
  data: string;
}

/** Splits a Server-Sent Events byte stream, decoded to text and handed over in
 * whatever pieces it arrives in, into messages. Comments (the server's
 * keep-alives) and fields other than `event` and `data` are dropped. */
export class SseParser {
  private buffer = "";
  private event = "";
  private data: string[] = [];

  /** Takes the next piece of the stream, and returns every message it
   * completes. */
  push(text: string): SseMessage[] {
    this.buffer += text;
    const out: SseMessage[] = [];
    for (;;) {
      const end = this.buffer.search(/\r\n|\r|\n/);
      if (end === -1) break;
      const line = this.buffer.slice(0, end);
      const newline = this.buffer.startsWith("\r\n", end) ? 2 : 1;
      // A lone `\r` at the very end may be the first half of a `\r\n`.
      if (
        newline === 1 &&
        this.buffer[end] === "\r" &&
        end === this.buffer.length - 1
      ) {
        break;
      }
      this.buffer = this.buffer.slice(end + newline);
      if (line === "") {
        if (this.data.length > 0 || this.event !== "") {
          out.push({
            event: this.event || "message",
            data: this.data.join("\n"),
          });
        }
        this.event = "";
        this.data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") this.event = value;
      else if (field === "data") this.data.push(value);
    }
    return out;
  }
}

/** How long to wait before the first reconnect, and the most it backs off to. */
const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

/** The real stream, over `fetch`. */
export function openChangeStream(
  handlers: ChangeStreamHandlers,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): ChangeStream {
  let wanted = false;
  let controller: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;

  const connect = () => {
    const current = new AbortController();
    controller = current;
    void read(current.signal).then((reason) => {
      if (controller !== current) return;
      controller = undefined;
      if (reason === null || !wanted) return;
      handlers.onDown?.(reason);
      const delay = Math.min(MAX_RETRY_MS, MIN_RETRY_MS * 2 ** failures);
      failures++;
      // Some jitter, so several tabs coming back at once don't arrive as one.
      retry = setTimeout(
        () => {
          retry = undefined;
          if (wanted && controller === undefined) connect();
        },
        delay * (0.75 + Math.random() / 2),
      );
    });
  };

  /** Reads one connection to its end. Resolves with why it ended, or `null`
   * when it shouldn't be retried (closed, or sent off to sign in). */
  const read = async (signal: AbortSignal): Promise<string | null> => {
    try {
      const res = await fetchImpl(EVENTS_URL, {
        headers: { accept: "text/event-stream" },
        cache: "no-store",
        redirect: "manual",
        signal,
      });
      handleAuthRedirect(res, EVENTS_URL);
      if (!res.ok) return (await httpError(res)).message;
      if (!res.body) return "The server sent no stream";
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      const parser = new SseParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return "The server closed the stream";
        for (const message of parser.push(value)) {
          if (message.event === "hello") {
            failures = 0;
            handlers.onHello(JSON.parse(message.data) as EventsHello);
          } else if (message.event === "changed") {
            handlers.onChanged(JSON.parse(message.data) as TopicChanged);
          }
        }
      }
    } catch (err) {
      if (signal.aborted) return null;
      if (err instanceof AuthRedirectError) {
        wanted = false;
        return null;
      }
      return err instanceof Error ? err.message : String(err);
    }
  };

  return {
    open: () => {
      if (wanted) return;
      wanted = true;
      failures = 0;
      connect();
    },
    close: () => {
      wanted = false;
      clearTimeout(retry);
      retry = undefined;
      controller?.abort();
      controller = undefined;
    },
  };
}
