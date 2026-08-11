// The client-update controller: everything about the service-worker lifecycle
// lives here, and `main.tsx` does nothing but call {@link initUpdates}.
//
// Detection and application are separate channels on purpose. `app.version` is
// the detection channel — one cheap RPC that answers "did the binary serving me
// move on?" exactly, since `rust-embed` bakes the client into the binary and the
// two carry the same build id. The service worker remains the application
// channel: `registerType: "prompt"` parks a new worker in `waiting` and reports
// it through `onNeedRefresh`, the authoritative "new code is downloaded and
// ready to activate". Keeping them apart means a wedged SW update check can't
// hide the fact that the server moved on, and the About panel can show a reason
// rather than a shrug.
//
// The policy deciding what to do about it is in `updatePolicy.ts` (pure, and
// unit-tested); this module is the wiring that feeds it.
//
// NOTE: `vite-plugin-pwa` only injects a service worker on *build*, so none of
// this behavior is observable under `bun run dev`. Verify with `bun run build` +
// `vite preview`, or against the real binary.

import { createSignal, type Accessor } from "solid-js";
import { registerSW } from "virtual:pwa-register";
import { appVersion, type AppVersion } from "api-client";
import { modifiedRecords } from "../components/record/formStash";
import type { AppStore } from "./store";
import {
  isClientStale,
  shouldApplyNow,
  type SessionState,
} from "./updatePolicy";

/** How often a foregrounded session re-checks the server's build id. The
 * foreground check below covers the common Android-PWA case (an app resumed
 * after the server was upgraded); this only catches a session left open for
 * hours on a screen that never blurs. */
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

const [ready, setReady] = createSignal(false);
const [stale, setStale] = createSignal(false);
const [version, setVersion] = createSignal<AppVersion>();
const [dismissed, setDismissed] = createSignal(false);

/** Whether a new client has been downloaded and is waiting to activate — i.e.
 * whether {@link applyUpdate} has anything to apply. */
export const updateReady: Accessor<boolean> = ready;

/** Whether this client's build id differs from the one the server reports: the
 * running client did not come from the running binary. Advisory — an old client
 * against a new server may hit changed RPC shapes, but a forced mid-edit reload
 * is worse than the API error it would prevent. */
export const clientStale: Accessor<boolean> = stale;

/** The last `app.version` answer, or `undefined` before the first check lands
 * (or if every check has failed). For the About panel. */
export const versionInfo: Accessor<AppVersion | undefined> = version;

/** Whether the user has dismissed the update banner this session. */
export const updateDismissed: Accessor<boolean> = dismissed;

/** This client's own build id, compiled in by Vite (`__BUILD_ID__`). Exposed so
 * the About panel doesn't have to reach for a build-time global. */
export const clientBuildId = (): string => __BUILD_ID__;

/** Which update banner the session warrants, or `null` for none:
 *
 * - `"stale"` — the server has moved on from this client. Shown whether or not a
 *   new worker is ready yet, and *not* dismissible: this session may already be
 *   talking to an API it doesn't match.
 * - `"ready"` — a new client is downloaded and waiting, and the session wasn't
 *   idle enough to apply it silently. Dismissible.
 *
 * The dismissibility rule lives here rather than in the banner so there's one
 * place to read it. */
export function updateNotice(): "stale" | "ready" | null {
  if (stale()) return "stale";
  if (ready() && !dismissed()) return "ready";
  return null;
}

/** The `updateSW` callback `registerSW` hands back; `undefined` until
 * {@link initUpdates} has run (and in a browser with no service worker at all). */
let updateSW: ((reloadPage?: boolean) => Promise<void>) | undefined;

/** The live registration, once it lands — what {@link checkForUpdate} pushes to
 * go and fetch a new `sw.js`. */
let registration: ServiceWorkerRegistration | undefined;

/** Reads the current session out of the app store, for the apply policy. */
let session: (() => SessionState) | undefined;

/** Guards against overlapping checks — the foreground check and the interval can
 * easily coincide. */
let checking = false;

/** Applies a waiting update: activate the new worker and reload onto it. Also
 * the `window.radiocrate.applyUpdate` debug seam. */
export function applyUpdate(): void {
  void updateSW?.(true);
}

/** Hides the update banner for the rest of this session. A no-op while the
 * client is stale — that banner is advisory, but it isn't dismissible. */
export function dismissUpdate(): void {
  if (stale()) return;
  setDismissed(true);
}

/** Asks the server which build it is, and — when this client isn't it — pushes
 * the service worker to go and fetch the new one. `onNeedRefresh` is what
 * reports the result arriving, so this function's only visible effect is on
 * {@link versionInfo} and {@link clientStale}.
 *
 * Failures are swallowed: offline, or a server mid-restart, is not something to
 * put in front of the user, and the next check will find out. */
export async function checkForUpdate(): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    const info = await appVersion();
    setVersion(info);
    const isStale = isClientStale(__BUILD_ID__, info.buildId);
    setStale(isStale);
    if (isStale) await registration?.update();
  } catch (err) {
    console.warn("update check failed", err);
  } finally {
    checking = false;
  }
}

/** The session snapshot the apply policy reads, taken from the app store and the
 * record-editor form stash. */
function sessionFor(store: AppStore): SessionState {
  return {
    playing: store.state.playback.playing,
    tabIds: store.state.tabs.map((tab) => tab.id),
    tabUnsaved: (tabId) => store.isUnsaved(tabId),
    recordsUnsaved: (tabId) => modifiedRecords(tabId).length > 0,
  };
}

/** A new client has finished downloading and is waiting. Apply it right away if
 * the session can absorb a reload; otherwise leave it to the banner. */
function onNeedRefresh(): void {
  setReady(true);
  const current = session?.();
  if (current && shouldApplyNow(current)) applyUpdate();
}

function onVisibilityChange(): void {
  if (document.visibilityState === "visible") void checkForUpdate();
}

/** Registers the service worker and starts the update checks. Called once, from
 * inside the component tree (`Root()` in `main.tsx`) rather than at module
 * scope, because the apply policy reads the store — which doesn't exist until
 * the provider has run. */
export function initUpdates(store: AppStore): void {
  if (session) return; // one registration per page load
  session = () => sessionFor(store);

  updateSW = registerSW({
    onNeedRefresh,
    onOfflineReady() {},
    onRegisteredSW(_swUrl, reg) {
      registration = reg;
      // A check right at startup is what makes the core case work: the user
      // restarted the server and reopened the app, so ask immediately whether
      // this client is still the right one. (A worker left waiting by the
      // previous session needs no check at all — `onNeedRefresh` fires for it on
      // registration, and an idle session applies it there and then.)
      void checkForUpdate();
      setInterval(() => void checkForUpdate(), CHECK_INTERVAL_MS);
    },
  });

  // The main win for a resident PWA: an Android app that has been backgrounded
  // for a day learns about a server upgrade the moment it is resumed.
  document.addEventListener("visibilitychange", onVisibilityChange);

  (
    window as unknown as { radiocrate: { applyUpdate: () => void } }
  ).radiocrate = { applyUpdate };
}
