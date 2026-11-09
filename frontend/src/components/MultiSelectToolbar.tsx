import { forwardRef, useMemo } from "react";
import { Icons } from "../icons";
import {
  recordGroupsForRows,
  selectPageTab,
  selectRangeSelect,
  selectResultCount,
  selectRowSelection,
} from "../stores/app";
import { useApp, useAppActions } from "../stores/react";
import IconButton from "./ui/IconButton";
import { Menu } from "./ui/Menu";
import RowActionsMenu from "./RowActionsMenu";

/** The gap kept between the floating toolbar and the top/right edges of the
 * results pane. Also what the results grid reserves above its first row *on
 * top of* the toolbar's own height, so the rows the toolbar floats over can
 * still be scrolled into the clear (see `CanvasGrid.setTopOverscroll`). */
export const MULTI_SELECT_INSET = 8;

/** How many records the selection covers, as the toolbar says it. */
function selectionLabel(n: number): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? "record" : "records"}`;
}

/** The floating multi-select toolbar: what's selected, what can be done with
 * it, and the way out of the mode. Left to right:
 *
 * - a checkbox for the whole result set, beside the count: empty, partly
 *   filled or checked as none, some or all of the rows are selected. A tap
 *   selects them all, or, once they all are, clears the selection (which
 *   keeps the mode on, ready for the next tap).
 * - the range toggle. While it's on, a tap selects the rows from the range's
 *   origin to the tapped row (a touch device's Shift+click), and the origin
 *   stays put wherever the taps land (see `rangedSelection`). The grid marks
 *   the origin with a bar down its left edge.
 * - the actions menu, and the way out.
 *
 * It floats over the results rather than taking a line of its own, so entering
 * the mode doesn't shift every row underneath the finger that entered it; the
 * rows it covers stay reachable because the grid reserves the toolbar's height
 * above its first row to scroll into (see {@link MULTI_SELECT_INSET}).
 *
 * The actions menu is the row context menu's body over the whole selection —
 * with no "Select multiple" entry, since that's the mode this toolbar *is*.
 * Closing keeps the selection: the mode goes away, the selected rows don't.
 *
 * The ref forwards to the bar itself, which is what the results pane measures
 * to know how far above the first row to let the user scroll. */
const MultiSelectToolbar = forwardRef<HTMLDivElement, { tabId: string }>(
  function MultiSelectToolbar(props, ref) {
    const {
      clearRowSelection,
      loadRatings,
      removeRows,
      requestAddToPlaylist,
      selectAllRows,
      setMultiSelect,
      setRangeSelect,
    } = useAppActions();
    // Three references already in state, combined here rather than through a
    // selector that would build a fresh array on every store write (state
    // management rule 2).
    const selection = useApp((s) => selectRowSelection(s, props.tabId));
    const result = useApp((s) => s.pages[props.tabId]?.result);
    const lineage = useApp((s) => s.pages[props.tabId]?.lineage);
    const groups = useMemo(
      () => recordGroupsForRows(result, lineage, selection),
      [result, lineage, selection],
    );
    // Tracks can be added to a playlist, and a playlist's rows can be removed
    // from it, whether or not they identify a record to edit.
    const tracks = lineage?.trackIdColumn !== undefined;
    const playlist = useApp(
      (s) => selectPageTab(s, props.tabId)?.kind === "playlist",
    );
    const range = useApp((s) => selectRangeSelect(s, props.tabId));
    const rowCount = useApp((s) => selectResultCount(s, props.tabId) ?? 0);
    const all = rowCount > 0 && selection.size === rowCount;

    return (
      <div
        ref={ref}
        data-testid="multi-select-toolbar"
        className="bg-panel border-edge absolute flex items-center gap-1 rounded-md border p-1 shadow-lg"
        style={{ top: MULTI_SELECT_INSET, right: MULTI_SELECT_INSET }}
      >
        <IconButton
          icon={
            all
              ? Icons.SelectAll
              : selection.size > 0
                ? Icons.SelectSome
                : Icons.SelectNone
          }
          label={all ? "Clear selection" : "Select all"}
          command={all ? undefined : "results.select_all"}
          tooltipAlign="start"
          disabled={rowCount === 0}
          onClick={() =>
            all ? clearRowSelection(props.tabId) : selectAllRows(props.tabId)
          }
        />
        <span className="text-ink-weak mr-1 text-xs whitespace-nowrap">
          {selectionLabel(selection.size)}
        </span>
        <IconButton
          icon={Icons.SelectRange}
          label="Select a range"
          pressed={range}
          onClick={() => setRangeSelect(props.tabId, !range)}
        />
        <Menu
          align="end"
          width="190px"
          trigger={(api) => (
            <IconButton
              icon={Icons.More}
              label="Selection actions"
              active={api.open}
              disabled={
                selection.size === 0 ||
                (groups.length === 0 && !tracks && !playlist)
              }
              onClick={() => {
                // Same as the row context menu: the rating vocabulary is
                // fetched as the menu that offers it opens.
                if (!api.open) loadRatings();
                api.toggle();
              }}
            />
          )}
        >
          <RowActionsMenu
            tabId={props.tabId}
            groups={groups}
            trackRows={tracks ? selection : undefined}
            onAddToPlaylist={
              tracks
                ? () => requestAddToPlaylist(props.tabId, selection)
                : undefined
            }
            onRemoveFromPlaylist={
              playlist ? () => removeRows(props.tabId, selection) : undefined
            }
          />
        </Menu>
        <IconButton
          icon={Icons.Close}
          label="Exit multi-select"
          onClick={() => setMultiSelect(props.tabId, false)}
        />
      </div>
    );
  },
);

export default MultiSelectToolbar;
