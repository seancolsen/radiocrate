import {
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { Icons } from "../../icons";
import IconButton from "../ui/IconButton";
import { cx } from "../ui/cx";
import { useResizeObserver } from "../ui/useElementWidth";
import { VARIED, type SharedValue } from "../../record/formValues";
import type { PrimitiveField, ScalarLinkField } from "../../query/recordForm";

/** Where focus goes when an activated field leaves edit mode: back to this
 * field's own label, to the next item's, to the previous one's, or nowhere (the
 * user clicked elsewhere, and that's where they want to be). */
export type EditExit = "self" | "next" | "previous" | "none";

/** An editable value, in view mode and edit mode alike: one text box for the
 * field's whole life, so a selection the user drags out as they click into it
 * survives entering edit mode, rather than dying with an element being swapped
 * for another.
 *
 * Focus and edit mode go together. In view mode it's `readOnly` and out of the
 * tab order (`tabIndex={-1}` — the field's *label* is what Tab and the arrow keys
 * stop on), but a click still focuses it, which begins the edit right on the
 * mouse press — before the browser places the caret and the drag extends it.
 * Coming the other way, an edit begun from anywhere else (Enter on the label, a
 * Tab from another field's editor) pulls focus in, landing the caret at the end
 * or, Tabbed in, selecting the value whole — see `selectAll`.
 *
 * In edit mode, and when expanded, it grows to fit its content rather than
 * scrolling. Collapsed, it holds one line that never wraps: line breaks read as
 * spaces — one for one, so an offset into what it shows is an offset into the
 * value — and, since a textarea has no `text-overflow`, a value cut off wears an
 * ellipsis drawn over its end.
 *
 * Keys: Esc leaves edit mode and goes back to the label. Tab and Shift+Tab do
 * the same, but also begin editing the next or previous field (see
 * `RecordFields.tsx`'s `commit`). Enter leaves edit mode too, *unless* the
 * value already holds a line break, in which case it adds another — a text
 * field the user is already writing multiple lines into keeps taking them;
 * every other field (and a text field still on its first line) reads Enter as
 * "done," and Shift+Enter is what starts a new line from there. Every one of
 * them keeps what was typed — the form holds it until the user saves.
 *
 * The form doesn't wait for any of them, though: `onInput` writes each keystroke
 * through to the form as it happens, so `text` (and the star marking the value
 * modified) tracks the typing. */
export function ValueInput(props: {
  /** The value, as the form holds it right now. */
  text: string;
  /** The field's name, which is what the box is announced as. */
  label: string;
  editing: boolean;
  expanded: boolean;
  /** Whether Enter inserts a newline rather than ending the edit, when the
   * value already has one — see `onKeyDown`. */
  multiline: boolean;
  /** Whether the value is a number, which brings up a phone's number pad rather
   * than its full keyboard. */
  numeric?: boolean;
  /** Whether an edit that pulls focus in should select the value whole, rather
   * than place the caret at its end — set when edit mode was entered by Tabbing
   * in from another field's editor. */
  selectAll: boolean;
  /** The text's color and font, for a value that doesn't read as prose. */
  tone?: string;
  onBeginEdit: () => void;
  onInput: (text: string) => void;
  onCommit: (text: string, exit: EditExit) => void;
  onContextMenu?: (e: MouseEvent<HTMLElement>) => void;
  onOverflow?: (overflowing: boolean) => void;
}): JSX.Element {
  const { text, editing, selectAll, onOverflow } = props;
  const tone = props.tone ?? "text-ink";
  const ref = useRef<HTMLTextAreaElement>(null);
  const [cutOff, setCutOff] = useState(false);
  /** Whether the box is showing all of the value, rather than its one line. */
  const whole = editing || props.expanded;

  // Runs again whenever the text or the mode changes, as well as with the width.
  // What's measured of the one line stands while the box is showing all of it,
  // when there's no line to measure.
  useResizeObserver(ref, (el) => {
    if (whole) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
      return;
    }
    el.style.height = "";
    el.scrollLeft = 0;
    el.scrollTop = 0;
    const overflowing = el.scrollWidth > el.clientWidth + 1;
    setCutOff(overflowing);
    onOverflow?.(overflowing || /\r?\n/.test(text));
  });

  // A layout effect, not a passive one: the form's blur and `relatedTarget`
  // handling depends on focus having moved here as edit mode begins, before
  // anything else runs. Already focused means the user clicked in, and the
  // caret is theirs to place.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !editing || document.activeElement === el) return;
    el.focus();
    if (selectAll) el.select();
    else el.setSelectionRange(el.value.length, el.value.length);
  }, [editing, selectAll]);

  /** Escape and Tab always end the edit — Tab keeps moving through the form's
   * editors (see `RecordFields.tsx`'s `commit`). Enter's behavior depends on
   * whether there's already a line break in the value: a text field the user
   * is already writing multiple lines into gets another one, so real prose
   * stays easy to keep editing; anything else — including a text field that's
   * still one line — treats Enter as "done" the way every other field kind
   * does, and Shift+Enter is what starts a new line from there. */
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!editing) return;
    const exit: EditExit | undefined =
      e.key === "Escape"
        ? "self"
        : e.key === "Enter" &&
            !e.shiftKey &&
            !(props.multiline && text.includes("\n"))
          ? "self"
          : e.key === "Tab"
            ? e.shiftKey
              ? "previous"
              : "next"
            : undefined;
    if (!exit) return;
    e.preventDefault();
    e.stopPropagation();
    props.onCommit(text, exit);
  };

  return (
    <div className="relative min-w-0 flex-1">
      <textarea
        ref={ref}
        rows={1}
        tabIndex={-1}
        readOnly={!editing}
        spellCheck={false}
        // A textarea has no `type=number`; `inputMode` is what picks the phone's
        // keyboard (decimal, so a DECIMAL/DOUBLE column can take its point).
        inputMode={props.numeric ? "decimal" : undefined}
        aria-label={props.label}
        className={cx(
          `control block w-full resize-none overflow-hidden rounded outline-none ${tone}`,
          { "border-accent bg-panel": editing, "whitespace-nowrap": !whole },
        )}
        value={
          whole ? text : text.replace(/\r?\n/g, (n) => " ".repeat(n.length))
        }
        onChange={(e) => props.onInput(e.currentTarget.value)}
        onKeyDown={onKeyDown}
        // Only the primary button is a way in. Any other press would take focus
        // and so begin an edit on its way to, say, the context menu.
        onMouseDown={(e) => {
          if (!editing && e.button !== 0) e.preventDefault();
        }}
        onFocus={() => {
          if (!editing) props.onBeginEdit();
        }}
        // Clicking outside the box (or tabbing away) puts the field back into view
        // mode, keeping what was typed. An edit that has already ended is what
        // moved focus away, and there's nothing left to do.
        onBlur={() => {
          if (editing) props.onCommit(text, "none");
        }}
        onContextMenu={editing ? undefined : props.onContextMenu}
      />
      {!whole && cutOff && (
        <span
          aria-hidden
          className={`bg-panel pointer-events-none absolute top-[3px] right-px pr-1 pl-0.5 text-sm/5 ${tone}`}
        >
          …
        </span>
      )}
    </div>
  );
}

/** What a field shows when the records the form is on don't agree on it: how
 * many different things they say, rather than any one of them. There is nothing
 * here to edit — typing into it would flatten differences the user can't see —
 * so the field expands instead, into those values one by one
 * (`RecordFields.tsx`'s `DistinctValues`), each of which can be edited where it
 * stands or taken for every record. */
export function VariedValue(props: { distinct: number }): JSX.Element {
  return (
    <span className="control text-ink-weak cursor-default italic">
      {props.distinct} distinct {props.distinct === 1 ? "value" : "values"}
    </span>
  );
}

/** The collapsed rendering of a filled value that can't be edited: one line,
 * truncated.
 *
 * Watches itself for truncation, in both directions: the text can change under
 * a fixed width (a load, an edit) and the width can change under fixed text
 * (the sidebar being dragged). A value with a linebreak in it never fits on one
 * line, whatever the width. The effect re-runs when the text does, and the
 * observer covers the width. */
export function OneLineValue(props: {
  text: string;
  className: string;
  onContextMenu?: (e: MouseEvent<HTMLElement>) => void;
  onOverflow?: (overflowing: boolean) => void;
}): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  const { text, onOverflow } = props;
  useResizeObserver(ref, (el) =>
    onOverflow?.(el.scrollWidth > el.clientWidth + 1 || /\r?\n/.test(text)),
  );

  return (
    <span
      ref={ref}
      className={props.className}
      onContextMenu={(e) => props.onContextMenu?.(e)}
    >
      {text.replace(/\s*\r?\n\s*/g, " ")}
    </span>
  );
}

/** The value half of a form row, in whichever of its four states applies:
 *
 *  - **unknown** — nothing has loaded for this field yet, so nothing renders
 *    (not even the pencil): the form shows its labels while the data is on its
 *    way, and only the key values it already had.
 *  - **varied** — the records the form is on hold different values here, so
 *    there is no value to show: how many different ones there are stands in for
 *    it, and the row expands into them (see {@link VariedValue}).
 *  - **empty** — NULL or the empty string, so there's nothing to click: a pencil
 *    button activates an empty input instead.
 *  - **filled** — the value, on one line (newlines become spaces, overflow
 *    ellipsizes) unless it's expanded text, which wraps and keeps its linebreaks.
 *    Always in its text box, {@link ValueInput} — clicking into it is what
 *    activates it — unless it's a primary key, which is only ever text to read.
 *
 * `onOverflow` reports whether the collapsed single line is actually cut off —
 * what decides whether the row gets an expansion toggle at all. */
export default function FieldValue(props: {
  field: PrimitiveField | ScalarLinkField;
  /** `undefined` until loaded; `null` for a NULL the records share; `VARIED`
   * for a column they differ on. */
  value: SharedValue;
  editing: boolean;
  /** Whether entering edit mode should select the value whole — see
   * `ValueInput`. */
  editingSelectAll: boolean;
  expanded: boolean;
  onBeginEdit: () => void;
  onInput: (text: string) => void;
  onCommit: (text: string, exit: EditExit) => void;
  onContextMenu: (e: MouseEvent<HTMLElement>) => void;
  onOverflow?: (overflowing: boolean) => void;
  /** How many different values the records hold here — only read while `value`
   * is `VARIED`, which is the one state that has no value of its own to show. */
  distinct: number;
}): JSX.Element | null {
  // Nothing loaded for this field yet — no value, no pencil.
  if (props.value === undefined) return null;
  // The records disagree: how many ways, and the row expands into them.
  if (props.value === VARIED) return <VariedValue distinct={props.distinct} />;

  /** The value as text — meaningful once the records are known to agree on it,
   * which every state below "varied" is. */
  const text = typeof props.value === "string" ? props.value : "";
  const empty = props.value == null || props.value === "";
  /** A primary key: issued by the database, not the user, so nothing here
   * activates an editor for it. */
  const readOnly = props.field.kind === "primitive" && props.field.readOnly;
  const multiline =
    props.field.kind === "primitive" && props.field.valueType === "text";
  /** A UUID reads better small, light and monospaced — it's an identifier to
   * skim past, not prose. */
  const isUuid =
    props.field.kind === "primitive" && props.field.valueType === "uuid";

  const tone = isUuid ? "text-ink-weak font-mono text-xs/5" : "text-ink";
  if (readOnly) {
    if (empty) return null;
    if (props.expanded) {
      return (
        <span
          className={`control block w-full cursor-default break-words whitespace-pre-wrap ${tone}`}
          onContextMenu={(e) => props.onContextMenu(e)}
        >
          {text}
        </span>
      );
    }
    return (
      <OneLineValue
        text={text}
        className={`control block min-w-0 flex-1 cursor-default truncate ${tone}`}
        onContextMenu={props.onContextMenu}
        onOverflow={props.onOverflow}
      />
    );
  }
  // Emptied mid-edit, the box stays up; there's only a pencil once the edit ends.
  if (empty && !props.editing) {
    return (
      <IconButton
        icon={Icons.Edit}
        label={`Edit ${props.field.label}`}
        size="sm"
        tabIndex={-1}
        onClick={() => props.onBeginEdit()}
      />
    );
  }
  return (
    <ValueInput
      text={text}
      label={props.field.label}
      editing={props.editing}
      expanded={props.expanded}
      multiline={multiline}
      numeric={
        props.field.kind === "primitive" && props.field.valueType === "number"
      }
      selectAll={props.editingSelectAll}
      tone={tone}
      onBeginEdit={() => props.onBeginEdit()}
      onInput={(text) => props.onInput(text)}
      onCommit={(text, exit) => props.onCommit(text, exit)}
      onContextMenu={props.onContextMenu}
      onOverflow={props.onOverflow}
    />
  );
}
