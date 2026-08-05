// Solid DevTools runtime. Import first so the debugger attaches before the app
// mounts. Tree-shaken out of production builds (the module is a no-op there).
import "solid-devtools";
import { render } from "solid-js/web";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import { AppStateProvider, useAppState } from "./state/store";
import { CommandProvider } from "./state/commands";
import { applySeed } from "./dev/seed";
import "./app.css";

// Mirror the old SW update flow: prompt, don't auto-activate.
const updateSW = registerSW({ onNeedRefresh() {}, onOfflineReady() {} });
// Expose a manual apply, matching the old window.radiocrate.applyUpdate.
interface RadioCrateGlobal {
  applyUpdate: () => void;
}
(window as unknown as { radiocrate: RadioCrateGlobal }).radiocrate = {
  applyUpdate: () => updateSW(true),
};

function Root() {
  // Apply any URL-param seed to the store (no-op in production without params).
  applySeed(useAppState());
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
