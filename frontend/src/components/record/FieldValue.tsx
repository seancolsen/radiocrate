import {
  createEffect,
  createSignal,
  Match,
  onCleanup,
  onMount,
  Switch,
  untrack,
} from "solid-js";
import { Icons } from "../../icons";
import IconButton from "../ui/IconButton";
import type { PrimitiveField, ScalarLinkField } from "../../query/recordForm";

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
}) {
  const [text, setText] = createSignal(untrack(() => props.initial));
  let el: HTMLTextAreaElement | undefined;

  const grow = () => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  onMount(() => {
    grow();
    el?.focus();
    if (props.selectAll) el?.select();
    else el?.setSelectionRange(el.value.length, el.value.length);
  });

  /** Escape and Tab always end the edit — Tab keeps moving through the form's
   * editors (see `RecordFields.tsx`'s `commit`). Enter's behavior depends on
   * whether there's already a line break in the value: a text field the user
   * is already writing multiple lines into gets another one, so real prose
   * stays easy to keep editing; anything else — including a text field that's
   * still one line — treats Enter as "done" the way every other field kind
   * does, and Shift+Enter is what starts a new line from there. */
  const onKeyDown = (e: KeyboardEvent) => {
    const exit: EditExit | undefined =
      e.key === "Escape"
        ? "self"
        : e.key === "Enter" &&
            !e.shiftKey &&
            !(props.multiline && text().includes("\n"))
          ? "self"
          : e.key === "Tab"
            ? e.shiftKey
              ? "previous"
              : "next"
            : undefined;
    if (!exit) return;
    e.preventDefault();
    e.stopPropagation();
    props.onCommit(text(), exit);
  };

  return (
    <textarea
      ref={(node) => (el = node)}
      rows={1}
      spellcheck={false}
      class="border-accent bg-panel text-ink w-full resize-none overflow-hidden rounded border px-1 py-0.5 text-sm/5 outline-none"
      value={text()}
      onInput={(e) => {
        setText(e.currentTarget.value);
        props.onInput(e.currentTarget.value);
        grow();
      }}
      onKeyDown={onKeyDown}
      // Clicking outside the box (or tabbing away) puts the field back into view
      // mode, keeping what was typed.
      onBlur={() => props.onCommit(text(), "none")}
    />
  );
}

/** The value half of a form row, in whichever of its three states applies:
 *
 *  - **unknown** — nothing has loaded for this field yet, so nothing renders
 *    (not even the pencil): the form shows its labels while the data is on its
 *    way, and only the key values it already had.
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
  /** `undefined` until loaded; `null` for NULL. */
  value: string | null | undefined;
  editing: boolean;
  /** Whether entering edit mode should select the value whole — see
   * `ValueInput`. Only meaningful while `editing` is true. */
  editingSelectAll: boolean;
  expanded: boolean;
  onBeginEdit: () => void;
  onInput: (text: string) => void;
  onCommit: (text: string, exit: EditExit) => void;
  onContextMenu: (e: MouseEvent) => void;
  onOverflow?: (overflowing: boolean) => void;
}) {
  const known = () => props.value !== undefined;
  const empty = () => props.value == null || props.value === "";
  /** A primary key: issued by the database, not the user, so nothing here
   * activates an editor for it. */
  const readOnly = () =>
    props.field.kind === "primitive" && props.field.readOnly;
  /** The collapsed rendering of a value: one line, newlines flattened away. */
  const oneLine = () => (props.value ?? "").replace(/\s*\r?\n\s*/g, " ");
  const multiline = () =>
    props.field.kind === "primitive" && props.field.valueType === "text";
  /** A UUID reads better small, light and monospaced — it's an identifier to
   * skim past, not prose. */
  const isUuid = () =>
    props.field.kind === "primitive" && props.field.valueType === "uuid";

  /** Watches the collapsed line for truncation, in both directions: the text can
   * change under a fixed width (a load, an edit) and the width can change under
   * fixed text (the sidebar being dragged). A value with a linebreak in it never
   * fits on one line, whatever the width. */
  const watchOverflow = (el: HTMLElement) => {
    const check = () =>
      props.onOverflow?.(
        el.scrollWidth > el.clientWidth + 1 || /\r?\n/.test(props.value ?? ""),
      );
    const observer = new ResizeObserver(check);
    observer.observe(el);
    createEffect(check);
    onCleanup(() => observer.disconnect());
  };

  return (
    <Switch>
      {/* Nothing loaded for this field yet — no value, no pencil. */}
      <Match when={!known()}>{null}</Match>
      <Match when={props.editing}>
        <ValueInput
          initial={props.value ?? ""}
          multiline={multiline()}
          selectAll={props.editingSelectAll}
          onInput={(text) => props.onInput(text)}
          onCommit={(text, exit) => props.onCommit(text, exit)}
        />
      </Match>
      <Match when={empty() && !readOnly()}>
        <IconButton
          icon={Icons.Edit}
          label={`Edit ${props.field.label}`}
          size="sm"
          tabIndex={-1}
          onClick={() => props.onBeginEdit()}
        />
      </Match>
      <Match when={empty() && readOnly()}>{null}</Match>
      <Match when={props.expanded}>
        <span
          class={`block w-full break-words whitespace-pre-wrap ${readOnly() ? "cursor-default" : "cursor-text"}`}
          classList={{
            "text-ink text-sm/5": !isUuid(),
            "text-ink-weak font-mono text-xs": isUuid(),
          }}
          onClick={() => !readOnly() && props.onBeginEdit()}
          onContextMenu={(e) => props.onContextMenu(e)}
        >
          {props.value}
        </span>
      </Match>
      <Match when={true}>
        <span
          ref={watchOverflow}
          class={`block min-w-0 flex-1 truncate ${readOnly() ? "cursor-default" : "cursor-text"}`}
          classList={{
            "text-ink text-sm/5": !isUuid(),
            "text-ink-weak font-mono text-xs": isUuid(),
          }}
          onClick={() => !readOnly() && props.onBeginEdit()}
          onContextMenu={(e) => props.onContextMenu(e)}
        >
          {oneLine()}
        </span>
      </Match>
    </Switch>
  );
}
