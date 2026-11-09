import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { JSX } from "react";
import { createPortal } from "react-dom";
import { shallow } from "zustand/vanilla/shallow";
import { CanvasGrid } from "../grid/canvasGrid";
import {
  queuedRowPositions,
  selectMultiSelect,
  selectPageDiagnostic,
  selectPageTab,
  selectRecordGroupsForRows,
  selectResultCount,
  selectResultIsRefresh,
  selectResultsScroll,
  selectRowDropGap,
  selectRowRecords,
  selectRowSelection,
  selectTrackIdAt,
  type AppState,
  type RecordGroup,
} from "../stores/app";
import { cx } from "./ui/cx";
import { recordIdentity, selectModifiedRecords } from "../stores/forms";
import type { Stores } from "../stores/createStores";
import { useApp, useAppActions, useStores } from "../stores/react";
import { ContextMenu } from "./ui/ContextMenu";
import MultiSelectToolbar, { MULTI_SELECT_INSET } from "./MultiSelectToolbar";
import RowActionsMenu from "./RowActionsMenu";
import RowDragChip from "./RowDragChip";
import { dragChipTransform } from "./ui/DragChip";

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
// underneath hold still — the floating multi-select toolbar, whose height the
// grid is told to keep scrollable above its first row, and the chip that
// follows the pointer while rows are dragged.
//
// Rows that are tracks can be dragged onto a playlist in the explorer's tree,
// and a playlist's rows can be dragged to another place among themselves. The
// drag itself is plain data in the store (`rowDrag`), which the tree reads to
// highlight the playlist that would take the rows, and the grid to draw the
// line where they'd go among its own. Finding what's under the pointer is this
// shell's: the playlist is a question about the DOM, and the gap between rows
// one for the grid.

/** An open row context menu: where it was raised, the rows it acts on, and the
 * records those rows identify.
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
  /** One group per table whose primary key those rows carry (a track row
   * joined to its album offers both) — empty for rows that identify nothing,
   * where the menu still offers "Select multiple". */
  groups: readonly RecordGroup[];
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

/** The rows of `tabId` holding queued tracks, for the grid's dashed rings:
 * each with its place in the queue, which is shown only while there's more
 * than one track queued. */
function queuedRows(
  state: AppState,
  tabId: string,
): ReadonlyMap<number, number | null> {
  const rows = queuedRowPositions(state, tabId);
  if (state.queuedTracks.length > 1) return rows;
  return new Map([...rows.keys()].map((row) => [row, null]));
}

/** Puts the drag chip just below and right of viewport point (x, y), clear of
 * what the pointer is over. */
function placeChip(el: HTMLElement | null, x: number, y: number): void {
  if (el) el.style.transform = dragChipTransform(x, y);
}

/** The source whose explorer row is at viewport point (x, y), or `null`. Tree
 * rows carry their source's id (see `SourceRow`). */
function sourceAt(x: number, y: number): string | null {
  const row = document
    .elementFromPoint(x, y)
    ?.closest<HTMLElement>("[data-tree-row][data-source-id]");
  return row?.dataset.sourceId ?? null;
}

/** The results pane: the current tab's result set painted to a canvas grid. */
export default function QueryResults(props: { tabId: string }): JSX.Element {
  const stores = useStores();
  const {
    beginRowDrag,
    clickRow,
    doubleClickRow,
    editSelectedRows,
    endRowDrag,
    hoverRowDrag,
    loadRatings,
    removeRows,
    requestAddToPlaylist,
    runQuery,
    setMultiSelect,
    setResultsScroll,
    toggleQueuedRow,
  } = useAppActions();
  const multiSelect = useApp((s) => selectMultiSelect(s, props.tabId));
  // While the error strip shows a problem, these rows are an earlier
  // definition's: they stay usable, but fade back.
  const stale = useApp((s) => selectPageDiagnostic(s, props.tabId) !== null);
  // A playlist's rows can be removed from it.
  const playlist = useApp(
    (s) => selectPageTab(s, props.tabId)?.kind === "playlist",
  );
  // Rows that are tracks can be added to a playlist.
  const tracks = useApp(
    (s) => s.pages[props.tabId]?.lineage?.trackIdColumn !== undefined,
  );
  // How many rows this page has in hand, while they're being dragged (0
  // otherwise): every one lists an entry on a playlist's page, and holds a
  // track elsewhere.
  const dragCount = useApp((s) =>
    s.rowDrag?.fromTabId === props.tabId
      ? Math.max(s.rowDrag.trackIds.length, s.rowDrag.entryIds.length)
      : 0,
  );
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gridRef = useRef<CanvasGrid | undefined>(undefined);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [rowMenu, setRowMenu] = useState<RowMenu | undefined>(undefined);
  const closeMenu = useCallback(() => setRowMenu(undefined), []);
  // The drag chip, and where the pointer last was: the chip mounts a render
  // after the drag begins, and takes its first place from there.
  const chipRef = useRef<HTMLDivElement | null>(null);
  const dragPoint = useRef({ x: 0, y: 0 });
  const chipMounted = useCallback((el: HTMLDivElement | null) => {
    chipRef.current = el;
    placeChip(el, dragPoint.current.x, dragPoint.current.y);
  }, []);

  // The engine itself, created as the page is shown and destroyed as it's
  // hidden (each tab has its own page, and a hidden one runs its effects'
  // cleanups; see `TabContent`). A layout effect, not a passive one: the tab
  // subscriptions below push into the grid as they're installed, so it has to
  // exist by then.
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
  // does. Runs each time the page is shown, installing the subscriptions with
  // `fireImmediately` so the new grid is caught up in one pass, and tears them
  // down as it's hidden.
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const tabId = props.tabId;
    const store = stores.app.store;

    // Puts the selection where a gesture aimed at row `index` means it: an
    // existing multi-row selection the row belongs to is left as-is, and so is
    // the selection in multi-select mode (where collapsing it would throw away
    // what the user is assembling — an unselected row is added to it instead).
    // Any other gesture selects its row alone, so its target is visible.
    const aimAtRow = (index: number) => {
      const state = store.getState();
      const selection = selectRowSelection(state, tabId);
      const keep = selectMultiSelect(state, tabId)
        ? selection.has(index)
        : selection.size > 1 && selection.has(index);
      if (!keep) clickRow(tabId, index, { shift: false, ctrl: false });
    };

    // Opens the row menu at viewport point (x, y), for row `index` and
    // whatever else of the selection a gesture there means (see `aimAtRow`).
    const raiseMenu = (index: number, x: number, y: number) => {
      // The menu acts on the selection.
      aimAtRow(index);
      const multiMode = selectMultiSelect(store.getState(), tabId);
      const rows = [...selectRowSelection(store.getState(), tabId)];
      const groups = selectRecordGroupsForRows(store.getState(), tabId, rows);
      // Nothing editable in the targeted rows leaves the menu with only
      // "Select multiple" — and nothing at all once that mode is already on.
      if (groups.length === 0 && multiMode) return;
      // The rating vocabulary is fetched the first time a menu that offers it
      // is raised, which is here — an event handler, so no effect has to
      // chase the menu's open state.
      if (groups.some((group) => group.table === "track")) loadRatings();
      setRowMenu({ x, y, rows, groups });
    };

    grid.setInteraction({
      // Alt+click queues the row's track (or takes it out of the queue),
      // leaving the selection as it is.
      onRowClick: (index, mods) => {
        if (mods.alt) toggleQueuedRow(tabId, index);
        else clickRow(tabId, index, mods);
      },
      onRowDoubleClick: (index) => doubleClickRow(tabId, index),
      onRowContextMenu: raiseMenu,
      // From the keyboard, the menu is for the selection, and hangs from its
      // lead row (the one the arrow keys last moved to), brought into view.
      onKeyboardContextMenu: () => {
        const selection = store.getState().pages[tabId]?.selection;
        if (!selection) return;
        const row = selection.rows.has(selection.lead)
          ? selection.lead
          : Math.min(...selection.rows);
        grid.revealRow(row);
        const point = grid.rowMenuPoint(row);
        if (point) raiseMenu(row, point.x, point.y);
      },
      onRowDragStart: (index, x, y) => {
        dragPoint.current = { x, y };
        return beginRowDrag(tabId, index);
      },
      onRowDragMove: (x, y) => {
        dragPoint.current = { x, y };
        placeChip(chipRef.current, x, y);
        hoverRowDrag(sourceAt(x, y), grid.gapAt(x, y) ?? null);
      },
      onRowDragEnd: (x, y, drop) => {
        if (drop) hoverRowDrag(sourceAt(x, y), grid.gapAt(x, y) ?? null);
        return endRowDrag(drop);
      },
      // Left edits the row, and right queues its track (or takes it out of
      // the queue), as Alt+click does. A row with nothing to edit, or no
      // track, doesn't offer to, and the touch goes on being a pan.
      onRowSwipeStart: (index, direction) => {
        const state = store.getState();
        if (direction === "left") {
          return selectRowRecords(state, tabId, index).length > 0
            ? "Edit"
            : null;
        }
        const id = selectTrackIdAt(state, tabId, index);
        if (id === undefined) return null;
        return state.queuedTracks.some((track) => track.id === id)
          ? "Unqueue"
          : "Queue";
      },
      onRowSwipe: (index, direction) => {
        if (direction === "right") {
          toggleQueuedRow(tabId, index);
          return;
        }
        aimAtRow(index);
        editSelectedRows(tabId);
      },
      onPullRefresh: () => runQuery(tabId),
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
      // Whether the rows are being re-run: rows a pull left waiting go home once
      // they're back.
      store.subscribe(
        (s) => s.pages[tabId]?.running ?? false,
        (running) => grid.setRefreshing(running),
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
      // The rows holding queued tracks — from any tab: a track is queued
      // wherever it's listed — which the grid rings with dashes.
      store.subscribe(
        (s) =>
          [
            s.queuedTracks,
            s.pages[tabId]?.result,
            s.pages[tabId]?.lineage,
          ] as const,
        () => grid.setQueuedRows(queuedRows(store.getState(), tabId)),
        { equalityFn: shallow, fireImmediately: true },
      ),
      // A row re-read after a DML write is rewritten *inside* the result the
      // engine already holds, so that a single changed row doesn't read as a
      // new result set (which would reset the scroll and clear the selection).
      // Nothing about the result's identity changes, so the subscription above
      // never fires — this is what asks for the repaint.
      // Where rows dragged on this page (a playlist's) would drop among its
      // rows: the grid draws the line there, and scrolls at its edges while
      // they're in hand.
      store.subscribe(
        (s) => selectRowDropGap(s, tabId),
        (gap) => grid.setDropGap(gap),
        { fireImmediately: true },
      ),
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
    // subscriptions, not before: the result push above has just put the new
    // engine at the top of the rows, and this is the tab's own place in them,
    // restored over it. A tab that
    // has never been scrolled restores a harmless 0.
    grid.setScrollOffset(selectResultsScroll(store.getState(), tabId));

    return () => {
      // Leaving the tab: hand its scroll offset back to the store, since the
      // grid is about to be torn down (`grid` is the captured instance, so this
      // still reads the right number even once the layout effect above has
      // destroyed it).
      setResultsScroll(tabId, grid.scrollOffset());
      for (const unsubscribe of subscriptions) unsubscribe();
      document.removeEventListener("visibilitychange", syncTicker);
      clearInterval(ticker);
      ticker = undefined;
      // A menu is a gesture in progress, not state of the tab: it doesn't come
      // back with the page.
      setRowMenu(undefined);
    };
  }, [
    props.tabId,
    stores,
    beginRowDrag,
    clickRow,
    doubleClickRow,
    editSelectedRows,
    endRowDrag,
    hoverRowDrag,
    loadRatings,
    runQuery,
    setResultsScroll,
    toggleQueuedRow,
  ]);

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
      {/* Focusable (by a click, not Tab), so the Menu key has the rows to
          raise their menu over. */}
      <canvas
        ref={canvasRef}
        tabIndex={-1}
        className={cx(
          "block h-full w-full touch-none transition-opacity outline-none",
          { "opacity-50": stale },
        )}
      />
      {multiSelect && (
        <MultiSelectToolbar ref={toolbarRef} tabId={props.tabId} />
      )}
      {dragCount > 0 &&
        createPortal(
          <RowDragChip ref={chipMounted} count={dragCount} />,
          document.body,
        )}
      {rowMenu && (
        <ContextMenu x={rowMenu.x} y={rowMenu.y} onClose={closeMenu}>
          <RowActionsMenu
            tabId={props.tabId}
            groups={rowMenu.groups}
            trackRows={tracks ? rowMenu.rows : undefined}
            onAddToPlaylist={
              tracks
                ? () => requestAddToPlaylist(props.tabId, rowMenu.rows)
                : undefined
            }
            onRemoveFromPlaylist={
              playlist ? () => removeRows(props.tabId, rowMenu.rows) : undefined
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
