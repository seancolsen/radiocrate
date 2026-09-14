import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { JSX } from "react";
import { shallow } from "zustand/vanilla/shallow";
import { CanvasGrid } from "../grid/canvasGrid";
import {
  selectResultCount,
  selectRowRecords,
  selectRowSelection,
  type RecordRef,
} from "../stores/app";
import { recordIdentity, selectModifiedRecords } from "../stores/forms";
import type { Stores } from "../stores/createStores";
import { useAppActions, useStores } from "../stores/react";
import { ContextMenu } from "./ui/ContextMenu";
import RowActionsMenu from "./RowActionsMenu";

// The results pane, rendered to a <canvas> (DOM-UI experiment, canvas variant).
// This component is a thin React shell: it owns the canvas element's lifecycle
// and feeds it the current tab's result; all layout, painting, and scrolling
// live in the framework-agnostic `CanvasGrid` engine (see canvasGrid.ts).
//
// Nothing here renders from state. The engine is an imperative object, so it's
// fed from **store subscriptions** rather than from renders (state management:
// "imperative bridges"): one effect creates the grid, a second one — keyed on
// the tab — subscribes it to that tab's slice of the store with
// `fireImmediately`, so the listener runs once at subscribe time with the grid
// already in hand.
//
// `QueryResult` is a class, so Immer never drafts or freezes it — the engine
// reads straight off the plain instance, cell derivation included.
//
// The one thing this shell owns beyond the canvas is the row context menu, which
// is real DOM (rows are painted pixels; a menu needs to be hit-testable, styled
// and accessible). While it's open the grid is frozen, so the rows underneath
// hold still.

/** An open row context menu: where it was raised, the rows it acts on, and the
 * records it offers to edit.
 *
 * The rows and records are captured when the menu is *raised* rather than read
 * from the store as it renders: the grid beneath is frozen and the menu blocks
 * every pointer event while it's up, so neither the selection nor the result
 * can move under it — and reading them here would mean subscribing this
 * component to both, which is exactly what the subscription bridge above
 * exists to avoid. */
interface RowMenu {
  x: number;
  y: number;
  /** The rows the menu acts on: the right-clicked row alone, unless it's part
   * of an existing multi-row selection — then every selected row (the bulk
   * case; see `RecordEditorTarget`). */
  rows: readonly number[];
  /** One entry per table whose primary key those rows carry (a track row
   * joined to its album offers both). */
  records: readonly RecordRef[];
}

/** The records `rows` offer to edit: one per table, in first-row-first order. */
function menuRecords(
  stores: Stores,
  tabId: string,
  rows: readonly number[],
): RecordRef[] {
  const state = stores.app.store.getState();
  const byTable = new Map<string, RecordRef>();
  for (const row of rows) {
    for (const record of selectRowRecords(state, tabId, row)) {
      if (!byTable.has(record.table)) byTable.set(record.table, record);
    }
  }
  return [...byTable.values()];
}

/** The rows whose records the editor is holding unsaved changes for — a ✱ on
 * the row, so an edit left behind on one record is visible while the user is
 * off editing another (spec: "Form state within the query page"). The rows
 * themselves are found by matching each row's key against the records the forms
 * store reports as modified, which is nothing to do while it reports none. */
function modifiedRows(stores: Stores, tabId: string): ReadonlySet<number> {
  const modified = new Set(
    selectModifiedRecords(stores.forms.store.getState(), tabId),
  );
  const rows = new Set<number>();
  if (modified.size === 0) return rows;
  const state = stores.app.store.getState();
  const count = selectResultCount(state, tabId) ?? 0;
  for (let row = 0; row < count; row++) {
    const marked = selectRowRecords(state, tabId, row).some((record) =>
      modified.has(recordIdentity(record.table, record.key)),
    );
    if (marked) rows.add(row);
  }
  return rows;
}

/** Feeds the grid its ✱ rows. The only push that spans two stores — which
 * records are modified comes from the forms store, and which rows those are
 * from the app store's result and lineage — so it's a pair of subscriptions
 * behind one recompute rather than a `store.subscribe` selector. */
function subscribeModifiedRows(
  stores: Stores,
  tabId: string,
  onChange: (rows: ReadonlySet<number>) => void,
): () => void {
  const recompute = () => onChange(modifiedRows(stores, tabId));
  const offForms = stores.forms.store.subscribe(
    (s) => selectModifiedRecords(s, tabId),
    recompute,
    { equalityFn: shallow, fireImmediately: true },
  );
  const offApp = stores.app.store.subscribe(
    (s) => [s.resultsByTab[tabId], s.lineageByTab[tabId]] as const,
    recompute,
    { equalityFn: shallow },
  );
  return () => {
    offForms();
    offApp();
  };
}

/** The results pane: the current tab's result set painted to a canvas grid. */
export default function QueryResults(props: { tabId: string }): JSX.Element {
  const stores = useStores();
  const { clickRow, doubleClickRow, setRecordEditorRecords } = useAppActions();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gridRef = useRef<CanvasGrid | undefined>(undefined);
  const [rowMenu, setRowMenu] = useState<RowMenu | undefined>(undefined);
  const closeMenu = useCallback(() => setRowMenu(undefined), []);

  // The engine itself, created once and outliving every tab switch (the query
  // page is reused, with a new `tabId`). A layout effect, not a passive one:
  // the tab subscriptions below push into the grid as they're installed, so it
  // has to exist by then.
  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const grid = new CanvasGrid(el);
    gridRef.current = grid;

    // Observe the *container*, not the canvas, for backing-store resizes. The
    // grid gives the canvas an explicit pixel size (for a 1:1 device-pixel
    // mapping), so the canvas no longer tracks its parent on its own — and
    // observing the canvas would never fire when the container grows.
    const host = el.parentElement ?? el;
    const ro = new ResizeObserver(() => grid.resize());
    ro.observe(host);

    // Repaint with the live theme's colors when it changes (system or explicit).
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onTheme = () => grid.refreshTheme();
    mq.addEventListener("change", onTheme);
    const mo = new MutationObserver(onTheme);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => {
      ro.disconnect();
      mq.removeEventListener("change", onTheme);
      mo.disconnect();
      grid.destroy();
      gridRef.current = undefined;
    };
  }, []);

  // Everything about *this tab*: what the grid is shown, and what a click on it
  // does. Re-runs on a tab switch, which tears down the old tab's
  // subscriptions and installs the new tab's — each with `fireImmediately`, so
  // the grid is caught up in one pass.
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const tabId = props.tabId;
    const store = stores.app.store;

    grid.setInteraction({
      onRowClick: (index, mods) => clickRow(tabId, index, mods),
      onRowDoubleClick: (index) => doubleClickRow(tabId, index),
      onRowContextMenu: (index, x, y) => {
        // A right-click inside an existing multi-row selection acts on the
        // whole selection, left as-is; any other right-click selects its row
        // alone first, so the menu's target is visible.
        const selection = selectRowSelection(store.getState(), tabId);
        const multi = selection.size > 1 && selection.has(index);
        if (!multi) clickRow(tabId, index, { shift: false, ctrl: false });
        // With nothing editable in the targeted row(s), there's nothing to show.
        const rows = multi ? [...selection] : [index];
        const records = menuRecords(stores, tabId, rows);
        if (records.length === 0) return;
        setRowMenu({ x, y, rows, records });
      },
    });

    // A 60 s ticker so a `relativeTime` cell ("3 minutes ago") keeps advancing
    // on a still grid, not just on scroll — the same repaint a row patch asks
    // for, so nothing new is needed downstream. Armed only when some visible
    // column actually carries a `relativeTime` formatter, so every other query
    // doesn't pay for a wakeup that changes no pixel; paused while the tab is
    // backgrounded, so it isn't a wakeup a battery report notices either.
    let ticker: ReturnType<typeof setInterval> | undefined;
    const syncTicker = () => {
      const result = store.getState().resultsByTab[tabId];
      const hasRelativeTime = (result?.visible ?? []).some(
        (c) => c.meta.formatter?.type === "relativeTime",
      );
      const armed = hasRelativeTime && !document.hidden;
      if (armed === (ticker !== undefined)) return;
      if (armed) ticker = setInterval(() => grid.redraw(), 60_000);
      else {
        clearInterval(ticker);
        ticker = undefined;
      }
    };
    document.addEventListener("visibilitychange", syncTicker);

    const subscriptions = [
      // The tab's result. `setResult` resets the engine's scroll and hover, so
      // it comes before the selection push that repaints with the right rows
      // highlighted. The ticker re-arms here too: whether a `relativeTime`
      // column is on screen is a property of the result.
      store.subscribe(
        (s) => s.resultsByTab[tabId],
        (result) => {
          grid.setResult(result);
          syncTicker();
        },
        { fireImmediately: true },
      ),
      // The tab's selection, for painting. A new `Set` reference per change.
      store.subscribe(
        (s) => selectRowSelection(s, tabId),
        (selection) => grid.setSelection(selection),
        { fireImmediately: true },
      ),
      // The playing track's row, when it lives in *this* tab's results — the
      // grid paints it with an accent edge marker.
      store.subscribe(
        (s) => {
          const ct = s.currentTrack;
          if (!ct || ct.sourceTabId !== tabId) return undefined;
          return ct.rowIndex ?? undefined;
        },
        (row) => grid.setCurrentRow(row),
        { fireImmediately: true },
      ),
      // A row re-read after a DML write is rewritten *inside* the result the
      // engine already holds, so that a single changed row doesn't read as a
      // new result set (which would reset the scroll and clear the selection).
      // Nothing about the result's identity changes, so the subscription above
      // never fires — this is what asks for the repaint.
      store.subscribe(
        (s) => s.rowPatch,
        (patch) => {
          if (patch?.tabId === tabId) grid.redraw();
        },
      ),
      // The now-playing bar's "Locate" asks the grid to scroll a row into view.
      // Fires immediately as well as on request: a Locate into a *different*
      // tab lands in the store before that tab's grid is subscribed.
      store.subscribe(
        (s) => s.rowReveal,
        (reveal) => {
          if (reveal?.tabId === tabId) grid.revealRow(reveal.row);
        },
        { fireImmediately: true },
      ),
      subscribeModifiedRows(stores, tabId, (rows) =>
        grid.setModifiedRows(rows),
      ),
    ];

    return () => {
      for (const unsubscribe of subscriptions) unsubscribe();
      document.removeEventListener("visibilitychange", syncTicker);
      clearInterval(ticker);
      ticker = undefined;
      // This component outlives a tab switch, so a menu raised on the old
      // tab's rows would otherwise linger over rows it no longer refers to —
      // and come back with the tab if the user switched away and back.
      setRowMenu(undefined);
    };
  }, [props.tabId, stores, clickRow, doubleClickRow]);

  // The rows stop responding while their menu is up: no hover, no scroll, no
  // click. The blocking layer over the canvas already stops most of it; this
  // covers the rest (see `CanvasGrid.setFrozen`).
  useEffect(() => {
    gridRef.current?.setFrozen(rowMenu !== undefined);
  }, [rowMenu]);

  return (
    <div className="bg-panel relative min-h-0 flex-1 overflow-hidden">
      <canvas ref={canvasRef} className="block h-full w-full touch-none" />
      {rowMenu && (
        <ContextMenu x={rowMenu.x} y={rowMenu.y} onClose={closeMenu}>
          <RowActionsMenu
            records={rowMenu.records}
            onEdit={(record) => {
              const state = stores.app.store.getState();
              const records = rowMenu.rows.flatMap((row) =>
                selectRowRecords(state, props.tabId, row).filter(
                  (r) => r.table === record.table,
                ),
              );
              setRecordEditorRecords(props.tabId, record.table, records);
            }}
          />
        </ContextMenu>
      )}
    </div>
  );
}
