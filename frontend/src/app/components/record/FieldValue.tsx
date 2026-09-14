import {
  useEffect,
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
import { VARIED, type SharedValue } from "../../../record/formValues";
import type {
  PrimitiveField,
  ScalarLinkField,
} from "../../../query/recordForm";

/** Where focus goes when an activated field leaves edit mode: back to this
 * field's own label, to the next item's, to the previous one's, or nowhere (the
 * user clicked elsewhere, and that's where they want to be). */
export type EditExit = "self" | "next" | "previous" | "none";

/** The activated field value: a focused, auto-growing text box. Mounted only
 * while the field is in edit mode, so every activation starts from the current
 * value and lands the caret at its end (or, Tabbed in from another field's
 * editor, selects it whole — see `selectAll`).
 *
 * It grows to fit its content rather than scrolling — collapsed, that's the
 * "full height necessary to fit the content with soft wrapping"; expanded, it
 * keeps the same shape as the text it replaced.
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
 * through to the form as it happens, so the value (and the star marking it
 * modified) tracks the typing. */
function ValueInput(props: {
  initial: string;
  /** Whether Enter inserts a newline rather than ending the edit, when the
   * value already has one — see `onKeyDown`. */
  multiline: boolean;
  /** Whether the value should be selected whole as the input mounts, rather
   * than have the caret placed at its end — set when edit mode was entered by
   * Tabbing in from another field's editor. */
  selectAll: boolean;
  onInput: (text: string) => void;
  onCommit: (text: string, exit: EditExit) => void;
}): JSX.Element {
  // What this instance was mounted with is fixed for its life — a new
  // activation mounts a new input — so both are read once.
  const [text, setText] = useState(props.initial);
  const [selectAll] = useState(props.selectAll);
  const ref = useRef<HTMLTextAreaElement>(null);

  const grow = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  // A layout effect, not a passive one: Solid's `onMount` ran as the input was
  // inserted, and the form's blur and `relatedTarget` handling depends on focus
  // having moved here before anything else runs.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    el.focus();
    if (selectAll) el.select();
    else el.setSelectionRange(el.value.length, el.value.length);
  }, [selectAll]);

  /** Escape and Tab always end the edit — Tab keeps moving through the form's
   * editors (see `RecordFields.tsx`'s `commit`). Enter's behavior depends on
   * whether there's already a line break in the value: a text field the user
   * is already writing multiple lines into gets another one, so real prose
   * stays easy to keep editing; anything else — including a text field that's
   * still one line — treats Enter as "done" the way every other field kind
   * does, and Shift+Enter is what starts a new line from there. */
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
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
    <textarea
      ref={ref}
      rows={1}
      spellCheck={false}
      className="border-accent bg-panel text-ink w-full resize-none overflow-hidden rounded border px-1 py-0.5 text-sm/5 outline-none"
      value={text}
      onChange={(e) => {
        setText(e.currentTarget.value);
        props.onInput(e.currentTarget.value);
        grow();
      }}
      onKeyDown={onKeyDown}
      // Clicking outside the box (or tabbing away) puts the field back into view
      // mode, keeping what was typed.
      onBlur={() => props.onCommit(text, "none")}
    />
  );
}

/** What a field shows when the records the form is on don't agree on it. It's
 * read-only for now: there's no one value to edit from, and typing into it would
 * flatten differences the user can't see. */
export function VariedValue(): JSX.Element {
  return <span className="text-ink-weak text-sm/5 italic">(varied)</span>;
}

/** The collapsed rendering of a filled value: one line, truncated.
 *
 * Watches itself for truncation, in both directions: the text can change under
 * a fixed width (a load, an edit) and the width can change under fixed text
 * (the sidebar being dragged). A value with a linebreak in it never fits on one
 * line, whatever the width. Solid ran this from the span's `ref` plus a tracking
 * effect; here the effect re-runs when the text does, and the observer covers
 * the width. */
function OneLineValue(props: {
  text: string;
  className: string;
  onClick: () => void;
  onContextMenu: (e: MouseEvent<HTMLElement>) => void;
  onOverflow?: (overflowing: boolean) => void;
}): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  const { text, onOverflow } = props;
  useEffect(() => {
    const el = ref.current;
    if (!el || !onOverflow) return;
    const check = () =>
      onOverflow(el.scrollWidth > el.clientWidth + 1 || /\r?\n/.test(text));
    const observer = new ResizeObserver(check);
    observer.observe(el);
    check();
    return () => observer.disconnect();
  }, [text, onOverflow]);

  return (
    <span
      ref={ref}
      className={props.className}
      onClick={() => props.onClick()}
      onContextMenu={(e) => props.onContextMenu(e)}
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
 *    there is no value to show: "(varied)" stands in for it.
 *  - **empty** — NULL or the empty string, so there's nothing to click: a pencil
 *    button activates an empty input instead.
 *  - **filled** — the value, on one line (newlines become spaces, overflow
 *    ellipsizes) unless it's expanded text, which wraps and keeps its linebreaks.
 *    Clicking it activates the input.
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
   * `ValueInput`. Only meaningful while `editing` is true. */
  editingSelectAll: boolean;
  expanded: boolean;
  onBeginEdit: () => void;
  onInput: (text: string) => void;
  onCommit: (text: string, exit: EditExit) => void;
  onContextMenu: (e: MouseEvent<HTMLElement>) => void;
  onOverflow?: (overflowing: boolean) => void;
}): JSX.Element | null {
  // Nothing loaded for this field yet — no value, no pencil.
  if (props.value === undefined) return null;
  // The records disagree: nothing to show, and nothing to edit yet.
  if (props.value === VARIED) return <VariedValue />;

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

  if (props.editing) {
    return (
      <ValueInput
        initial={text}
        multiline={multiline}
        selectAll={props.editingSelectAll}
        onInput={(text) => props.onInput(text)}
        onCommit={(text, exit) => props.onCommit(text, exit)}
      />
    );
  }
  if (empty) {
    if (readOnly) return null;
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
  const tone = {
    "text-ink text-sm/5": !isUuid,
    "text-ink-weak font-mono text-xs": isUuid,
  };
  const cursor = readOnly ? "cursor-default" : "cursor-text";
  const onClick = () => {
    if (!readOnly) props.onBeginEdit();
  };
  if (props.expanded) {
    return (
      <span
        className={cx(
          `block w-full break-words whitespace-pre-wrap ${cursor}`,
          tone,
        )}
        onClick={onClick}
        onContextMenu={(e) => props.onContextMenu(e)}
      >
        {text}
      </span>
    );
  }
  return (
    <OneLineValue
      text={text}
      className={cx(`block min-w-0 flex-1 truncate ${cursor}`, tone)}
      onClick={onClick}
      onContextMenu={props.onContextMenu}
      onOverflow={props.onOverflow}
    />
  );
}
