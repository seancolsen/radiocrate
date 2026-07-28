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

/** The activated field value: a focused, auto-growing text box. Mounted only
 * while the field is in edit mode, so every activation starts from the current
 * value and lands the caret at its end.
 *
 * It grows to fit its content rather than scrolling — collapsed, that's the
 * "full height necessary to fit the content with soft wrapping"; expanded, it
 * keeps the same shape as the text it replaced. */
function ValueInput(props: {
  initial: string;
  onCommit: (text: string) => void;
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

  return (
    <textarea
      ref={(node) => (el = node)}
      rows={1}
      spellcheck={false}
      class="border-accent bg-panel text-ink w-full resize-none overflow-hidden rounded border px-1 py-0.5 text-sm/5 outline-none"
      value={text()}
      onInput={(e) => {
        setText(e.currentTarget.value);
        grow();
      }}
      // Clicking outside the box (or tabbing away) puts the field back into view
      // mode, keeping what was typed.
      onBlur={() => props.onCommit(text())}
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
  onCommit: (text: string) => void;
  onOverflow?: (overflowing: boolean) => void;
}) {
  const known = () => props.value !== undefined;
  const empty = () => props.value == null || props.value === "";
  /** The collapsed rendering of a value: one line, newlines flattened away. */
  const oneLine = () => (props.value ?? "").replace(/\s*\r?\n\s*/g, " ");

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
          onCommit={(text) => props.onCommit(text)}
        />
      </Match>
      <Match when={empty()}>
        <button
          type="button"
          aria-label={`Edit ${props.field.label}`}
          class="text-ink-weak hover:text-ink flex size-5 shrink-0 items-center justify-center"
          onClick={() => props.onBeginEdit()}
        >
          <Icons.Edit class="size-4" />
        </button>
      </Match>
      <Match when={props.expanded}>
        <span
          class="text-ink block w-full cursor-text text-sm/5 break-words whitespace-pre-wrap"
          onClick={() => props.onBeginEdit()}
        >
          {props.value}
        </span>
      </Match>
      <Match when={true}>
        <span
          ref={watchOverflow}
          class="text-ink block min-w-0 flex-1 cursor-text truncate text-sm/5"
          onClick={() => props.onBeginEdit()}
        >
          {oneLine()}
        </span>
      </Match>
    </Switch>
  );
}
