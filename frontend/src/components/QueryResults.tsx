import {
  createEffect,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { unwrap } from "solid-js/store";
import { useAppState } from "../state/store";
import type { QueryResult } from "../query/result";
import { Icons } from "../icons";
import { ContextMenu } from "./ui/ContextMenu";
import { MenuItem } from "./ui/Menu";
import { CanvasGrid } from "./canvasGrid";

// The results pane, rendered to a <canvas> (DOM-UI experiment, canvas variant).
// This component is a thin Solid shell: it owns the canvas element's lifecycle
// and feeds it the current tab's result; all layout, painting, and scrolling
// live in the framework-agnostic `CanvasGrid` engine (see canvasGrid.ts).
//
// The result set is an immutable snapshot, so `unwrap` hands the engine the raw
// object rather than a Solid store proxy — reading tens of thousands of cells
// during paint never wraps them reactively.
//
// The one thing this shell owns beyond the canvas is the row context menu, which
// is real DOM (rows are painted pixels; a menu needs to be hit-testable, styled
// and accessible). While it's open the grid is frozen, so the rows underneath
// hold still.

/** An open row context menu: which row it targets, and where it was raised. */
interface RowMenu {
  row: number;
  x: number;
  y: number;
}

/** The results pane: the current tab's result set painted to a canvas grid. */
export default function QueryResults(props: { tabId: string }) {
  const store = useAppState();
  let canvas: HTMLCanvasElement | undefined;
  let grid: CanvasGrid | undefined;
  const [rowMenu, setRowMenu] = createSignal<RowMenu | undefined>();
  const closeMenu = () => setRowMenu(undefined);

  // The records the open menu offers to edit — one entry per table whose primary
  // key the row carries (a track row joined to its album offers both).
  const menuRecords = () => {
    const menu = rowMenu();
    return menu ? store.rowRecords(props.tabId, menu.row) : [];
  };

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

  // This component outlives a tab switch (the query page is reused, with a new
  // `tabId`), so a menu raised on the old tab's rows would otherwise linger over
  // rows it no longer refers to.
  createEffect(on(() => props.tabId, closeMenu));

  // The rows stop responding while their menu is up: no hover, no scroll, no
  // click. The blocking layer over the canvas already stops most of it; this
  // covers the rest (see `CanvasGrid.setFrozen`).
  createEffect(() => {
    const frozen = rowMenu() !== undefined;
    grid?.setFrozen(frozen);
  });

  // Push the tab's selection into the engine for painting. Reads the selection
  // reactively (new set reference per change), so this re-runs on every
  // selection change and on tab switch. `setResult` above resets the engine's
  // scroll/hover; the selection push repaints with the right highlighted rows.
  createEffect(() => {
    const selection = store.rowSelection(props.tabId);
    grid?.setSelection(selection);
  });

  // The playing track's row, when it lives in *this* tab's results — the grid
  // paints it with an accent edge marker. Re-runs when the track, its row, or the
  // tab changes.
  const currentRow = (): number | undefined => {
    const ct = store.state.currentTrack;
    if (!ct || ct.sourceTabId !== props.tabId || ct.rowIndex === null) {
      return undefined;
    }
    return ct.rowIndex;
  };
  // Read the row *before* the optional call: `grid?.setCurrentRow(currentRow())`
  // would skip evaluating the argument entirely while the grid is still being
  // created (effects run before this component's `onMount`), so the effect would
  // subscribe to nothing on its first run and never fire again.
  createEffect(() => {
    const row = currentRow();
    grid?.setCurrentRow(row);
  });

  // The now-playing bar's "Locate" asks the grid to scroll a row into view. The
  // request is a signal, so this re-runs per request; it's applied again from
  // `onMount` because a Locate into a *different* tab lands here before the tab's
  // grid exists (effects run before this component's `onMount`).
  const applyReveal = () => {
    const reveal = store.rowReveal();
    if (reveal && reveal.tabId === props.tabId) grid?.revealRow(reveal.row);
  };
  createEffect(applyReveal);

  onMount(() => {
    const el = canvas;
    if (!el) return;
    grid = new CanvasGrid(el);
    grid.setInteraction({
      onRowClick: (index, mods) => store.clickRow(props.tabId, index, mods),
      onRowDoubleClick: (index) => store.doubleClickRow(props.tabId, index),
      onRowContextMenu: (index, x, y) => {
        // The menu acts on one row. A right-click inside a multi-row selection
        // is left alone rather than silently narrowing it (there's no bulk edit)
        // — mirroring the egui results pane.
        const selection = store.rowSelection(props.tabId);
        if (selection.size > 1 && selection.has(index)) return;
        // Any other right-click selects its row alone first, so the menu's
        // target is visible.
        store.clickRow(props.tabId, index, { shift: false, ctrl: false });
        // With nothing editable in this row, there's nothing to show.
        if (store.rowRecords(props.tabId, index).length === 0) return;
        setRowMenu({ row: index, x, y });
      },
    });
    grid.setResult(currentResult());
    grid.setSelection(store.rowSelection(props.tabId));
    grid.setCurrentRow(currentRow());
    applyReveal();

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
      <Show when={rowMenu()}>
        {(menu) => (
          <ContextMenu x={menu().x} y={menu().y} onClose={closeMenu}>
            <For each={menuRecords()}>
              {(record) => (
                <MenuItem
                  icon={Icons.Edit}
                  label={`Edit ${record.table}`}
                  onClick={() => store.openRecordEditor(props.tabId, record)}
                />
              )}
            </For>
          </ContextMenu>
        )}
      </Show>
    </div>
  );
}
