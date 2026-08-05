import { For, type JSX } from "solid-js";
import { Icons } from "../icons";
import type { RecordRef } from "../state/store";
import { MenuItem } from "./ui/Menu";

/** A result row's context-menu body: one "Edit {table}" entry per table whose
 * primary key the row carries in full — a track row joined to its album offers
 * both. A row that identifies nothing has no menu at all (its owner doesn't
 * raise one), so this is never empty in practice. */
export default function RowActionsMenu(props: {
  records: readonly RecordRef[];
  onEdit: (record: RecordRef) => void;
}): JSX.Element {
  return (
    <For each={props.records}>
      {(record) => (
        <MenuItem
          icon={Icons.Edit}
          label={`Edit ${record.table}`}
          onClick={() => props.onEdit(record)}
        />
      )}
    </For>
  );
}
