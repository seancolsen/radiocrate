import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { useFieldDrag } from "../gestures/useFieldDrag";
import { Icons } from "../icons";
import { usesPreset } from "../query/definition";
import { groupPresets, type PresetTableGroup } from "../query/presetGroups";
import {
  TABLES_ITEM,
  countLabel,
  tableItemId,
  tableSummary,
} from "../query/structure";
import { isTableHidden, orderTables } from "../query/tableSettings";
import { useApp, useAppActions } from "../stores/react";
import PresetDeleteModal from "./PresetDeleteModal";
import { FieldsNode } from "./structure/FieldNodes";
import { PreludeNode } from "./structure/PreludeNode";
import { QuerySettingsNode } from "./structure/PresetNodes";
import { TreeCount, TreeEmpty, TreeName, TreeNode } from "./structure/Tree";
import { ContextMenu } from "./ui/ContextMenu";
import DragChip, { dragChipTransform } from "./ui/DragChip";
import IconButton from "./ui/IconButton";
import { MenuItem } from "./ui/Menu";
import { COUNT_BUBBLE_CLASS } from "./ui/cx";

// The Data structure page: what the database holds and how the app treats it,
// as one tree in one tab.
//
//   Tables                 in the order the user has dragged them into, less
//                          those they've hidden
//     <table>              how many rows and columns it has
//       Fields             every field of its record editor form
//         <field>          a column (with its type and statistics), the records
//                          of another table that refer to it, or a contextual
//                          query — the last two opening into their Querydown
//       Query settings
//         Filter presets   the table's saved presets, a list for each section
//         Sorting presets  of a query, each opening into its editor
//         Display presets
//         Text search      the table's prelude settings, each opening into
//         Linked record    its expression's editor
//           comparison
//         Record picker    the sorting and display the record picker on the
//                          table opens with
//   Querydown prelude      the prelude's editor
//
// The Settings menu's "Data structure", the `presets.manage` command, a
// builder section menu's "Manage presets" and an error strip's "Edit prelude"
// open the tab, the last two at what they're about. Which items are open, and
// the new presets being written, live in the app store's `structure`; which
// are open is remembered across reloads.
//
// A row whose item has others under it sticks to the top of the page while
// they're scrolled, under the rows of the items it's within, so what's on
// screen always says where in the tree it is. The keyboard moves between rows
// as it does in any tree (see `structure/Tree.tsx`).
//
// The numbers come from `table.summarize`, read as the page opens and again on
// Refresh: DuckDB's `SUMMARIZE` of every table, in one call.

/** One table: its name and size — "12,509 rows × 7 columns", each count in a
 * bubble, as the counts of what's under other rows are — and under it its
 * fields and query settings. A table presets were written for that the
 * database no longer has is listed for those presets alone. A table the user
 * has hidden, listed because they've asked to see those, is faded. */
function TableNode(props: {
  group: PresetTableGroup;
  hidden: boolean;
  dragging: boolean;
  onPointerDown: (e: PointerEvent<HTMLElement>) => void;
  onContextMenu: (e: MouseEvent<HTMLElement>) => void;
}): JSX.Element {
  const { table, sections } = props.group;
  const columns = useApp(
    (s) => s.schema.tables.find((t) => t.name === table)?.columns.length,
  );
  const rowCount = useApp(
    (s) => tableSummary(s.tableSummaries.data, table)?.rowCount,
  );
  return (
    <TreeNode
      id={tableItemId(table)}
      expandable
      dimmed={props.hidden}
      dragging={props.dragging}
      onPointerDown={props.onPointerDown}
      onContextMenu={props.onContextMenu}
      label={
        <>
          <Icons.Table className="text-ink-weak size-4 shrink-0" />
          <TreeName>{table}</TreeName>
          {rowCount !== undefined && (
            <>
              <span className={COUNT_BUBBLE_CLASS}>
                {countLabel(rowCount, "row", "rows")}
              </span>
              {columns !== undefined && (
                <span className="text-ink-weak shrink-0 text-xs">×</span>
              )}
            </>
          )}
          {columns !== undefined && (
            <span className={COUNT_BUBBLE_CLASS}>
              {countLabel(columns, "column", "columns")}
            </span>
          )}
        </>
      }
    >
      {columns !== undefined && <FieldsNode table={table} />}
      <QuerySettingsNode
        table={table}
        sections={sections}
        inSchema={columns !== undefined}
      />
    </TreeNode>
  );
}

/** "Tables": how many are listed, Refresh — which reads them and their
 * statistics again, and spins while it does — the toggle that lists the hidden
 * ones too (while there are any), and the tables, in the order the user has
 * dragged them into. A table's context menu hides it from every list of
 * tables, or brings it back; on a touch screen, holding it raises the menu. */
function TablesNode(): JSX.Element {
  const presets = useApp((s) => s.presets);
  const unsaved = useApp((s) => s.unsavedPresets);
  const drafts = useApp((s) => s.structure.drafts);
  const listedNames = useApp((s) => s.structure.listedNames);
  const openTabs = useApp((s) => s.tabs);
  const tables = useApp((s) => s.schema.tables);
  const schemaStatus = useApp((s) => s.schema.status);
  const settings = useApp((s) => s.tableSettings.data);
  const showHidden = useApp((s) => s.showHiddenTables);
  const reading = useApp(
    (s) =>
      s.tableSummaries.status === "loading" || s.schema.status === "loading",
  );
  const { refreshStructure, setTableHidden, setShowHiddenTables, moveTable } =
    useAppActions();

  const groups = useMemo(() => {
    // An unsaved preset is here as long as it's being written, here or in a
    // query.
    const listed = unsaved.filter(
      (p) =>
        drafts.includes(p.id) ||
        openTabs.some(
          (t) =>
            (t.kind === "query" || t.kind === "playlist") &&
            usesPreset(t.live, p.id),
        ),
    );
    return orderTables(
      groupPresets(
        [...presets, ...listed],
        tables.map((t) => t.name),
        listedNames,
      ),
      (g) => g.table,
      settings,
    );
  }, [presets, unsaved, drafts, openTabs, tables, listedNames, settings]);
  const hiddenCount = useMemo(
    () => groups.filter((g) => isTableHidden(settings, g.table)).length,
    [groups, settings],
  );
  const shown = useMemo(
    () =>
      showHidden
        ? groups
        : groups.filter((g) => !isTableHidden(settings, g.table)),
    [groups, settings, showHidden],
  );

  // The table whose context menu is up.
  const [menu, setMenu] = useState<{
    table: string;
    x: number;
    y: number;
  } | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const dnd = useFieldDrag({
    listRef,
    keys: shown.map((g) => g.table),
    rowAttribute: "data-drag-row",
    onDrop: (table, target) =>
      moveTable(
        groups.map((g) => g.table),
        table,
        target.above,
        target.below,
      ),
    onHold: (table, x, y) => setMenu({ table, x, y }),
  });
  const drag = dnd.drag;

  let empty: string | null = null;
  if (groups.length === 0) {
    if (schemaStatus === "loading") empty = "Loading tables…";
    else if (schemaStatus === "error") empty = "The tables couldn't be loaded.";
    else empty = "No tables";
  } else if (shown.length === 0) {
    empty = "Every table is hidden";
  }

  return (
    <>
      <TreeNode
        id={TABLES_ITEM}
        expandable
        label={
          <>
            <Icons.Tables className="text-ink-weak size-4 shrink-0" />
            <TreeName>Tables</TreeName>
            <TreeCount n={shown.length} one="table" many="tables" />
          </>
        }
        actions={
          <>
            <IconButton
              icon={Icons.Refresh}
              size="sm"
              label="Refresh"
              iconClassName={reading ? "animate-spin" : undefined}
              onClick={() => refreshStructure()}
            />
            {hiddenCount > 0 && (
              <IconButton
                icon={Icons.Show}
                size="sm"
                label="Show hidden tables"
                pressed={showHidden}
                onClick={() => setShowHiddenTables(!showHidden)}
              />
            )}
          </>
        }
      >
        {empty !== null ? (
          <TreeEmpty>{empty}</TreeEmpty>
        ) : (
          <div ref={listRef} className="relative">
            {shown.map((g) => (
              <TableNode
                key={g.table}
                group={g}
                hidden={isTableHidden(settings, g.table)}
                dragging={drag?.item === g.table}
                onPointerDown={(e) => dnd.onPointerDown(e, g.table)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  // A touch resting on the row raises the menu as it lets go,
                  // unless it picks the table up instead.
                  if (dnd.pressing()) return;
                  // The menu key raises it with no pointer to place it by.
                  const at = e.currentTarget.getBoundingClientRect();
                  const keyed = e.clientX === 0 && e.clientY === 0;
                  setMenu({
                    table: g.table,
                    x: keyed ? at.left + 24 : e.clientX,
                    y: keyed ? at.bottom : e.clientY,
                  });
                }}
              />
            ))}
            {drag?.target && (
              // Over the rows, which stick, and so are layered.
              <div
                aria-hidden="true"
                className="bg-accent pointer-events-none absolute right-1 left-5 z-[7] h-0.5 -translate-y-1/2 rounded-full"
                style={{ top: drag.lineTop }}
              />
            )}
            {drag &&
              createPortal(
                <DragChip
                  icon={Icons.Table}
                  label={drag.item}
                  style={{ transform: dragChipTransform(drag.x, drag.y) }}
                />,
                document.body,
              )}
          </div>
        )}
      </TreeNode>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {isTableHidden(settings, menu.table) ? (
            <MenuItem
              icon={Icons.Show}
              label="Un-hide table"
              onClick={() => setTableHidden(menu.table, false)}
            />
          ) : (
            <MenuItem
              icon={Icons.Hide}
              label="Hide table"
              onClick={() => setTableHidden(menu.table, true)}
            />
          )}
        </ContextMenu>
      )}
    </>
  );
}

/** The Data structure tab's page. */
export default function DataStructurePage(): JSX.Element {
  const { ensureTableSummaries } = useAppActions();
  // The statistics are read as the page first shows; after that, on Refresh.
  useEffect(() => ensureTableSummaries(), [ensureTableSummaries]);

  return (
    <>
      {/* The tree takes the whole page and scrolls within it. */}
      <div
        data-testid="data-structure"
        className="bg-panel min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-3 pb-3"
      >
        <div role="tree" aria-label="Data structure" className="pt-2">
          <TablesNode />
          <PreludeNode />
        </div>
      </div>

      <PresetDeleteModal />
    </>
  );
}
