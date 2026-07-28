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
import type { PrimitiveField, ScalarLinkField } from "../../query/recordForm";

/** Where focus goes when an activated field leaves edit mode: back to this
 * field's own label, to the next item's, to the previous one's, or nowhere (the
 * user clicked elsewhere, and that's where they want to be). */
export type EditExit = "self" | "next" | "previous" | "none";

/** The activated field value: a focused, auto-growing text box. Mounted only
 * while the field is in edit mode, so every activation starts from the current
 * value and lands the caret at its end.
 *
 * It grows to fit its content rather than scrolling — collapsed, that's the
 * "full height necessary to fit the content with soft wrapping"; expanded, it
 * keeps the same shape as the text it replaced.
 *
 * Keys: Esc leaves edit mode and goes back to the label; Tab and Shift+Tab do
 * the same but land on the next or previous item; Enter adds a newline in a text
 * field and leaves edit mode in any other. Every one of them keeps what was
 * typed — the form holds it until the user saves.
 *
 * The form doesn't wait for any of them, though: `onInput` writes each keystroke
 * through to the form as it happens, so the value (and the star marking it
 * modified) tracks the typing. */
function ValueInput(props: {
  initial: string;
  /** Whether Enter inserts a newline rather than ending the edit. */
  multiline: boolean;
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
    el?.setSelectionRange(el.value.length, el.value.length);
  });

  const onKeyDown = (e: KeyboardEvent) => {
    const exit: EditExit | undefined =
      e.key === "Escape"
        ? "self"
        : e.key === "Enter" && !props.multiline
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
  expanded: boolean;
  onBeginEdit: () => void;
  onInput: (text: string) => void;
  onCommit: (text: string, exit: EditExit) => void;
  onContextMenu: (e: MouseEvent) => void;
  onOverflow?: (overflowing: boolean) => void;
}) {
  const known = () => props.value !== undefined;
  const empty = () => props.value == null || props.value === "";
  /** The collapsed rendering of a value: one line, newlines flattened away. */
  const oneLine = () => (props.value ?? "").replace(/\s*\r?\n\s*/g, " ");
  const multiline = () =>
    props.field.kind === "primitive" && props.field.valueType === "text";

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
          onInput={(text) => props.onInput(text)}
          onCommit={(text, exit) => props.onCommit(text, exit)}
        />
      </Match>
      <Match when={empty()}>
        <button
          type="button"
          tabindex={-1}
          aria-label={`Edit ${props.field.label}`}
          class="text-ink-weak hover:text-ink flex size-5 shrink-0 items-center justify-center"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => props.onBeginEdit()}
        >
          <Icons.Edit class="size-4" />
        </button>
      </Match>
      <Match when={props.expanded}>
        <span
          class="text-ink block w-full cursor-text text-sm/5 break-words whitespace-pre-wrap"
          onClick={() => props.onBeginEdit()}
          onContextMenu={(e) => props.onContextMenu(e)}
        >
          {props.value}
        </span>
      </Match>
      <Match when={true}>
        <span
          ref={watchOverflow}
          class="text-ink block min-w-0 flex-1 cursor-text truncate text-sm/5"
          onClick={() => props.onBeginEdit()}
          onContextMenu={(e) => props.onContextMenu(e)}
        >
          {oneLine()}
        </span>
      </Match>
    </Switch>
  );
}
