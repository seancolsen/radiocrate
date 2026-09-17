import type { JSX } from "react";
import { Icons } from "../icons";
import type { RecordRef } from "../stores/app";
import { MenuItem, MenuSeparator } from "./ui/Menu";

/** A result row's context-menu body: one "Edit {table}" entry per table whose
 * primary key the row carries in full — a track row joined to its album offers
 * both — over the "Select multiple" entry that turns multi-select mode on.
 *
 * The same body backs the multi-select toolbar's actions menu, which acts on
 * the whole selection; it passes no `onSelectMultiple`, because that mode is
 * already on. A row identifying nothing then leaves the menu with only "Select
 * multiple" to offer, which is still worth raising — that's how a touch device
 * reaches multi-select on results whose rows aren't editable. */
export default function RowActionsMenu(props: {
  records: readonly RecordRef[];
  onEdit: (record: RecordRef) => void;
  /** Omitted when multi-select mode is already on, which hides the entry. */
  onSelectMultiple?: () => void;
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
      {props.onSelectMultiple && (
        <>
          {props.records.length > 0 && <MenuSeparator />}
          <MenuItem
            icon={Icons.SelectMultiple}
            label="Select multiple"
            onClick={props.onSelectMultiple}
          />
        </>
      )}
    </>
  );
}
