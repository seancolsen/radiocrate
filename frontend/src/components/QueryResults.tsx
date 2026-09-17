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
  selectMultiSelect,
  selectRecordsForRows,
  selectResultCount,
  selectResultIsRefresh,
  selectResultsScroll,
  selectRowRecords,
  selectRowSelection,
  selectTableRecordsForRows,
  type RecordRef,
} from "../stores/app";
import { recordIdentity, selectModifiedRecords } from "../stores/forms";
import type { Stores } from "../stores/createStores";
import { useApp, useAppActions, useStores } from "../stores/react";
import { ContextMenu } from "./ui/ContextMenu";
import MultiSelectToolbar, { MULTI_SELECT_INSET } from "./MultiSelectToolbar";
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
// What this shell owns beyond the canvas is the DOM over it (rows are painted
// pixels; a menu or a toolbar needs to be hit-testable, styled and accessible):
// the row context menu — while it's open the grid is frozen, so the rows
// underneath hold still — and the floating multi-select toolbar, whose height
// the grid is told to keep scrollable above its first row.

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
  /** The rows the menu acts on — the selection as the right-click left it: the
   * clicked row alone, unless it belonged to a multi-row selection (or one
   * being assembled in multi-select mode), in which case every selected row
   * (the bulk case; see `RecordEditorTarget`). */
  rows: readonly number[];
  /** One entry per table whose primary key those rows carry (a track row
   * joined to its album offers both) — empty for rows that identify nothing,
   * where the menu still offers "Select multiple". */
  records: readonly RecordRef[];
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
    (s) => [s.pages[tabId]?.result, s.pages[tabId]?.lineage] as const,
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
  const {
    clickRow,
    doubleClickRow,
    setMultiSelect,
    setRecordEditorRecords,
    setResultsScroll,
  } = useAppActions();
  const multiSelect = useApp((s) => selectMultiSelect(s, props.tabId));
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gridRef = useRef<CanvasGrid | undefined>(undefined);
  const toolbarRef = useRef<HTMLDivElement>(null);
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
        // The menu acts on the selection, so the selection is put where the
        // right-click means it: an existing multi-row selection the clicked row
        // belongs to is left as-is, and so is the selection in multi-select
        // mode (where collapsing it would throw away what the user is
        // assembling — an unselected row is added to it instead). Any other
        // right-click selects its row alone, so the menu's target is visible.
        const state = store.getState();
        const selection = selectRowSelection(state, tabId);
        const multiMode = selectMultiSelect(state, tabId);
        const keep = multiMode
          ? selection.has(index)
          : selection.size > 1 && selection.has(index);
        if (!keep) clickRow(tabId, index, { shift: false, ctrl: false });
        const rows = [...selectRowSelection(store.getState(), tabId)];
        const records = selectRecordsForRows(store.getState(), tabId, rows);
        // Nothing editable in the targeted rows leaves the menu with only
        // "Select multiple" — and nothing at all once that mode is already on.
        if (records.length === 0 && multiMode) return;
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
      const result = store.getState().pages[tabId]?.result;
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
      //
      // A *refresh* — the same query re-run, which brought back the same rows
      // the user is looking at — keeps the scroll where it is instead, and the
      // store is what knows which of the two swaps this is (the store's
      // `resultIsRefresh`; it keeps the selection over the same swaps). Read
      // through `getState()` rather than subscribed to: it qualifies the result
      // landing, it isn't news of its own.
      store.subscribe(
        (s) => s.pages[tabId]?.result,
        (result) => {
          grid.setResult(
            result,
            selectResultIsRefresh(store.getState(), tabId),
          );
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
      // grid rings it with a blue rectangle.
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

    // Where this tab was scrolled to when it was last on screen. After the
    // subscriptions, not before: the result push above has just put the engine
    // back at the top of a tab it's seeing for the first time this visit, and
    // this is the tab's own place in those rows, restored over it. A tab that
    // has never been scrolled restores a harmless 0.
    grid.setScrollOffset(selectResultsScroll(store.getState(), tabId));

    return () => {
      // Leaving the tab: hand its scroll offset back to the store, since the
      // grid itself is about to be shown another tab's rows (or torn down —
      // `grid` is the captured instance, so this still reads the right number
      // even once the layout effect below has destroyed it).
      setResultsScroll(tabId, grid.scrollOffset());
      for (const unsubscribe of subscriptions) unsubscribe();
      document.removeEventListener("visibilitychange", syncTicker);
      clearInterval(ticker);
      ticker = undefined;
      // This component outlives a tab switch, so a menu raised on the old
      // tab's rows would otherwise linger over rows it no longer refers to —
      // and come back with the tab if the user switched away and back.
      setRowMenu(undefined);
    };
  }, [props.tabId, stores, clickRow, doubleClickRow, setResultsScroll]);

  // The floating multi-select toolbar covers the first rows, so the grid gets
  // that much room to scroll up into — the toolbar's own height plus the
  // margin it sits in. Measured rather than assumed (the bar is as tall as its
  // content), and given back when the mode ends. A layout effect: the reserve
  // is in place before the first paint with the toolbar up.
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const el = toolbarRef.current;
    if (!el) {
      grid.setTopOverscroll(0);
      return;
    }
    const push = () =>
      grid.setTopOverscroll(el.offsetHeight + MULTI_SELECT_INSET);
    const ro = new ResizeObserver(push);
    ro.observe(el);
    push();
    return () => {
      ro.disconnect();
      grid.setTopOverscroll(0);
    };
  }, [multiSelect]);

  // The rows stop responding while their menu is up: no hover, no scroll, no
  // click. The blocking layer over the canvas already stops most of it; this
  // covers the rest (see `CanvasGrid.setFrozen`).
  useEffect(() => {
    gridRef.current?.setFrozen(rowMenu !== undefined);
  }, [rowMenu]);

  return (
    <div className="bg-panel relative min-h-0 flex-1 overflow-hidden">
      <canvas ref={canvasRef} className="block h-full w-full touch-none" />
      {multiSelect && (
        <MultiSelectToolbar ref={toolbarRef} tabId={props.tabId} />
      )}
      {rowMenu && (
        <ContextMenu x={rowMenu.x} y={rowMenu.y} onClose={closeMenu}>
          <RowActionsMenu
            records={rowMenu.records}
            onEdit={(record) =>
              setRecordEditorRecords(
                props.tabId,
                record.table,
                selectTableRecordsForRows(
                  stores.app.store.getState(),
                  props.tabId,
                  rowMenu.rows,
                  record.table,
                ),
              )
            }
            onSelectMultiple={
              multiSelect ? undefined : () => setMultiSelect(props.tabId, true)
            }
          />
        </ContextMenu>
      )}
    </div>
  );
}
