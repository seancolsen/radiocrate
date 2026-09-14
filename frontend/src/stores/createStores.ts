import { shallow } from "zustand/vanilla/shallow";
import { browserEnv, type AppEnv } from "./env";
import { createAppStore, type AppStoreBundle } from "./app";
import { createCommandsStore, type CommandsStoreBundle } from "./commands";
import { createFormsStore, type FormsStoreBundle } from "./forms";
import { createMenusStore, type MenusStoreBundle } from "./menus";
import { createUpdateStore, type UpdateStoreBundle } from "./update";

export interface Stores {
  app: AppStoreBundle;
  forms: FormsStoreBundle;
  menus: MenusStoreBundle;
  commands: CommandsStoreBundle;
  update: UpdateStoreBundle;
  /** Tears down everything `createStores()` installed: the cross-store
   * subscriptions below, the global keydown pass, and the app store's own
   * `dispose` (the "system" theme listener, pending debounce timers). */
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
export function createStores(env: AppEnv = browserEnv()): Stores {
  const app = createAppStore(env);
  const forms = createFormsStore();
  const menus = createMenusStore();
  const commands = createCommandsStore(app, forms, menus);
  const update = createUpdateStore(app, forms);

  // Boot loads.
  void app.actions.loadQueries();
  void app.actions.loadPresets();
  void app.actions.loadSchema();
  void app.actions.loadSettings();
  void commands.actions.loadKeymap();

  // Cross-store wiring (state→state rules): it enforces state consistency and
  // has nothing to do with rendering, so no component owns it.

  // Unsaved record-editor changes live as long as the tab they were made in,
  // not as long as any one sidebar showing them.
  const unsubscribePrune = app.store.subscribe(
    (s) => s.tabs.map((t) => t.id),
    (ids) => {
      forms.actions.prune(ids);
    },
    { equalityFn: shallow },
  );

  // "Dynamic updates": keep every open record editor pointed at its tab's
  // current selection. `resyncRecordEditors` reads the editor targets
  // through `get()` rather than taking them as a subscription input, so the
  // writes it makes here can't feed back into this same subscription. The
  // input is every page's selection and lineage side by side, not `pages`
  // itself: the editor target lives in the same page object, so watching the
  // object would re-fire on the resync's own write.
  const unsubscribeResync = app.store.subscribe(
    (s) => Object.values(s.pages).flatMap((p) => [p.selection, p.lineage]),
    () => {
      app.actions.resyncRecordEditors();
    },
    { equalityFn: shallow },
  );

  // The global shortcut pass. Capture phase, so a chord is claimed before a
  // focused widget acts on it.
  const onKeyDown = (e: KeyboardEvent) => commands.actions.handleKeyDown(e);
  document.addEventListener("keydown", onKeyDown, true);

  function dispose() {
    unsubscribePrune();
    unsubscribeResync();
    document.removeEventListener("keydown", onKeyDown, true);
    app.dispose();
  }

  return { app, forms, menus, commands, update, dispose };
}
