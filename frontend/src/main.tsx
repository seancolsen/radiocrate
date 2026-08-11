// Solid DevTools runtime. Import first so the debugger attaches before the app
// mounts. Tree-shaken out of production builds (the module is a no-op there).
import "solid-devtools";
import { render } from "solid-js/web";
import App from "./App";
import { AppStateProvider, useAppState } from "./state/store";
import { CommandProvider } from "./state/commands";
import { initUpdates } from "./state/update";
import { applySeed } from "./dev/seed";
import "./app.css";

function Root() {
  const store = useAppState();
  // Apply any URL-param seed to the store (no-op in production without params).
  applySeed(store);
  // Register the service worker and start the client-update checks. Inside the
  // tree, not at module scope: the apply policy reads the store.
  initUpdates(store);
  return <App />;
}

render(
  () => (
    <AppStateProvider>
      <CommandProvider>
        <Root />
      </CommandProvider>
    </AppStateProvider>
  ),
  document.getElementById("root")!,
);
