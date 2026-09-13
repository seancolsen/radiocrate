import { browserEnv, type AppEnv } from "../env";
import { createAppActions } from "./actions";
import { createAppVanillaStore } from "./vanillaStore";

export * from "./state";
export * from "./selectors";
export type { AppActions } from "./actions";
export type { AppVanillaStore } from "./vanillaStore";

/** Builds one app store bundle: the vanilla Zustand+Immer store, its actions,
 * and a `dispose` that tears down what the actions installed (the "system"
 * theme listener, pending debounce timers). Built once, outside React, by
 * `createStores()` (stage 2) and by store unit tests directly. */
export function createAppStore(env: AppEnv = browserEnv()) {
  const store = createAppVanillaStore(env);
  const { actions, dispose } = createAppActions(store, env);
  return { store, actions, dispose };
}

export type AppStoreBundle = ReturnType<typeof createAppStore>;
