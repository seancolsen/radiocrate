import type { EventsHello, Topic, TopicChanged } from "api-client";
import type { ChangeStream, OpenChangeStream } from "../api/events";

// Live updates: following the server's change stream, so a change made on one
// device shows on every other device in the foreground without a Refresh.
// See `specs/2026-11-live-updates/spec.md`.
//
// This module is the bookkeeping between the stream and the stores: which
// server run and which version of each topic this device has seen, when to
// refetch, and when to hold a refetch back. What a refetch *does* (refetch a
// list, merge it in) is the stores' business, handed in as `refetch`.

/** Every live topic. */
export const LIVE_TOPICS: readonly Topic[] = [
  "sources",
  "presets",
  "settings",
  "keybindings",
  "field-metadata",
  "table-settings",
  "computed-columns",
  "custom-comparisons",
  "contextual-queries",
  "ratings",
  "schema",
];

/** The topics a write by each RPC method may change, as this device can tell
 * as it sends it (the server works out the exact ones). `dml` is generic, so
 * it may change any topic whose tables it can reach. A method that isn't
 * listed changes nothing live. */
const WRITE_TOPICS: Record<string, readonly Topic[]> = {
  "source.rename": ["sources"],
  "source.update_definition": ["sources"],
  "source.arrange": ["sources"],
  "query.add": ["sources"],
  "query.delete": ["sources"],
  "folder.add": ["sources"],
  "folder.rename": ["sources"],
  "folder.delete": ["sources"],
  "preset.add": ["presets"],
  "preset.update": ["presets"],
  "preset.delete": ["presets"],
  "setting.set": ["settings"],
  "setting.delete": ["settings"],
  "keybinding.set": ["keybindings"],
  "keybinding.delete": ["keybindings"],
  "metadata.field.set_visible": ["field-metadata"],
  "metadata.field.set_order": ["field-metadata"],
  "metadata.field.set_display": ["field-metadata"],
  "metadata.field.set_sorting": ["field-metadata"],
  "metadata.table.set_visible": ["table-settings"],
  "metadata.table.set_order": ["table-settings"],
  "metadata.table.set_querydown": ["table-settings"],
  "metadata.computed_column.set": ["computed-columns"],
  "metadata.computed_column.rename": ["computed-columns", "field-metadata"],
  "metadata.computed_column.delete": ["computed-columns", "field-metadata"],
  "metadata.custom_comparison.set": ["custom-comparisons"],
  "metadata.custom_comparison.rename": ["custom-comparisons"],
  "metadata.custom_comparison.delete": ["custom-comparisons"],
  dml: ["sources", "presets", "contextual-queries", "ratings"],
};

/**
 * This device's writes in flight, by the topics they change — fed every
 * request as it goes out (`onRequest`).
 *
 * A refetch waits for them, and is thrown away if one starts while it's on
 * its way. Either way, a list this device has just written to is never
 * overwritten by a copy read before its write landed: an edit of this device's
 * that the server hasn't acknowledged wins (the spec's merge rule 1). Edits
 * still *waiting* to be sent are the stores' to keep, item by item, since only
 * they know what's waiting.
 */
export class WriteTracker {
  private readonly inFlight = new Map<Topic, Set<Promise<void>>>();
  private readonly generations = new Map<Topic, number>();

  /** Notes a request to `method`, which settles with `settled`. */
  track(method: string, settled: Promise<void>): void {
    const topics = WRITE_TOPICS[method];
    if (!topics) return;
    for (const topic of topics) {
      this.generations.set(topic, this.generation(topic) + 1);
      const writes = this.inFlight.get(topic) ?? new Set();
      this.inFlight.set(topic, writes);
      writes.add(settled);
      void settled.then(() => writes.delete(settled));
    }
  }

  /** How many writes to `topic` have gone out: a refetch that sees this move
   * while it's on its way was overtaken by one. */
  generation(topic: Topic): number {
    return this.generations.get(topic) ?? 0;
  }

  /** Resolves once no write to `topic` is in flight. */
  async settled(topic: Topic): Promise<void> {
    for (;;) {
      const writes = this.inFlight.get(topic);
      if (!writes || writes.size === 0) return;
      await Promise.all(writes);
    }
  }
}

/** What applying a topic takes: refetch its list, and merge it in, unless
 * `superseded()` says a write of this device's went out meanwhile — then it
 * resolves `false` without touching state, and is called again once the write
 * has landed. */
export type Refetch = (
  topic: Topic,
  superseded: () => boolean,
) => Promise<boolean>;

export interface LiveUpdatesOptions {
  openStream: OpenChangeStream;
  /** This page load's `x-radiocrate-client` id: changes it made itself are
   * only noted, never refetched. */
  clientId: string;
  refetch: Refetch;
  writes: WriteTracker;
  /** For the log. */
  log?: (text: string) => void;
  /** How long the boot loads wait for the first `hello`. */
  helloTimeoutMs?: number;
  /** How long after the page is hidden the stream closes. */
  hideDelayMs?: number;
}

export interface LiveUpdates {
  /** Resolves once the boot loads can go out: on the first `hello` (so no
   * change can land between a list being read and the stream starting), or
   * once the stream has failed or taken too long, when the app goes on as it
   * would without live updates. */
  ready: Promise<void>;
  /** The page is on screen: connect. */
  show: () => void;
  /** The page went into the background: disconnect, a little later. */
  hide: () => void;
  /** The network came back: connect again now, if the page is on screen. */
  reconnect: () => void;
  dispose: () => void;
}

const HELLO_TIMEOUT_MS = 1000;
const HIDE_DELAY_MS = 5000;

/** Starts following the change stream. Nothing connects until `show`. */
export function createLiveUpdates(opts: LiveUpdatesOptions): LiveUpdates {
  const log = opts.log ?? (() => {});
  /** The server run this device last heard from, and the last version it saw
   * of each topic, its own writes included. `null` before the first hello. */
  let epoch: string | null = null;
  const versions = new Map<Topic, number>();
  let visible = false;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  // The boot loads' signal.
  let resolveReady!: () => void;
  let readyGiven = false;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const giveReady = () => {
    if (readyGiven) return;
    readyGiven = true;
    clearTimeout(readyTimer);
    resolveReady();
  };
  // Started now, not on `show`: a page that boots hidden still loads.
  const readyTimer = setTimeout(
    giveReady,
    opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS,
  );

  // Per topic, at most one refetch in flight and one queued behind it, so a
  // burst of changes (someone typing in the prelude) costs one or two
  // refetches, not one each.
  const running = new Set<Topic>();
  const queued = new Set<Topic>();

  const request = (topic: Topic) => {
    if (disposed) return;
    if (running.has(topic)) {
      queued.add(topic);
      return;
    }
    running.add(topic);
    void (async () => {
      try {
        for (;;) {
          await opts.writes.settled(topic);
          const generation = opts.writes.generation(topic);
          const applied = await opts.refetch(
            topic,
            () => opts.writes.generation(topic) !== generation,
          );
          if (applied || disposed) break;
        }
      } catch (err) {
        // The error bar has it, if it was an RPC. The next change, or the next
        // reconnect, tries again.
        console.error(`live update of ${topic} failed`, err);
      } finally {
        running.delete(topic);
        if (queued.delete(topic)) request(topic);
      }
    })();
  };

  const onHello = (hello: EventsHello) => {
    const first = epoch === null;
    const missed = first
      ? // The boot loads go out on this hello, unless they've already gone
        // (it was slow): then what they read may predate the stream.
        readyGiven
        ? LIVE_TOPICS
        : []
      : hello.epoch !== epoch
        ? // A new server run: what this device knew is from another life.
          LIVE_TOPICS
        : LIVE_TOPICS.filter(
            (topic) =>
              (hello.versions[topic] ?? 0) !== (versions.get(topic) ?? 0),
          );
    if (!first && hello.epoch !== epoch)
      log("The server restarted: refetching everything");
    epoch = hello.epoch;
    for (const topic of LIVE_TOPICS)
      versions.set(topic, hello.versions[topic] ?? 0);
    giveReady();
    if (missed.length > 0 && !first) {
      log(`Caught up with changes made meanwhile: ${missed.join(", ")}`);
    }
    for (const topic of missed) request(topic);
  };

  const onChanged = (change: TopicChanged) => {
    if (change.version <= (versions.get(change.topic) ?? 0)) return;
    versions.set(change.topic, change.version);
    // This device's own write: what it changed is already on screen.
    if (change.origin === opts.clientId) return;
    request(change.topic);
  };

  const stream: ChangeStream = opts.openStream({
    onHello,
    onChanged,
    onDown: (reason) => {
      // Nothing to wait for at boot: the app goes on without live updates.
      giveReady();
      log(`The change stream is down (${reason}); retrying`);
    },
  });

  return {
    ready,
    show: () => {
      if (disposed) return;
      visible = true;
      clearTimeout(hideTimer);
      hideTimer = undefined;
      stream.open();
    },
    hide: () => {
      if (disposed || !visible) return;
      visible = false;
      clearTimeout(hideTimer);
      // Not at once: a quick look at another app shouldn't cost a reconnect.
      hideTimer = setTimeout(() => {
        hideTimer = undefined;
        if (!visible) stream.close();
      }, opts.hideDelayMs ?? HIDE_DELAY_MS);
    },
    reconnect: () => {
      if (disposed || !visible) return;
      stream.close();
      stream.open();
    },
    dispose: () => {
      disposed = true;
      clearTimeout(hideTimer);
      clearTimeout(readyTimer);
      stream.close();
    },
  };
}
