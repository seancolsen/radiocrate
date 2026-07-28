import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import { Modal } from "../ui/Modal";
import IconButton from "../ui/IconButton";
import CustomInput from "../builder/CustomInput";
import EmbeddedRecord from "./EmbeddedRecord";
import LoadingRegion from "./LoadingRegion";
import { fieldItemId, type RecordFormModel } from "./formModel";
import { Icons } from "../../icons";
import { recordPickerQuery } from "../../query/embeddedRecord";
import { runRecordQuery, type RecordRows } from "../../query/recordData";
import type { ScalarLinkField } from "../../query/recordForm";

// The modal record picker: how a scalar linked record field is pointed at a
// record that already exists.
//
// It's a small query page in a dialog. The search box takes Querydown filtering
// code, exactly as the toolbar's filter section does; the sort and display
// sections behind the two icon buttons take the same code and open pre-filled
// with what the points-based generator picked for this table (see
// `query/embeddedRecord.ts`) — so the results read as the embedded records they
// are about to become, and the user can overrule that choice for one search.
//
// What it does *not* do is behave like the query page's search: the query runs
// as the user types rather than on a keystroke, the search box holds one line,
// and Up/Down/Enter drive the result list without the caret ever leaving the
// box — because picking a record is one continuous act of typing, not a query
// you compose and then run.
//
// The chosen record is handed to the form whole (key *and* preview cells), so
// the embedded record that replaces this modal renders without another request.

/** How long typing settles before the query runs. Long enough that a word
 * typed at speed is one query rather than five, short enough to feel live. */
const DEBOUNCE_MS = 180;

/** The most results rendered at once. Querydown's section API has no LIMIT, so
 * a search matching a whole table comes back whole; the cap is on what's built
 * into the DOM, and the footer says when it bit. */
const RENDER_LIMIT = 200;

/** The record picker for whichever field has one open, or nothing. Rendered once
 * per form, beside its context menu. */
export default function RecordPicker(props: {
  model: RecordFormModel;
  schemaJson: string;
}) {
  /** The field the open picker belongs to — only ever a scalar linked record
   * field, which is the only kind that points at a single existing record. */
  const field = (recordId: string, fieldKey: string) => {
    const found = props.model
      .record(recordId)
      ?.fields.find((f) => f.key === fieldKey);
    return found?.kind === "scalarLink" ? found : undefined;
  };

  return (
    // Keyed on the target, so each opening starts from a fresh search rather
    // than from where the last one left off.
    <Show when={props.model.picker()} keyed>
      {(open) => (
        <Show when={field(open.recordId, open.fieldKey)}>
          {(target) => (
            <PickerModal
              model={props.model}
              schemaJson={props.schemaJson}
              recordId={open.recordId}
              field={target()}
            />
          )}
        </Show>
      )}
    </Show>
  );
}

function PickerModal(props: {
  model: RecordFormModel;
  schemaJson: string;
  recordId: string;
  field: ScalarLinkField;
}) {
  // One modal belongs to one field for its whole life (the `keyed` Show above
  // rebuilds it otherwise), so its subject is read once.
  const itemId = untrack(() => fieldItemId(props.recordId, props.field.key));
  const spec = untrack(() => props.model.previewSpec(props.field.table));

  const [filter, setFilter] = createSignal("");
  const [sort, setSort] = createSignal(spec.sort);
  const [display, setDisplay] = createSignal(spec.display.join(" "));
  /** Which of the two builders is open below the search box, if either. */
  const [section, setSection] = createSignal<"sort" | "display" | null>(null);

  const [results, setResults] = createSignal<RecordRows>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  /** The highlighted result — what Enter picks, and what Up/Down move. */
  const [index, setIndex] = createSignal(0);

  // Only the newest search may write its results: typing outruns the network,
  // and an earlier query answering late must not replace a later one's answer.
  let token = 0;

  const search = async () => {
    const mine = ++token;
    setLoading(true);
    try {
      const rows = await runRecordQuery(
        recordPickerQuery(
          props.field.table,
          [props.field.keyColumn],
          filter(),
          sort(),
          display(),
        ),
        props.schemaJson,
      );
      if (token !== mine) return;
      setResults(rows);
      setError(null);
      setIndex(0);
    } catch (err) {
      if (token !== mine) return;
      setResults([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (token === mine) setLoading(false);
    }
  };

  // The search runs on every change to any of the three sections, settling
  // first. The modal's own first search doesn't wait: there's nothing to settle
  // yet, and the list should be there by the time the user looks at it.
  let settled = false;
  createEffect(() => {
    // Tracked, so editing any section re-runs this.
    filter();
    sort();
    display();
    const timer = setTimeout(
      () => {
        settled = true;
        void search();
      },
      settled ? DEBOUNCE_MS : 0,
    );
    onCleanup(() => clearTimeout(timer));
  });

  /** What's actually built into the list. */
  const shown = () => results().slice(0, RENDER_LIMIT);

  /** One result's preview cells: everything after the key column, or the key
   * itself when the display section yields nothing to show. */
  const cells = (row: readonly (string | null)[]) => {
    const preview = row.slice(1);
    return preview.some((cell) => cell !== null && cell !== "")
      ? preview
      : [row[0]];
  };

  /** Puts the user back on the field they came from, once the modal is gone.
   * Deferred a tick, since the field's row only regains its focusable label as
   * this modal unmounts. */
  const restoreFocus = () =>
    untrack(() => {
      const model = props.model;
      queueMicrotask(() => model.focusItem(itemId));
    });

  /** Close without touching the field — the X, the scrim, Escape. */
  const dismiss = () => {
    props.model.closePicker();
    restoreFocus();
  };

  /** Choose a record: the field points at it, and its preview is already
   * loaded, so the embedded record appears the moment the modal does not. */
  const choose = (row: readonly (string | null)[]) => {
    const key = row[0];
    if (key == null) return;
    props.model.pickRecord(props.recordId, props.field, key, cells(row));
    restoreFocus();
  };

  /** Nothing here to link to: scaffold a new record instead, carrying whatever
   * was searched for into its first text field. */
  const enterNewRecord = () => {
    const seed = filter().trim();
    props.model.closePicker();
    props.model.addLinkedRecord(
      props.recordId,
      props.field,
      seed === "" ? undefined : seed,
    );
  };

  /** The keys the search box gives up to the list below it, without giving up
   * the caret: Up/Down move the highlight, Enter takes it. */
  const onKeyDown = (e: KeyboardEvent) => {
    const count = shown().length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      if (count === 0) return;
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setIndex((i) => Math.min(count - 1, Math.max(0, i + delta)));
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const row = shown()[index()];
      if (row) choose(row);
    }
  };

  let searchEl: HTMLElement | undefined;
  // The caret starts in the search box: the modal exists to be typed into. It's
  // focused on mount rather than through `autofocus`, which a portal's
  // after-the-fact insertion doesn't honor.
  onMount(() => searchEl?.focus());

  let list: HTMLDivElement | undefined;
  createEffect(() => {
    const el = list?.querySelector<HTMLElement>(`[data-index="${index()}"]`);
    el?.scrollIntoView({ block: "nearest" });
  });

  const toggleSection = (which: "sort" | "display") =>
    setSection((open) => (open === which ? null : which));

  return (
    <Modal onClose={dismiss} width="560px">
      <div class="flex items-center gap-2">
        <h2 class="text-ink min-w-0 flex-1 truncate text-base font-semibold">
          Pick {props.field.table}
        </h2>
        <IconButton
          icon={Icons.Close}
          label="Close record picker"
          onClick={dismiss}
        />
      </div>

      <div class="mt-3 flex items-center gap-1">
        <div class="min-w-0 flex-1">
          <CustomInput
            singleLine
            ref={(el) => (searchEl = el)}
            value={filter()}
            hint={`Filter ${props.field.table}`}
            onInput={setFilter}
            onClear={() => setFilter("")}
            onKeyDown={onKeyDown}
          />
        </div>
        <IconButton
          icon={Icons.Sort}
          label="Sort"
          active={section() === "sort"}
          onClick={() => toggleSection("sort")}
        />
        <IconButton
          icon={Icons.Display}
          label="Display"
          active={section() === "display"}
          onClick={() => toggleSection("display")}
        />
      </div>

      {/* The sort and display builders, the toolbar's in miniature: the same
          Querydown input, over the code the generator chose for this table. */}
      <Show when={section() === "sort"}>
        <div class="mt-2">
          <CustomInput
            value={sort()}
            hint="Sort"
            onInput={setSort}
            onClear={() => setSort("")}
          />
        </div>
      </Show>
      <Show when={section() === "display"}>
        <div class="mt-2">
          <CustomInput
            value={display()}
            hint="Display"
            onInput={setDisplay}
            onClear={() => setDisplay("")}
          />
        </div>
      </Show>

      <LoadingRegion loading={loading()} class="mt-3">
        <div
          ref={(el) => (list = el)}
          data-testid="picker-results"
          class="flex max-h-[300px] min-h-[80px] flex-col gap-1 overflow-y-auto"
        >
          <For each={shown()}>
            {(row, i) => (
              <div class="flex" data-index={i()}>
                <EmbeddedRecord
                  cells={cells(row)}
                  selected={index() === i()}
                  onClick={() => choose(row)}
                />
              </div>
            )}
          </For>
          <Show when={!loading() && error() === null && shown().length === 0}>
            <p class="text-ink-weak px-1 py-2 text-xs italic">
              No matching records
            </p>
          </Show>
          <Show when={error()}>
            {(message) => (
              <p class="text-danger px-1 py-2 text-xs">{message()}</p>
            )}
          </Show>
        </div>
      </LoadingRegion>

      <div class="mt-3 flex items-center gap-2">
        <span class="text-ink-weak min-w-0 flex-1 truncate text-xs">
          <Show when={results().length > RENDER_LIMIT}>
            Showing the first {RENDER_LIMIT} of {results().length}
          </Show>
        </span>
        <button
          type="button"
          class="text-ink hover:bg-hover border-edge rounded-md border px-3 py-1.5 text-sm"
          onClick={enterNewRecord}
        >
          New record
        </button>
      </div>
    </Modal>
  );
}
