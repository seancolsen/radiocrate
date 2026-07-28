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
 * the field, double-clicks to edit or open it, right-clicks for the field's
 * menu, Enter activates (see `onKeyDown`), and what the arrow keys move
 * between. It's always in the tab order (a `tabindex="0"` `span`, like an
 * `EmbeddedRecord`'s), and focus shows as a blue border — always present but
 * transparent until then, so nothing shifts when it appears — and so does an
 * open context menu, which is the label saying what the menu is about to act
 * on. The browser's own focus outline is suppressed (`outline-none`): without
 * it, a keyboard-driven focus (which also matches `:focus-visible`) stacked a
 * second ring on top of this one, reading as a thicker border than a
 * mouse-driven focus got. */
export default function FieldLabel(props: {
  field: FormField;
  itemId: string;
  /** Whether this label's own context menu is open. */
  menuOpen: boolean;
  onClick: () => void;
  onDblClick: () => void;
  onFocus: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
  onContextMenu: (e: MouseEvent) => void;
}) {
  const look = () => appearance(props.field);
  return (
    <span
      data-form-item=""
      data-item-id={props.itemId}
      tabindex={0}
      class={`text-ink focus:border-accent flex h-[22px] shrink-0 cursor-default items-center gap-1 rounded-md border-2 px-1.5 text-xs outline-none select-none ${look().tint}`}
      // An open menu wears the same blue border real focus would, even once its
      // own focus trap has moved focus onto the menu: the label is what the
      // menu is about to act on. `border-transparent` has to be conditional
      // too, not just layered under `border-accent` in the static class —
      // same-specificity utilities settle by stylesheet order, not DOM order,
      // so a plain `border-accent` class can lose to it outright.
      classList={{
        "border-accent": props.menuOpen,
        "border-transparent": !props.menuOpen,
      }}
      onClick={() => props.onClick()}
      onDblClick={() => props.onDblClick()}
      onFocus={() => props.onFocus()}
      onKeyDown={(e) => props.onKeyDown(e)}
      onContextMenu={(e) => props.onContextMenu(e)}
    >
      {look().icon({ class: "size-3.5 shrink-0 opacity-70" })}
      <span class="max-w-40 truncate">{props.field.label}</span>
    </span>
  );
}
