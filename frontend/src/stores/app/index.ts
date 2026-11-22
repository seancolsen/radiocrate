import { browserEnv, type AppEnv } from "../env";
import { createAppActions } from "./actions";
import { createAppVanillaStore } from "./vanillaStore";

export * from "./state";
export * from "./selectors";
export type { AppActions, PreparedStep } from "./actions";
export type { AppVanillaStore } from "./vanillaStore";

/** Builds one app store bundle: the vanilla Zustand+Immer store, its actions,
 * a `dispose` that tears down what the actions installed (the "system"
 * theme listener, pending debounce timers), and `isApplyingRemote`, which says
 * whether the write under way is another device's change (live updates). Built once, outside React, by
 * `createStores()` and by store unit tests directly. */
export function createAppStore(env: AppEnv = browserEnv()) {
  const store = createAppVanillaStore(env);
  const { actions, dispose, isApplyingRemote } = createAppActions(store, env);
  return { store, actions, dispose, isApplyingRemote };
}

export type AppStoreBundle = ReturnType<typeof createAppStore>;
