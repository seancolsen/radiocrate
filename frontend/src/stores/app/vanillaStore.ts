import { createStore } from "zustand/vanilla";
import { subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import type { AppEnv } from "../env";
import { initialState, type AppState } from "./state";

/** The vanilla Zustand store: Immer for `set((draft) => { … })` writes,
 * `subscribeWithSelector` so code outside React (the audio engine callbacks,
 * `createStores()`'s cross-store wiring, Playwright) can subscribe to one slice
 * without a component. The creator function ignores its `(set, get, api)`
 * arguments and just returns the initial data — actions live outside state
 * entirely, in `actions.ts` (state management rule 1). */
export function createAppVanillaStore(env: AppEnv) {
  return createStore<AppState>()(
    subscribeWithSelector(immer(() => initialState(env))),
  );
}

export type AppVanillaStore = ReturnType<typeof createAppVanillaStore>;
