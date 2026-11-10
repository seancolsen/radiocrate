import { onRequest, onRpcFailure } from "api-client";
import { shallow } from "zustand/vanilla/shallow";
import { browserEnv, type AppEnv } from "./env";
import { createAppStore, type AppState, type AppStoreBundle } from "./app";
import { createCommandsStore, type CommandsStoreBundle } from "./commands";
import {
  createFormsStore,
  recordIdentity,
  type FormRetention,
  type FormsStoreBundle,
} from "./forms";
import { createMenusStore, type MenusStoreBundle } from "./menus";
import { createExpansionMemory, type ExpansionMemory } from "./recordForm";
import { createUpdateStore, type UpdateStoreBundle } from "./update";
import { embedChanges } from "../query/fieldMetadata";
import { describeError, stackLines } from "../log/log";

export interface Stores {
  app: AppStoreBundle;
  forms: FormsStoreBundle;
  /** What the user has left expanded in the record editor, for every form. */
  recordExpansion: ExpansionMemory;
  menus: MenusStoreBundle;
  commands: CommandsStoreBundle;
  update: UpdateStoreBundle;
  /** Tears down everything `createStores()` installed: the cross-store
   * subscriptions below, the global keydown, visibility and logging
   * listeners, and the app store's own `dispose` (the "system" theme
   * listener, pending debounce and log-save timers, saves waiting for the app
   * to go quiet). */
  dispose: () => void;
}

/**
 * Builds the whole store bundle **once, outside React** (state management:
 * "store topology") — the app, forms, menus, commands and update stores, in
 * that dependency order (the app store imports no other store; forms may
 * call app actions; commands and update read all the others). Runs the boot
 * loads and wires the two cross-store rules: rules that span stores, and so
 * belong to neither side of them.
 *
 * Building outside React keeps `StrictMode`'s double render and double
 * effects away from the boot fetches and the `matchMedia` listener. It does
 * *not* call `update.actions.initUpdates()`: registering the service worker is
 * `main.tsx`'s job, so neither the visual harness nor a store test registers
 * one.
 */
/** Every open tab and the identities of the records its editor is open on —
 * what the forms store is told to keep (`FormsActions.retain`). */
function selectFormRetention(s: AppState): FormRetention[] {
  return s.tabs.map((t) => {
    const target = s.pages[t.id]?.recordEditor;
    return {
      tabId: t.id,
      target: target
        ? target.records.map((r) => recordIdentity(r.table, r.key))
        : null,
    };
  });
}

/** Retention compared by value: the resync re-points an editor at the same
 * records as new objects on every selection write, which isn't news. */
function sameRetention(
  a: readonly FormRetention[],
  b: readonly FormRetention[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (x, i) =>
        x.tabId === b[i].tabId &&
        (x.target === null || b[i].target === null
          ? x.target === b[i].target
          : shallow(x.target, b[i].target)),
    )
  );
}

export function createStores(env: AppEnv = browserEnv()): Stores {
  const app = createAppStore(env);
  const forms = createFormsStore();
  const recordExpansion = createExpansionMemory(env);
  const menus = createMenusStore();
  const commands = createCommandsStore(app, forms, menus);
  const update = createUpdateStore(app, forms);

  // Boot loads.
  void app.actions.loadSources();
  void app.actions.loadPresets();
  void app.actions.loadSchema();
  void app.actions.loadSettings();
  void app.actions.loadFieldMetadata();
  void app.actions.loadContextualQueries();
  void commands.actions.loadKeymap();

  // Cross-store wiring (state→state rules): it enforces state consistency and
  // has nothing to do with rendering, so no component owns it.

  // A record-editor form lives as long as its tab's editor is open on it, and
  // unsaved changes as long as the tab they were made in — never as long as
  // any one component showing them happens to be mounted.
  const unsubscribeRetain = app.store.subscribe(
    selectFormRetention,
    (tabs) => {
      forms.actions.retain(tabs);
    },
    { equalityFn: sameRetention, fireImmediately: true },
  );

  // What a field's embedded records show is customized once, for every form on
  // the table, so each form is told when it changes, whichever one was edited.
  const unsubscribeEmbeds = app.store.subscribe(
    (s) => s.fieldMetadata.data,
    (next, previous) => {
      const changes = embedChanges(previous, next);
      if (changes.length === 0) return;
      for (const entry of forms.store.getState().entries) {
        entry.model.refreshEmbeds(changes);
      }
    },
  );

  // A contextual query shows on every record of its table, so every form is told
  // when one is added, renamed, edited or removed.
  const unsubscribeContextualQueries = app.store.subscribe(
    (s) => s.contextualQueries.data,
    () => {
      for (const entry of forms.store.getState().entries) {
        entry.model.syncContextualQueries();
      }
    },
  );

  // "Dynamic updates": keep every open record editor pointed at its tab's
  // current selection. `resyncRecordEditors` reads the editor targets
  // through `get()` rather than taking them as a subscription input, so the
  // writes it makes here can't feed back into this same subscription. The
  // input is every page's selection and lineage side by side, not `pages`
  // itself: the editor target lives in the same page object, so watching the
  // object would re-fire on the resync's own write.
  const unsubscribeResync = app.store.subscribe(
    (s) =>
      Object.values(s.pages).flatMap((p) => [p.selection?.rows, p.lineage]),
    () => {
      app.actions.resyncRecordEditors();
    },
    { equalityFn: shallow },
  );

  // Every failed RPC call, whichever action made it, lands in the error bar.
  const unsubscribeRpcFailures = onRpcFailure(({ method, error }) => {
    app.actions.reportRpcFailure(method, error);
  });

  // A saved query's edits are written once the app has gone quiet — and every
  // request the app sends, whichever action sent it, is the app not being
  // quiet.
  const unsubscribeRequests = onRequest(({ settled }) => {
    app.actions.noteRequest(settled);
  });

  // A page being hidden may never be shown again (a closed browser tab, a
  // mobile OS reclaiming a backgrounded PWA), so whatever saves are waiting go
  // out now rather than when the app would have gone quiet.
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") app.actions.flushSaves();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);

  // What the page and the network did, for the log: the background is where
  // the trouble the log is for happens, and a page that's hidden, frozen or
  // unloading may not run again for a while — so the log is saved then too.
  const log = app.actions.log;
  const onPageVisibility = () => {
    if (document.visibilityState === "hidden") {
      log("page", "The app went into the background, or the screen turned off");
      app.actions.flushLog();
    } else {
      log("page", "The app is on screen again");
    }
  };
  const onFreeze = () => {
    log("page", "The browser froze the app: nothing runs until it resumes");
    app.actions.flushLog();
  };
  const onResume = () => log("page", "The browser resumed the app");
  const onPageHide = (e: PageTransitionEvent) => {
    log(
      "page",
      e.persisted
        ? "The page is being put aside, to be restored if the user comes back"
        : "The page is unloading",
    );
    app.actions.flushLog();
  };
  const onPageShow = (e: PageTransitionEvent) => {
    if (e.persisted) log("page", "The page was restored as it was left");
  };
  const onOnline = () => log("network", "The device is back online");
  const onOffline = () => log("network", "The device went offline");
  const onError = (e: ErrorEvent) => {
    log("app", `Error: ${e.message}`, [
      ...(e.filename ? [`In ${e.filename}:${e.lineno}:${e.colno}`] : []),
      ...stackLines(e.error),
    ]);
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    log("app", `Error left unhandled: ${describeError(e.reason)}`, [
      ...stackLines(e.reason),
    ]);
  };
  document.addEventListener("visibilitychange", onPageVisibility);
  document.addEventListener("freeze", onFreeze);
  document.addEventListener("resume", onResume);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);

  // The global shortcut pass. Capture phase, so a chord is claimed before a
  // focused widget acts on it.
  const onKeyDown = (e: KeyboardEvent) => commands.actions.handleKeyDown(e);
  document.addEventListener("keydown", onKeyDown, true);
  const onKeyUp = (e: KeyboardEvent) => commands.actions.handleKeyUp(e);
  document.addEventListener("keyup", onKeyUp, true);
  // Leaving the window mid-switch (Alt+Tab away) never sees the key come up.
  const onWindowBlur = () => app.actions.cancelTabSwitcher();
  window.addEventListener("blur", onWindowBlur);

  function dispose() {
    unsubscribeRetain();
    unsubscribeEmbeds();
    unsubscribeContextualQueries();
    unsubscribeResync();
    unsubscribeRpcFailures();
    unsubscribeRequests();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    document.removeEventListener("visibilitychange", onPageVisibility);
    document.removeEventListener("freeze", onFreeze);
    document.removeEventListener("resume", onResume);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("blur", onWindowBlur);
    app.dispose();
  }

  return { app, forms, recordExpansion, menus, commands, update, dispose };
}
