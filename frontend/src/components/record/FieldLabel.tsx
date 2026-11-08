import {
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { Icons, type IconComponent } from "../../icons";
import type { FormField } from "../../query/recordForm";
import { cx } from "../ui/cx";

/** The pill on the left of every form row: a glyph and the field's name over a
 * tint that says what kind of data it holds. Both are chosen from the field's
 * kind first (a linked record and a list of records read as links, whatever
 * their column type), then its value category. */
export function fieldAppearance(field: FormField): {
  icon: IconComponent;
  tint: string;
} {
  if (field.kind === "multiRecord") {
    return { icon: Icons.FieldRecords, tint: "bg-field-records" };
  }
  if (field.kind === "scalarLink") {
    return { icon: Icons.FieldLink, tint: "bg-field-link" };
  }
  if (field.kind === "contextQuery") {
    return { icon: Icons.FieldQuery, tint: "bg-field-query" };
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

/** How a rename that keeps what was typed came to an end: Enter, Tab, Shift+Tab,
 * or focus going elsewhere. The caller decides where focus goes next. */
export type RenameEnd = "enter" | "tab" | "backTab" | "blur";

/** What a label being renamed does with the name: what the user types as they
 * type it (optional), and the name they settle on — or that they backed out. */
export interface LabelRename {
  onInput?: (name: string) => void;
  onCommit: (name: string, end: RenameEnd) => void;
  onCancel: () => void;
}

/** A field's name, being typed in place in its label. Its own component, so the
 * buffer is seeded from the name, and the field focused with all of it selected,
 * once per rename — ready to be typed over. Escape abandons the edit.
 *
 * It stops the presses, clicks and keys it handles from reaching the label around
 * it, which would otherwise take them as the label's own: focusing itself (and so
 * ending the rename), picking the field up to drag it, or opening it. */
export function LabelNameInput(props: {
  label: string;
  name: string;
  rename: LabelRename;
}): JSX.Element {
  const [buffer, setBuffer] = useState(() => props.name);
  const inputRef = useRef<HTMLInputElement>(null);
  // A key ends the edit; the blur that follows as the field goes away must not
  // end it a second time.
  const done = useRef(false);

  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const finish = (end: RenameEnd | null) => {
    if (done.current) return;
    done.current = true;
    if (end === null) props.rename.onCancel();
    else props.rename.onCommit(buffer, end);
  };

  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <input
      ref={inputRef}
      type="text"
      aria-label={props.label}
      className="text-ink -my-px min-w-0 bg-transparent outline-none select-text [font:inherit]"
      size={Math.max(buffer.length, 4)}
      value={buffer}
      onChange={(e) => {
        setBuffer(e.currentTarget.value);
        props.rename.onInput?.(e.currentTarget.value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish("enter");
        else if (e.key === "Tab") finish(e.shiftKey ? "backTab" : "tab");
        else if (e.key === "Escape") finish(null);
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
      onBlur={() => finish("blur")}
      onPointerDown={stop}
      onMouseDown={stop}
      onClick={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
    />
  );
}

/** A field's label — and the field's handle: it's what the user clicks to select
 * the field, double-clicks to edit or open it, right-clicks for the field's
 * menu, Enter activates (see `onKeyDown`), and what the arrow keys move
 * between. It's always in the tab order (a `tabIndex={0}` `span`, like an
 * `EmbeddedRecord`'s), and focus shows as a blue border — always present but
 * transparent until then, so nothing shifts when it appears — and so does an
 * open context menu, which is the label saying what the menu is about to act
 * on. The browser's own focus outline is suppressed (`outline-none`): without
 * it, a keyboard-driven focus (which also matches `:focus-visible`) stacked a
 * second ring on top of this one, reading as a thicker border than a
 * mouse-driven focus got. Its 2px border trades against its padding to come to
 * the standard control height (see `control` in `app.css`).
 *
 * It's also where the field is picked up to drag it among the others. A field the
 * user has hidden, on show because they asked to see those, reads as dimmed. */
export default function FieldLabel(props: {
  field: FormField;
  itemId: string;
  /** Whether this label's own context menu is open. */
  menuOpen: boolean;
  /** Whether the field is one the user has hidden. */
  hiddenField?: boolean;
  onClick: () => void;
  onDblClick: () => void;
  onFocus: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  onContextMenu: (e: MouseEvent<HTMLElement>) => void;
  onPointerDown?: (e: PointerEvent<HTMLElement>) => void;
  /** Set while the field's name is being typed in place of it. */
  rename?: LabelRename;
}): JSX.Element {
  const look = fieldAppearance(props.field);
  const Icon = look.icon;
  return (
    <span
      data-form-item=""
      data-item-id={props.itemId}
      tabIndex={0}
      // An open menu wears the same blue border real focus would, even once its
      // own focus trap has moved focus onto the menu: the label is what the
      // menu is about to act on. `border-transparent` has to be conditional
      // too, not just layered under `border-accent` in the static class —
      // same-specificity utilities settle by stylesheet order, not DOM order,
      // so a plain `border-accent` class can lose to it outright.
      className={cx(
        `text-ink focus:border-accent flex shrink-0 cursor-default items-center gap-1 rounded-md border-2 px-1.5 py-px text-xs/5 outline-none select-none [-webkit-touch-callout:none] ${look.tint}`,
        {
          "border-accent": props.menuOpen,
          "border-transparent": !props.menuOpen,
          "opacity-60": props.hiddenField,
        },
      )}
      onClick={() => props.onClick()}
      onDoubleClick={() => props.onDblClick()}
      onFocus={() => props.onFocus()}
      onKeyDown={(e) => props.onKeyDown(e)}
      onContextMenu={(e) => props.onContextMenu(e)}
      onPointerDown={props.onPointerDown}
    >
      <Icon className="size-3.5 shrink-0 opacity-70" />
      {props.rename ? (
        <LabelNameInput
          label={`Name of ${props.field.label}`}
          name={props.field.label}
          rename={props.rename}
        />
      ) : (
        <span className="max-w-40 truncate">{props.field.label}</span>
      )}
    </span>
  );
}
