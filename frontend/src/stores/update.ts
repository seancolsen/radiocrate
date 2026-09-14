import { createStore } from "zustand/vanilla";
import { subscribeWithSelector } from "zustand/middleware";
import { registerSW } from "virtual:pwa-register";
import { appVersion, type AppVersion } from "api-client";
import type { AppStoreBundle } from "./app";
import { selectIsUnsaved } from "./app";
import type { FormsStoreBundle } from "./forms";
import { selectModifiedRecords } from "./forms";
import {
  isClientStale,
  shouldApplyNow,
  type SessionState,
} from "../state/updatePolicy";

// The client-update controller: everything about the service-worker lifecycle
// lives here, in a vanilla store built once by `createStores()`.
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
// The policy deciding what to do about it is in `state/updatePolicy.ts` (pure
// and unit-tested); this module is the wiring that feeds it.
//
// NOTE: `vite-plugin-pwa` only injects a service worker on *build*, so none of
// this behavior is observable under `bun run dev`. Verify with `bun run build` +
// `vite preview`, or against the real binary.

/** How often a foregrounded session re-checks the server's build id. The
 * foreground check below covers the common Android-PWA case (an app resumed
 * after the server was upgraded); this only catches a session left open for
 * hours on a screen that never blurs. */
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

export interface UpdateState {
  /** Whether a new client has been downloaded and is waiting to activate —
   * i.e. whether `applyUpdate` has anything to apply. */
  ready: boolean;
  /** Whether this client's build id differs from the one the server reports:
   * the running client did not come from the running binary. Advisory — an
   * old client against a new server may hit changed RPC shapes, but a forced
   * mid-edit reload is worse than the API error it would prevent. */
  stale: boolean;
  /** The last `app.version` answer, or `undefined` before the first check
   * lands (or if every check has failed). For the About panel. */
  version: AppVersion | undefined;
  /** Whether the user has dismissed the update banner this session. */
  dismissed: boolean;
}

function initialUpdateState(): UpdateState {
  return { ready: false, stale: false, version: undefined, dismissed: false };
}

/** This client's own build id, compiled in by Vite (`__BUILD_ID__`). Exposed
 * so the About panel doesn't have to reach for a build-time global. */
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
export function selectUpdateNotice(s: UpdateState): "stale" | "ready" | null {
  if (s.stale) return "stale";
  if (s.ready && !s.dismissed) return "ready";
  return null;
}

function createUpdateVanillaStore() {
  return createStore<UpdateState>()(
    subscribeWithSelector(() => initialUpdateState()),
  );
}

export type UpdateVanillaStore = ReturnType<typeof createUpdateVanillaStore>;

export interface UpdateActions {
  /** Asks the server which build it is, and — when this client isn't it —
   * pushes the service worker to go and fetch the new one. `onNeedRefresh` is
   * what reports the result arriving, so this function's only visible effect
   * is on the store's `version` and `stale` fields.
   *
   * Failures are swallowed: offline, or a server mid-restart, is not
   * something to put in front of the user, and the next check will find
   * out. */
  checkForUpdate: () => Promise<void>;
  /** Applies a waiting update: activate the new worker and reload onto it.
   * Also the `window.radiocrate.applyUpdate` debug seam. */
  applyUpdate: () => void;
  /** Hides the update banner for the rest of this session. A no-op while the
   * client is stale — that banner is advisory, but it isn't dismissible. */
  dismissUpdate: () => void;
  /** The escape hatch: throw away the service worker and every cache it
   * holds, then reload from the network. What to reach for when a client is
   * stuck on an old build and the ordinary update path hasn't shifted it — a
   * worker that never reaches `waiting`, a precache the SW keeps serving. It
   * is also the `"stale"` banner's action, since that notice can fire with
   * nothing for `applyUpdate` to apply.
   *
   * `localStorage` is deliberately left alone: theme, sidebar and audio prefs
   * are never the problem, and losing them would make this feel destructive.
   * Nothing on the server and no user data is touched — which is why it's
   * called "Reload fresh copy" everywhere it's offered. Open tabs do close,
   * because any reload closes them (they're persisted nowhere).
   *
   * Both teardown steps are best-effort: a browser with no service worker, or
   * one refusing cache access, should still get the reload. */
  resetAppData: () => Promise<void>;
  /** Registers the service worker and starts the update checks. Idempotent —
   * safe to call more than once (only the first call does anything), since
   * `createStores()` calls it exactly once but a test may not care to track
   * that. */
  initUpdates: () => void;
}

/** The session snapshot the apply policy reads, taken from the app store and
 * the forms store (the record-editor stash's modified records). */
function sessionFor(
  app: AppStoreBundle,
  forms: FormsStoreBundle,
): SessionState {
  return {
    playing: app.store.getState().playback.playing,
    tabIds: app.store.getState().tabs.map((tab) => tab.id),
    tabUnsaved: (tabId) => selectIsUnsaved(app.store.getState(), tabId),
    recordsUnsaved: (tabId) =>
      selectModifiedRecords(forms.store.getState(), tabId).length > 0,
  };
}

/** Builds the update store, wired to the given app and forms bundles (the
 * apply policy's inputs — state management: the update store "reads" both).
 * They're bound at construction, so the session snapshot is always available,
 * even before `initUpdates` runs. */
export function createUpdateStore(
  app: AppStoreBundle,
  forms: FormsStoreBundle,
): { store: UpdateVanillaStore; actions: UpdateActions } {
  const store = createUpdateVanillaStore();

  /** The `updateSW` callback `registerSW` hands back; `undefined` until
   * `initUpdates` has run (and in a browser with no service worker at all). */
  let updateSW: ((reloadPage?: boolean) => Promise<void>) | undefined;
  /** The live registration, once it lands — what `checkForUpdate` pushes to
   * go and fetch a new `sw.js`. */
  let registration: ServiceWorkerRegistration | undefined;
  /** Guards against overlapping checks — the foreground check and the
   * interval can easily coincide. */
  let checking = false;
  /** One registration per store (and so, in the app, per page load). */
  let initialized = false;

  const applyUpdate = () => {
    void updateSW?.(true);
  };

  const dismissUpdate = () => {
    if (store.getState().stale) return;
    store.setState({ dismissed: true });
  };

  const checkForUpdate = async () => {
    if (checking) return;
    checking = true;
    try {
      const info = await appVersion();
      const stale = isClientStale(__BUILD_ID__, info.buildId);
      store.setState({ version: info, stale });
      if (stale) await registration?.update();
    } catch (err) {
      console.warn("update check failed", err);
    } finally {
      checking = false;
    }
  };

  const resetAppData = async () => {
    try {
      const registrations =
        (await navigator.serviceWorker?.getRegistrations()) ?? [];
      await Promise.all(registrations.map((reg) => reg.unregister()));
    } catch (err) {
      console.warn("failed to unregister service workers", err);
    }
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    } catch (err) {
      console.warn("failed to clear caches", err);
    }
    location.reload();
  };

  /** A new client has finished downloading and is waiting. Apply it right
   * away if the session can absorb a reload; otherwise leave it to the
   * banner. */
  const onNeedRefresh = () => {
    store.setState({ ready: true });
    if (shouldApplyNow(sessionFor(app, forms))) applyUpdate();
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") void checkForUpdate();
  };

  const initUpdates = () => {
    if (initialized) return;
    initialized = true;

    updateSW = registerSW({
      onNeedRefresh,
      onOfflineReady() {},
      onRegisteredSW(_swUrl, reg) {
        registration = reg;
        // A check right at startup is what makes the core case work: the
        // user restarted the server and reopened the app, so ask immediately
        // whether this client is still the right one. (A worker left waiting
        // by the previous session needs no check at all — `onNeedRefresh`
        // fires for it on registration, and an idle session applies it there
        // and then.)
        void checkForUpdate();
        setInterval(() => void checkForUpdate(), CHECK_INTERVAL_MS);
      },
    });

    // The main win for a resident PWA: an Android app that has been
    // backgrounded for a day learns about a server upgrade the moment it is
    // resumed.
    document.addEventListener("visibilitychange", onVisibilityChange);

    // The debug seam. Both actions are reachable from the UI now (the update
    // bar and the About panel), but a wedged client is exactly the case where
    // the UI may be the old one — and this is callable from a
    // remote-debugging console attached to an installed Android PWA, where
    // there is no other way in.
    (
      window as unknown as {
        radiocrate: { applyUpdate: () => void; resetAppData: () => void };
      }
    ).radiocrate = { applyUpdate, resetAppData: () => void resetAppData() };
  };

  return {
    store,
    actions: {
      checkForUpdate,
      applyUpdate,
      dismissUpdate,
      resetAppData,
      initUpdates,
    },
  };
}

export type UpdateStoreBundle = ReturnType<typeof createUpdateStore>;
