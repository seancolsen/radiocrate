import type { JSX } from "react";
import { Icons } from "../icons";
import type { RecordRef } from "../stores/app";
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
    <>
      {props.records.map((record) => (
        <MenuItem
          key={record.table}
          icon={Icons.Edit}
          label={`Edit ${record.table}`}
          onClick={() => props.onEdit(record)}
        />
      ))}
    </>
  );
}
