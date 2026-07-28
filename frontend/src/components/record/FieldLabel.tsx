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

export default function FieldLabel(props: { field: FormField }) {
  const look = () => appearance(props.field);
  return (
    <span
      class={`text-ink flex h-[22px] shrink-0 items-center gap-1 rounded-md px-1.5 text-xs ${look().tint}`}
    >
      {look().icon({ class: "size-3.5 shrink-0 opacity-70" })}
      <span class="max-w-40 truncate">{props.field.label}</span>
    </span>
  );
}
