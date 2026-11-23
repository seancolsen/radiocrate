import { useMemo, type JSX } from "react";
import { Icons } from "../icons";
import { tableLabel, type SchemaTable } from "../query/schema";
import { groupBySchema, listedTables } from "../query/tableSettings";
import { selectIsFullQuery, selectQueryTab } from "../stores/app";
import { useApp, useAppActions } from "../stores/react";
import {
  MenuNote,
  MenuSeparator,
  MenuSubmenu,
  MenuToggleItem,
} from "./ui/Menu";

/** The wrench menu's "Base ▸" submenu: every table in the database the user
 * hasn't hidden, in the order they've arranged them, as an exclusive choice of
 * what the query is built on, then — below a separator — the "Full
 * Querydown" escape hatch, which flattens the query into one hand-written
 * Querydown query.
 *
 * The two halves are one radio group on purpose: a full-mode query has no base
 * table (nothing above is checked), and picking a table is how it comes back to
 * the builder. Switching base keeps the filter the user typed and reseeds the
 * rest from the new table's defaults — see `setBase`. */
export default function BaseSubmenu(props: { tabId: string }): JSX.Element {
  const tables = useApp((s) => s.schema.allTables);
  const base = useApp(
    (s) => selectQueryTab(s, props.tabId)?.live.base.trim() ?? "",
  );
  const fullMode = useApp((s) => selectIsFullQuery(s, props.tabId));
  const settings = useApp((s) => s.tableSettings.data);
  const { setBase, convertToFull } = useAppActions();
  // A hidden base is still listed, checked, while the query is on it.
  const listed = useMemo(
    () => listedTables(tables, settings, { keep: fullMode ? null : base }),
    [tables, settings, fullMode, base],
  );

  return (
    <MenuSubmenu icon={Icons.Base} label="Base">
      <BaseTableItems
        tables={listed}
        base={fullMode ? null : base}
        onChoose={(table) => setBase(props.tabId, table)}
      />
      <MenuSeparator />
      <MenuToggleItem
        kind="radio"
        icon={Icons.Querydown}
        label="Full Querydown"
        checked={fullMode}
        onClick={() => convertToFull(props.tabId)}
      />
    </MenuSubmenu>
  );
}

/** A menu's rows for choosing a query's base table: one radio per table in
 * `tables`, `base` checked — or none, for null — and a note while the schema is
 * still loading. The current schema's tables come first, then a submenu for
 * each other schema, named for it, its tables named there alone. The
 * wrench menu's "Base ▸" lists them, and so does a contextual query's "Base
 * table" button (`FieldQueryEditor`). */
export function BaseTableItems(props: {
  tables: readonly SchemaTable[];
  base: string | null;
  onChoose: (table: string) => void;
}): JSX.Element {
  if (props.tables.length === 0) return <MenuNote text="Loading schema…" />;
  const item = (table: SchemaTable) => (
    <MenuToggleItem
      key={table.name}
      kind="radio"
      icon={Icons.Table}
      label={tableLabel(table.name)}
      checked={table.name === props.base}
      onClick={() => props.onChoose(table.name)}
    />
  );
  return (
    <>
      {groupBySchema(props.tables, (t) => t.name).map((group, i) =>
        i === 0 ? (
          group.items.map(item)
        ) : (
          <MenuSubmenu
            key={group.schema}
            icon={Icons.Tables}
            label={group.schema}
          >
            {group.items.map(item)}
          </MenuSubmenu>
        ),
      )}
    </>
  );
}
