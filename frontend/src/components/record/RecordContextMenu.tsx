import type { JSX } from "react";
import { ContextMenu } from "../ui/ContextMenu";
import { MenuItem } from "../ui/Menu";
import { Icons, type IconComponent } from "../../icons";
import {
  isShared,
  selectFieldOf,
  selectIsBulkBlocked,
  selectSharedValue,
  type FormMenu,
  type RecordFormModel,
  type SharedValue,
} from "../../stores/recordForm";
import { useFormState } from "../../stores/react";
import type { FormField } from "../../query/recordForm";

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
  icon: IconComponent;
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

/** The entries the open menu's target calls for — empty when the form has
 * moved on and the target is no longer there. `field`, `blocked` and `value`
 * are that target's, read by the component from the form's state. */
function menuEntries(
  model: RecordFormModel,
  open: FormMenu,
  field: FormField | undefined,
  /** Whether this field is one the form won't modify while it's on several
   * records — every entry that would change it is grayed out. */
  blocked: boolean,
  value: SharedValue,
): Entry[] {
  if (!field) return [];
  const { recordId } = open.target;

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
}

/** The record editor's open context menu, or nothing when none is open.
 * Rendered once, at the form's root. */
export default function RecordContextMenu(props: {
  model: RecordFormModel;
}): JSX.Element | null {
  const { model } = props;
  const open = useFormState(model, (s) => s.menu);
  // The target's field and what the entries depend on, each a narrow read
  // (state management rule 2) — the entries themselves are built in render.
  const field = useFormState(model, (s) =>
    s.menu
      ? selectFieldOf(s, s.menu.target.recordId, s.menu.target.fieldKey)
      : undefined,
  );
  const blocked = useFormState(
    model,
    (s) =>
      s.menu !== null &&
      selectIsBulkBlocked(s, s.menu.target.recordId, s.menu.target.fieldKey),
  );
  const value = useFormState(model, (s): SharedValue => {
    if (!s.menu) return undefined;
    const { recordId, fieldKey } = s.menu.target;
    const target = selectFieldOf(s, recordId, fieldKey);
    return target && target.kind !== "multiRecord"
      ? selectSharedValue(s, recordId, target.column)
      : undefined;
  });

  if (!open) return null;
  const entries = menuEntries(model, open, field, blocked, value);
  return (
    <ContextMenu x={open.x} y={open.y} onClose={() => model.closeMenu()}>
      {entries.map((entry) => (
        <MenuItem
          key={entry.label}
          icon={entry.icon}
          label={entry.label}
          danger={entry.danger}
          disabled={entry.disabled}
          onClick={() => entry.run?.()}
        />
      ))}
    </ContextMenu>
  );
}
