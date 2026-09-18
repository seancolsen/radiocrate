import { forwardRef, useMemo } from "react";
import { Icons } from "../icons";
import {
  recordsForRows,
  selectRatings,
  selectRatingsLoading,
  selectRowSelection,
  selectTableRecordsForRows,
} from "../stores/app";
import { useApp, useAppActions, useStores } from "../stores/react";
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
 * it, and the way out of the mode.
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
    const stores = useStores();
    const {
      loadRatings,
      rateTracks,
      setMultiSelect,
      setRecordEditorRecords,
      showChildRecords,
    } = useAppActions();
    // Three references already in state, combined here rather than through a
    // selector that would build a fresh array on every store write (state
    // management rule 2).
    const selection = useApp((s) => selectRowSelection(s, props.tabId));
    const result = useApp((s) => s.pages[props.tabId]?.result);
    const lineage = useApp((s) => s.pages[props.tabId]?.lineage);
    const records = useMemo(
      () => recordsForRows(result, lineage, selection),
      [result, lineage, selection],
    );
    const ratings = useApp(selectRatings);
    const ratingsLoading = useApp(selectRatingsLoading);

    return (
      <div
        ref={ref}
        data-testid="multi-select-toolbar"
        className="bg-panel border-edge absolute flex items-center gap-1 rounded-md border py-1 pr-1 pl-2.5 shadow-lg"
        style={{ top: MULTI_SELECT_INSET, right: MULTI_SELECT_INSET }}
      >
        <span className="text-ink-weak text-xs whitespace-nowrap">
          {selectionLabel(selection.size)}
        </span>
        <Menu
          align="end"
          width="190px"
          trigger={(api) => (
            <IconButton
              icon={Icons.More}
              label="Selection actions"
              active={api.open}
              disabled={records.length === 0}
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
            records={records}
            onEdit={(record) =>
              setRecordEditorRecords(
                props.tabId,
                record.table,
                selectTableRecordsForRows(
                  stores.app.store.getState(),
                  props.tabId,
                  selection,
                  record.table,
                ),
              )
            }
            onShowTracks={() =>
              showChildRecords(
                props.tabId,
                "album",
                selectTableRecordsForRows(
                  stores.app.store.getState(),
                  props.tabId,
                  selection,
                  "album",
                ),
                "track",
              )
            }
            ratings={ratings}
            ratingsLoading={ratingsLoading}
            onRate={(ratingId) =>
              rateTracks(
                props.tabId,
                selectTableRecordsForRows(
                  stores.app.store.getState(),
                  props.tabId,
                  selection,
                  "track",
                ),
                ratingId,
              )
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
