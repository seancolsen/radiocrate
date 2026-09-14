import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { createStores } from "./stores/createStores";
import { StoresProvider } from "./stores/react";
import { applySeed } from "./dev/seed";
import "../app.css";

// The app's entry, loaded by `index.html`.
//
// Everything that isn't rendering happens *before* the root mounts, out of
// React's way: the store bundle is built once, the URL-param seed is applied to
// it, and the service worker is registered. `StrictMode` double-invokes render
// functions, initializers and effects in development, so none of these may sit
// inside a component — the Solid app could do them from `Root()` because a
// Solid component body runs exactly once (state management: "StrictMode").
const stores = createStores();

// Apply any URL-param seed to the store (no-op in production without params).
applySeed(stores);

// Register the service worker and start the client-update checks.
// `createStores()` deliberately leaves this to the entry, so neither the visual
// harness nor a store unit test registers a worker.
stores.update.actions.initUpdates();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StoresProvider stores={stores}>
      <App />
    </StoresProvider>
  </StrictMode>,
);
