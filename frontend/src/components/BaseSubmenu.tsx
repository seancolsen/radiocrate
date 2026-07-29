import { For, Show, type JSX } from "solid-js";
import { Icons } from "../icons";
import { useAppState } from "../state/store";
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
 * rest from the new table's defaults — see `store.setBase`. */
export default function BaseSubmenu(props: { tabId: string }): JSX.Element {
  const store = useAppState();
  const live = () => store.queryTab(props.tabId)?.live;
  const fullMode = () => store.isFullQuery(props.tabId);
  const base = () => live()?.base.trim() ?? "";

  return (
    <MenuSubmenu icon={Icons.Base} label="Base">
      <Show
        when={store.schemaTables().length > 0}
        fallback={<MenuNote text="Loading schema…" />}
      >
        <For each={store.schemaTables()}>
          {(table) => (
            <MenuToggleItem
              kind="radio"
              icon={Icons.Table}
              label={table.name}
              checked={!fullMode() && table.name === base()}
              onClick={() => store.setBase(props.tabId, table.name)}
            />
          )}
        </For>
      </Show>
      <MenuSeparator />
      <MenuToggleItem
        kind="radio"
        icon={Icons.Querydown}
        label="Full Querydown"
        checked={fullMode()}
        onClick={() => store.convertToFull(props.tabId)}
      />
    </MenuSubmenu>
  );
}
