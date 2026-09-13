import type { JSX } from "react";
import { Icons } from "../icons";
import { selectIsFullQuery, selectQueryTab } from "../stores/app";
import { useApp, useAppActions } from "../stores/react";
import {
  MenuNote,
  MenuSeparator,
  MenuSubmenu,
  MenuToggleItem,
} from "./ui/Menu";

/** The wrench menu's "Base ▸" submenu: every table in the schema as an exclusive
 * choice of what the query is built on, then — below a separator — the "Full
 * Querydown" escape hatch, which flattens the query into one hand-written
 * Querydown query.
 *
 * The two halves are one radio group on purpose: a full-mode query has no base
 * table (nothing above is checked), and picking a table is how it comes back to
 * the builder. Switching base keeps the filter the user typed and reseeds the
 * rest from the new table's defaults — see `setBase`. */
export default function BaseSubmenu(props: { tabId: string }): JSX.Element {
  const tables = useApp((s) => s.schema.tables);
  const base = useApp(
    (s) => selectQueryTab(s, props.tabId)?.live.base.trim() ?? "",
  );
  const fullMode = useApp((s) => selectIsFullQuery(s, props.tabId));
  const { setBase, convertToFull } = useAppActions();

  return (
    <MenuSubmenu icon={Icons.Base} label="Base">
      {tables.length > 0 ? (
        tables.map((table) => (
          <MenuToggleItem
            key={table.name}
            kind="radio"
            icon={Icons.Table}
            label={table.name}
            checked={!fullMode && table.name === base}
            onClick={() => setBase(props.tabId, table.name)}
          />
        ))
      ) : (
        <MenuNote text="Loading schema…" />
      )}
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
