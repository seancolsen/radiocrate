import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { Modal } from "./ui/Modal";
import IconButton from "./ui/IconButton";
import LoadingRegion from "./ui/LoadingRegion";
import CustomInput from "./builder/CustomInput";
import { Icons } from "../icons";
import { CanvasGrid } from "./canvasGrid";
import { recordPickerQuery } from "../query/embeddedRecord";
import type { RecordQuery } from "../query/recordForm";
import type { RecordRows } from "../query/recordData";
import { buildResultFromStringRows } from "../query/result";

// The modal record picker: a small query page in a dialog, letting the user
// search a table and hand one record's key value — plus the preview cells
// already loaded for it — back to whoever opened it.
//
// The search box takes Querydown filtering code, exactly as the toolbar's
// filter section does; the sort and display sections behind the two icon
// buttons take the same code and open pre-filled with whatever the caller
// hands in as `initialSort` / `initialDisplay` — in the record editor, that's
// what the points-based generator picked for this table (see
// `query/embeddedRecord.ts`), so the results read as the embedded records
// they are about to become. The user can overrule that choice for one search.
//
// What it does *not* do is behave like the query page's search: the query runs
// as the user types rather than on a keystroke, the search box holds one line,
// and Up/Down/Enter drive the result list without the caret ever leaving the
// box — because picking a record is one continuous act of typing, not a query
// you compose and then run.
//
// The chosen record is handed back whole (key *and* preview cells), so
// whatever replaces this modal renders without another request.

/** How long typing settles before the query runs. Long enough that a word
 * typed at speed is one query rather than five, short enough to feel live. */
const DEBOUNCE_MS = 180;

/** A modal letting the user search `table` and pick one record from it. */
export default function RecordPicker(props: {
  /** The table being picked from: names the dialog and the search box. */
  table: string;
  /** The column identifying a record there. It is column 0 of every result
   * row, and its value is what `onPick` hands back. */
  keyColumn: string;
  /** Querydown the sort / display builders open pre-filled with. */
  initialSort: string;
  initialDisplay: string;
  /** Runs one picker query. The picker builds the query (it knows its own
   * column order); the caller decides how it reaches a database. */
  runQuery: (query: RecordQuery) => Promise<RecordRows>;
  /** The user chose a record: its key value, and the preview cells already
   * loaded for it — so whatever replaces this modal renders without a further
   * request. */
  onPick: (keyValue: string, cells: readonly (string | null)[]) => void;
  /** Dismissed without picking (the X, the scrim, Escape). */
  onCancel: () => void;
  /** Offered as "New record" when the search finds nothing worth linking to,
   * carrying whatever was typed. Omit in a context that can only pick an
   * existing record — the button is then not rendered. */
  onCreate?: (seed: string | undefined) => void;
}) {
  const [filter, setFilter] = createSignal("");
  const [sort, setSort] = createSignal(props.initialSort);
  const [display, setDisplay] = createSignal(props.initialDisplay);
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
      const rows = await props.runQuery(
        recordPickerQuery(
          props.table,
          [props.keyColumn],
          filter(),
          sort(),
          display(),
        ),
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

  /** One result's preview cells: everything after the key column, or the key
   * itself when the display section yields nothing to show. */
  const cells = (row: readonly (string | null)[]) => {
    const preview = row.slice(1);
    return preview.some((cell) => cell !== null && cell !== "")
      ? preview
      : [row[0]];
  };

  /** Choose a record: its preview is already loaded, so whatever replaces this
   * modal appears the moment the modal does not. */
  const choose = (row: readonly (string | null)[]) => {
    const key = row[0];
    if (key == null) return;
    props.onPick(key, cells(row));
  };

  /** Nothing here to link to: scaffold a new record instead, carrying whatever
   * was searched for into its first text field. */
  const enterNewRecord = () => {
    const seed = filter().trim();
    props.onCreate?.(seed === "" ? undefined : seed);
  };

  /** The keys the search box gives up to the list below it, without giving up
   * the caret: Up/Down move the highlight, Enter takes it. */
  const onKeyDown = (e: KeyboardEvent) => {
    const count = results().length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      if (count === 0) return;
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setIndex((i) => Math.min(count - 1, Math.max(0, i + delta)));
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const row = results()[index()];
      if (row) choose(row);
    }
  };

  let searchEl: HTMLElement | undefined;
  // The caret starts in the search box: the modal exists to be typed into. It's
  // focused on mount rather than through `autofocus`, which a portal's
  // after-the-fact insertion doesn't honor.
  onMount(() => searchEl?.focus());

  // The results, painted to a canvas — the query page's own grid engine (see
  // `canvasGrid.ts`), reused wholesale: same row metrics, same scroll/paint
  // machinery. Only the interaction differs from a result row's: a click
  // *picks* a record immediately rather than selecting it, there's no
  // double-click or context menu, and the highlighted row is driven by the
  // search box's Up/Down (`index`) rather than a click-built selection — pushed
  // in the same way a result row's selection is, so it paints with the grid's
  // own selected-row treatment.
  let canvas: HTMLCanvasElement | undefined;
  let grid: CanvasGrid | undefined;

  // Column 0 is the key column `choose` addresses the picked row by — the
  // query page shows this exact result column-hidden too, in spirit if not in
  // mechanism (see `buildResultFromStringRows`).
  createEffect(() => {
    // Read outside the optional chain: `grid?.setResult(...)` would short
    // -circuit *before* evaluating its argument while `grid` is still
    // undefined (the first run, before `onMount` creates it) — which would
    // read `results()` zero times and never subscribe this effect to it.
    const result = buildResultFromStringRows(results(), [0]);
    grid?.setResult(result);
  });
  createEffect(() => {
    const i = index();
    grid?.setSelection(new Set([i]));
    grid?.revealRow(i);
  });

  onMount(() => {
    const el = canvas;
    if (!el) return;
    grid = new CanvasGrid(el);
    grid.setInteraction({
      onRowClick: (i) => {
        const row = results()[i];
        if (row) choose(row);
      },
      onRowDoubleClick: (i) => {
        const row = results()[i];
        if (row) choose(row);
      },
      // No context menu here — a right-click over the results does nothing.
      onRowContextMenu: () => {},
    });
    grid.setResult(buildResultFromStringRows(results(), [0]));
    grid.setSelection(new Set([index()]));

    const host = el.parentElement ?? el;
    const ro = new ResizeObserver(() => grid?.resize());
    ro.observe(host);

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onTheme = () => grid?.refreshTheme();
    mq.addEventListener("change", onTheme);
    const mo = new MutationObserver(onTheme);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    onCleanup(() => {
      ro.disconnect();
      mq.removeEventListener("change", onTheme);
      mo.disconnect();
      grid?.destroy();
      grid = undefined;
    });
  });

  const toggleSection = (which: "sort" | "display") =>
    setSection((open) => (open === which ? null : which));

  return (
    <Modal onClose={props.onCancel} width="560px">
      <div class="flex items-center gap-2">
        <h2 class="text-ink min-w-0 flex-1 truncate text-base font-semibold">
          Pick {props.table}
        </h2>
        <IconButton
          icon={Icons.Close}
          label="Close record picker"
          onClick={props.onCancel}
        />
      </div>

      <div class="mt-3 flex items-center gap-1">
        <div class="min-w-0 flex-1">
          <CustomInput
            singleLine
            ref={(el) => (searchEl = el)}
            value={filter()}
            hint={`Filter ${props.table}`}
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
        <div class="relative h-[min(300px,40vh)] min-h-[80px]">
          <canvas
            ref={(el) => (canvas = el)}
            data-testid="picker-results"
            class="block h-full w-full"
          />
          {/* The canvas already paints "No results" over a genuinely empty
              result; a query error gets its own message, since the grid has no
              notion of one. */}
          <Show when={error()}>
            {(message) => (
              <p class="text-danger pointer-events-none absolute inset-x-0 top-0 px-1 py-2 text-xs">
                {message()}
              </p>
            )}
          </Show>
        </div>
      </LoadingRegion>

      <div class="mt-3 flex items-center gap-2">
        <span class="text-ink-weak min-w-0 flex-1 truncate text-xs">
          <Show when={results().length > 0}>
            {results().length.toLocaleString("en-US")}{" "}
            {results().length === 1 ? "result" : "results"}
          </Show>
        </span>
        <Show when={props.onCreate}>
          <button
            type="button"
            class="text-ink hover:bg-hover border-edge rounded-md border px-3 py-1.5 text-sm"
            onClick={enterNewRecord}
          >
            New record
          </button>
        </Show>
      </div>
    </Modal>
  );
}
