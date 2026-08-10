import { For, Show, type Component } from "solid-js";
import { ContextMenu } from "../ui/ContextMenu";
import { MenuItem } from "../ui/Menu";
import { Icons } from "../../icons";
import { isShared, type RecordFormModel } from "./formModel";

// The form's context menus — one component for all of them, because only one is
// ever open and the model already knows what it was raised on.
//
// Which entries appear follows the target (spec: "Interactions"): a field offers
// what its *kind* can do, an embedded record offers what can be done to the
// record it previews. Every action here is ephemeral, like every other form
// modification — nothing reaches the database until the form is saved.
//
// An entry the form can't carry out across several records at once is shown
// grayed rather than dropped, so the menu says the same things wherever it's
// raised and the gap is visibly the feature's, not the field's.

/** One row of the menu. */
interface Entry {
  icon: Component<{ class?: string }>;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  run?: () => void;
}

/** Puts a field's current value on the clipboard. Best-effort: a browser that
 * refuses (no permission, no secure context) leaves the form alone. */
function copyValue(text: string): void {
  void navigator.clipboard
    ?.writeText(text)
    .catch((err) => console.error("copy failed", err));
}

/** The record editor's open context menu, or nothing when none is open.
 * Rendered once, at the form's root. */
export default function RecordContextMenu(props: { model: RecordFormModel }) {
  /** The entries the open menu's target calls for — empty when the form has
   * moved on and the target is no longer there. */
  const entries = (): Entry[] => {
    const model = props.model;
    const open = model.menu();
    if (!open) return [];
    const { recordId, fieldKey } = open.target;
    const field = model
      .record(recordId)
      ?.fields.find((f) => f.key === fieldKey);
    if (!field) return [];

    /** Whether this field is one the form won't modify while it's on several
     * records — every entry that would change it is grayed out. */
    const blocked = model.isBulkBlocked(recordId, fieldKey);

    const clear: Entry = {
      icon: Icons.Clear,
      label: "Clear",
      disabled: blocked,
      run: () => model.clearField(recordId, field),
    };

    if (open.target.kind === "childRecords" && field.kind === "multiRecord") {
      const ids = open.target.ids;
      return [
        {
          icon: Icons.Delete,
          danger: true,
          label: ids.length > 1 ? `Delete ${ids.length} records` : "Delete",
          run: () => model.removeChildren(recordId, field, ids),
        },
      ];
    }
    // The embedded record of a scalar linked record field: all that can be done
    // to it is to stop pointing at it.
    if (open.target.kind === "scalarEmbed") return [clear];

    if (field.kind === "multiRecord") {
      return [
        {
          icon: Icons.Add,
          label: "New record",
          disabled: blocked,
          run: () => model.addChild(recordId, field),
        },
        {
          icon: Icons.Delete,
          danger: true,
          label: "Delete all records",
          disabled: blocked,
          run: () => model.clearField(recordId, field),
        },
      ];
    }
    if (field.kind === "scalarLink") {
      return [
        {
          icon: Icons.Query,
          label: "Pick a record",
          disabled: blocked,
          run: () => model.openPicker(recordId, field.key),
        },
        {
          icon: Icons.Add,
          label: "Enter a new record",
          disabled: blocked,
          run: () => model.addLinkedRecord(recordId, field),
        },
        clear,
      ];
    }
    // A value the records disagree on is no one value to put on the clipboard.
    const value = model.value(recordId, field.column);
    const copy: Entry = {
      icon: Icons.Duplicate,
      label: "Copy",
      disabled: !isShared(value),
      run: () => copyValue(isShared(value) ? (value ?? "") : ""),
    };
    // A primary key is issued by the database, not the user — nothing here
    // offers to change it, only to read it.
    if (field.kind === "primitive" && field.readOnly) return [copy];
    return [
      {
        icon: Icons.Edit,
        label: "Edit",
        disabled: blocked,
        run: () => model.beginEdit(recordId, field.key),
      },
      clear,
      copy,
    ];
  };

  return (
    <Show when={props.model.menu()}>
      {(open) => (
        <ContextMenu
          x={open().x}
          y={open().y}
          onClose={() => props.model.closeMenu()}
        >
          <For each={entries()}>
            {(entry) => (
              <MenuItem
                icon={entry.icon}
                label={entry.label}
                danger={entry.danger}
                disabled={entry.disabled}
                onClick={() => entry.run?.()}
              />
            )}
          </For>
        </ContextMenu>
      )}
    </Show>
  );
}
