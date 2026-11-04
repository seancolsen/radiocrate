// One-time initialization of the Querydown wasm module (built from git at the
// pinned rev via wasm-pack `--target web`; see plan §2). Under Vite the `.wasm`
// is imported as a same-origin asset URL (CSP/offline-safe — no external fetch)
// and `init()` is called once; every compile awaits `querydownReady()` first.

import init from "querydown-js";
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
