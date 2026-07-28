import { For, Show, type Component } from "solid-js";
import { ContextMenu } from "../ui/ContextMenu";
import { MenuItem } from "../ui/Menu";
import { Icons } from "../../icons";
import type { RecordFormModel } from "./formModel";

// The form's context menus — one component for all of them, because only one is
// ever open and the model already knows what it was raised on.
//
// Which entries appear follows the target (spec: "Interactions"): a field offers
// what its *kind* can do, an embedded record offers what can be done to the
// record it previews. Every action here is ephemeral, like every other form
// modification — nothing reaches the database until the form is saved.

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

    const clear: Entry = {
      icon: Icons.Clear,
      label: "Clear",
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
          run: () => model.addChild(recordId, field),
        },
        {
          icon: Icons.Delete,
          danger: true,
          label: "Delete all records",
          run: () => model.clearField(recordId, field),
        },
      ];
    }
    if (field.kind === "scalarLink") {
      return [
        // The modal record picker is still to be built; the entry is here, inert,
        // so the menu reads as the spec's.
        { icon: Icons.Query, label: "Pick a record", disabled: true },
        {
          icon: Icons.Add,
          label: "Enter a new record",
          run: () => model.addLinkedRecord(recordId, field),
        },
        clear,
      ];
    }
    return [
      {
        icon: Icons.Edit,
        label: "Edit",
        run: () => model.beginEdit(recordId, field.key),
      },
      clear,
      {
        icon: Icons.Duplicate,
        label: "Copy",
        run: () =>
          copyValue(model.record(recordId)?.values[field.column] ?? ""),
      },
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
