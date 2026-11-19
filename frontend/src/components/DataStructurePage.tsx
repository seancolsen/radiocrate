import { useEffect, useMemo, type JSX } from "react";
import { Icons } from "../icons";
import { usesPreset } from "../query/definition";
import { groupPresets, type PresetTableGroup } from "../query/presetGroups";
import {
  TABLES_ITEM,
  countLabel,
  tableItemId,
  tableSummary,
} from "../query/structure";
import { useApp, useAppActions } from "../stores/react";
import PresetDeleteModal from "./PresetDeleteModal";
import { FieldsNode } from "./structure/FieldNodes";
import { PreludeNode } from "./structure/PreludeNode";
import { QuerySettingsNode } from "./structure/PresetNodes";
import { TreeCount, TreeEmpty, TreeName, TreeNode } from "./structure/Tree";
import IconButton from "./ui/IconButton";
import { COUNT_BUBBLE_CLASS } from "./ui/cx";

// The Data structure page: what the database holds and how the app treats it,
// as one tree in one tab.
//
//   Tables
//     <table>              how many rows and columns it has
//       Fields             every field of its record editor form
//         <field>          a column (with its type and statistics), the records
//                          of another table that refer to it, or a contextual
//                          query — the last two opening into their Querydown
//       Query settings
//         Filter presets   the table's saved presets, a list for each section
//         Sorting presets  of a query, each opening into its editor
//         Display presets
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
 * fields and query settings. A
 * table presets were written for that the database no longer has is listed for
 * those presets alone. */
function TableNode(props: { group: PresetTableGroup }): JSX.Element {
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
      <QuerySettingsNode table={table} sections={sections} />
    </TreeNode>
  );
}

/** "Tables": how many there are, Refresh — which reads them and their
 * statistics again, and spins while it does — and the tables. */
function TablesNode(): JSX.Element {
  const presets = useApp((s) => s.presets);
  const unsaved = useApp((s) => s.unsavedPresets);
  const drafts = useApp((s) => s.structure.drafts);
  const listedNames = useApp((s) => s.structure.listedNames);
  const openTabs = useApp((s) => s.tabs);
  const tables = useApp((s) => s.schema.tables);
  const schemaStatus = useApp((s) => s.schema.status);
  const reading = useApp(
    (s) =>
      s.tableSummaries.status === "loading" || s.schema.status === "loading",
  );
  const { refreshStructure } = useAppActions();

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
    return groupPresets(
      [...presets, ...listed],
      tables.map((t) => t.name),
      listedNames,
    );
  }, [presets, unsaved, drafts, openTabs, tables, listedNames]);

  let empty: string | null = null;
  if (groups.length === 0) {
    if (schemaStatus === "loading") empty = "Loading tables…";
    else if (schemaStatus === "error") empty = "The tables couldn't be loaded.";
    else empty = "No tables";
  }

  return (
    <TreeNode
      id={TABLES_ITEM}
      expandable
      label={
        <>
          <Icons.Tables className="text-ink-weak size-4 shrink-0" />
          <TreeName>Tables</TreeName>
          <TreeCount n={groups.length} one="table" many="tables" />
        </>
      }
      actions={
        <IconButton
          icon={Icons.Refresh}
          size="sm"
          label="Refresh"
          iconClassName={reading ? "animate-spin" : undefined}
          onClick={() => refreshStructure()}
        />
      }
    >
      {empty !== null ? (
        <TreeEmpty>{empty}</TreeEmpty>
      ) : (
        groups.map((g) => <TableNode key={g.table} group={g} />)
      )}
    </TreeNode>
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
