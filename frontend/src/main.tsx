import { render } from "solid-js/web";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
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

render(() => <App />, document.getElementById("root")!);
