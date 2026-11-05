// One-time initialization of the Querydown wasm module (built from git at the
// pinned rev via wasm-pack `--target web`; see plan §2). Under Vite the `.wasm`
// is imported as a same-origin asset URL (CSP/offline-safe — no external fetch)
// and `init()` is called once; every compile awaits `querydownReady()` first.

import init, { QuerydownCompleter } from "querydown-js";
import wasmUrl from "querydown-js/querydown_js_bg.wasm?url";

let ready: Promise<void> | undefined;
let loaded = false;

/** Initializes the Querydown wasm module once, returning a promise that resolves
 * when it is ready to compile. Idempotent — repeated calls share one init. */
export function querydownReady(): Promise<void> {
  ready ??= init({ module_or_path: wasmUrl }).then(() => {
    loaded = true;
  });
  return ready;
}

/** Whether the module has finished initializing, so a compile can run
 * synchronously right now — what checking text as it's typed needs, where
 * waiting isn't an option. Starts nothing: see {@link querydownReady}. */
export function querydownLoaded(): boolean {
  return loaded;
}

/** Subscribes to the module finishing its load (starting it, if nothing has
 * yet), as `useSyncExternalStore` takes it, with {@link querydownLoaded} as
 * the snapshot: it's loaded once, and never unloads. */
export function subscribeQuerydownLoaded(onLoad: () => void): () => void {
  let live = true;
  void querydownReady().then(() => {
    if (live) onLoad();
  });
  return () => {
    live = false;
  };
}

let completer:
  { schemaJson: string; completer: QuerydownCompleter | null } | undefined;

/** The editors' completer for the database `schemaJson` describes, or `null`
 * when the compiler won't take the schema. One is made per schema (it parses
 * the schema once) and shared by every editor; one an editor still holds when
 * the schema changes is left to wasm-bindgen's finalizer. Call only once the
 * module has loaded ({@link querydownLoaded}). */
export function completerFor(schemaJson: string): QuerydownCompleter | null {
  if (completer?.schemaJson !== schemaJson) {
    let made: QuerydownCompleter | null = null;
    try {
      made = new QuerydownCompleter(schemaJson);
    } catch (err) {
      console.error("Querydown completion is off:", err);
    }
    completer = { schemaJson, completer: made };
  }
  return completer.completer;
}
