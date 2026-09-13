import { createContext, useContext, type ReactNode } from "react";
import { useStore } from "zustand";
import type { AppActions, AppState } from "./app";
import type { CommandsActions, CommandsState } from "./commands";
import type { Stores } from "./createStores";
import type { FormsActions, FormsState, RecordFormModel } from "./forms";
import type { UpdateActions, UpdateState } from "./update";

// The one file under `stores/` that imports React (state management rule 6):
// a context handing down the store bundle `createStores()` built, plus typed
// hooks over each store so a component subscribes to exactly the slice it
// reads (rule 2 — narrow selectors are what give React back the fine-grained
// updates Solid's signals gave for free).

const StoresContext = createContext<Stores | null>(null);

export function StoresProvider(props: { stores: Stores; children: ReactNode }) {
  return (
    <StoresContext.Provider value={props.stores}>
      {props.children}
    </StoresContext.Provider>
  );
}

export function useStores(): Stores {
  const stores = useContext(StoresContext);
  if (!stores) throw new Error("useStores must be used within StoresProvider");
  return stores;
}

// ── The app store ────────────────────────────────────────────────────────—

export function useApp<T>(selector: (s: AppState) => T): T {
  return useStore(useStores().app.store, selector);
}

/** Actions are stable references, safe in an effect's dependency array (state
 * management rule 1) — never selected out of state. */
export function useAppActions(): AppActions {
  return useStores().app.actions;
}

// ── The command store ───────────────────────────────────────────────────—

export function useCommands<T>(selector: (s: CommandsState) => T): T {
  return useStore(useStores().commands.store, selector);
}

export function useCommandActions(): CommandsActions {
  return useStores().commands.actions;
}

// ── The forms store (the stash + registry, not any one form) ────────────—

export function useForms<T>(selector: (s: FormsState) => T): T {
  return useStore(useStores().forms.store, selector);
}

export function useFormsActions(): FormsActions {
  return useStores().forms.actions;
}

/** Reads one stashed form's own state — `model.store` is a separate vanilla
 * store per form (state management: "the record editor form"), so this is a
 * second hook rather than a selector argument on `useForms`. Stage 7 replaces
 * `RecordFormModel`'s placeholder `unknown` state with the real `FormState`,
 * at which point `selector` narrows accordingly; nothing here has to change
 * for that. */
export function useFormState<T>(
  model: RecordFormModel,
  selector: (s: unknown) => T,
): T {
  return useStore(model.store, selector);
}

// ── The update store ─────────────────────────────────────────────────────

export function useUpdate<T>(selector: (s: UpdateState) => T): T {
  return useStore(useStores().update.store, selector);
}

export function useUpdateActions(): UpdateActions {
  return useStores().update.actions;
}
