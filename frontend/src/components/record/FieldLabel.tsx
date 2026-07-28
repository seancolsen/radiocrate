import type { Component } from "solid-js";
import { Icons } from "../../icons";
import type { FormField } from "../../query/recordForm";

/** The pill on the left of every form row: a glyph and the field's name over a
 * tint that says what kind of data it holds. Both are chosen from the field's
 * kind first (a linked record and a list of records read as links, whatever
 * their column type), then its value category. */
function appearance(field: FormField): {
  icon: Component<{ class?: string }>;
  tint: string;
} {
  if (field.kind === "multiRecord") {
    return { icon: Icons.FieldRecords, tint: "bg-field-records" };
  }
  if (field.kind === "scalarLink") {
    return { icon: Icons.FieldLink, tint: "bg-field-link" };
  }
  switch (field.valueType) {
    case "text":
      return { icon: Icons.FieldText, tint: "bg-field-text" };
    case "number":
      return { icon: Icons.FieldNumber, tint: "bg-field-number" };
    case "uuid":
      return { icon: Icons.FieldId, tint: "bg-field-uuid" };
    case "timestamp":
      return { icon: Icons.FieldTime, tint: "bg-field-other" };
    case "boolean":
      return { icon: Icons.FieldBoolean, tint: "bg-field-other" };
    default:
      return { icon: Icons.FieldOther, tint: "bg-field-other" };
  }
}

/** A field's label — and the field's handle: it's what the user clicks to select
 * the field, double-clicks to edit or open it, and what the keyboard moves
 * between. Focus shows as a blue outline (an outline, not a border, so nothing
 * shifts when it appears).
 *
 * `tabbable` gives the form a single tab stop: the focused item, or the first
 * field while focus is elsewhere. Everything else is reached with the arrow
 * keys, not by tabbing through every field of the record. */
export default function FieldLabel(props: {
  field: FormField;
  itemId: string;
  tabbable: boolean;
  onClick: () => void;
  onDblClick: () => void;
  onFocus: () => void;
}) {
  const look = () => appearance(props.field);
  return (
    <span
      data-form-item=""
      data-item-id={props.itemId}
      tabindex={props.tabbable ? 0 : -1}
      class={`text-ink focus:outline-accent flex h-[22px] shrink-0 cursor-default items-center gap-1 rounded-md px-1.5 text-xs outline-none focus:outline-2 focus:outline-offset-0 ${look().tint}`}
      onClick={() => props.onClick()}
      onDblClick={() => props.onDblClick()}
      onFocus={() => props.onFocus()}
    >
      {look().icon({ class: "size-3.5 shrink-0 opacity-70" })}
      <span class="max-w-40 truncate">{props.field.label}</span>
    </span>
  );
}
