import { createEffect, onCleanup, onMount } from "solid-js";
import { unwrap } from "solid-js/store";
import { useAppState } from "../state/store";
import type { QueryResult } from "../query/result";
import { CanvasGrid } from "./canvasGrid";

// The results pane, rendered to a <canvas> (DOM-UI experiment, canvas variant).
// This component is a thin Solid shell: it owns the canvas element's lifecycle
// and feeds it the current tab's result; all layout, painting, and scrolling
// live in the framework-agnostic `CanvasGrid` engine (see canvasGrid.ts).
//
// The result set is an immutable snapshot, so `unwrap` hands the engine the raw
// object rather than a Solid store proxy — reading tens of thousands of cells
// during paint never wraps them reactively.

/** The results pane: the current tab's result set painted to a canvas grid. */
export default function QueryResults(props: { tabId: string }) {
  const store = useAppState();
  let canvas: HTMLCanvasElement | undefined;
  let grid: CanvasGrid | undefined;

  const currentResult = (): QueryResult | undefined => {
    const tracked = store.state.resultsByTab[props.tabId];
    return tracked ? (unwrap(tracked) as QueryResult) : undefined;
  };

  // Push the tab's result into the engine whenever it changes (or the tab
  // switches). No-op until the engine exists (created in onMount).
  createEffect(() => {
    const result = currentResult();
    grid?.setResult(result);
  });

  // Push the tab's selection into the engine for painting. Reads the selection
  // reactively (new set reference per change), so this re-runs on every
  // selection change and on tab switch. `setResult` above resets the engine's
  // scroll/hover; the selection push repaints with the right highlighted rows.
  createEffect(() => {
    const selection = store.rowSelection(props.tabId);
    grid?.setSelection(selection);
  });

  onMount(() => {
    const el = canvas;
    if (!el) return;
    grid = new CanvasGrid(el);
    grid.setInteraction({
      onRowClick: (index, mods) => store.clickRow(props.tabId, index, mods),
      onRowDoubleClick: (index) => store.doubleClickRow(props.tabId, index),
    });
    grid.setResult(currentResult());
    grid.setSelection(store.rowSelection(props.tabId));

    // Observe the *container*, not the canvas, for backing-store resizes. The
    // grid gives the canvas an explicit pixel size (for a 1:1 device-pixel
    // mapping), so the canvas no longer tracks its parent on its own — and
    // observing the canvas would never fire when the container grows.
    const host = el.parentElement ?? el;
    const ro = new ResizeObserver(() => grid?.resize());
    ro.observe(host);

    // Repaint with the live theme's colors when it changes (system or explicit).
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onTheme = () => grid?.refreshTheme();
    mq.addEventListener("change", onTheme);
    const mo = new MutationObserver(onTheme);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    onCleanup(() => {
      ro.disconnect();
      mq.removeEventListener("change", onTheme);
      mo.disconnect();
      grid?.destroy();
      grid = undefined;
    });
  });

  return (
    <div class="bg-panel relative min-h-0 flex-1 overflow-hidden">
      <canvas
        ref={(el) => (canvas = el)}
        class="block h-full w-full touch-none"
      />
    </div>
  );
}
