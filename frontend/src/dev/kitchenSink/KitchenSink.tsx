import {
  useState,
  useSyncExternalStore,
  type JSX,
  type ReactNode,
} from "react";
import { Icons } from "../../icons";
import type { FormField, ValueType } from "../../query/recordForm";
import type { QueryDiagnostic } from "../../query/diagnostics";
import FieldLabel from "../../components/record/FieldLabel";
import ModifiedStar from "../../components/record/ModifiedStar";
import EmbeddedRecord from "../../components/record/EmbeddedRecord";
import { PresetRowView } from "../../components/builder/PresetRow";
import QuerydownEditor from "../../components/builder/QuerydownEditor";
import DiagnosticMessage from "../../components/builder/DiagnosticMessage";
import { Checkbox } from "../../components/ui/Checkbox";
import { Kbd } from "../../components/ui/Kbd";
import IconButton from "../../components/ui/IconButton";
import SplitButton from "../../components/ui/SplitButton";
import { MenuItem, MenuToggleItem } from "../../components/ui/Menu";
import { RpcErrorBar } from "../../components/RpcErrorBanner";
import { UpdateBar } from "../../components/UpdateBanner";
import { cx } from "../../components/ui/cx";
import { chordOf } from "../../commands/chord";
import type { Theme } from "../themedPage";

// The kitchen sink's page: every piece of UI that carries color, grouped by
// kind. Plain grayscale chrome is left out on purpose — this page is for
// tuning the palette, not for cataloguing components.
//
// Real components wherever they render from props alone. A few controls exist
// in the app only as class strings repeated across modals (the text buttons,
// the text input, the select), and those are copied here: their colors are
// app.css tokens, so tuning the tokens shows up here all the same, but a
// change to the class strings themselves has to be mirrored by hand.

/** The color tokens app.css defines beyond the grays, in the order the
 * swatches show them. */
const TOKENS: readonly string[] = [
  "accent",
  "danger",
  "split-active",
  "split-trigger",
  "preset",
  "pill-bg",
  "row-selected",
  "row-selected-hover",
  "now-playing",
  "timeline-rest",
  "row-current",
  "field-text",
  "field-number",
  "field-uuid",
  "field-link",
  "field-records",
  "field-other",
];

/** Re-reads on every hot update, so a swatch shows the value app.css holds
 * now. */
function subscribeToHotUpdates(onChange: () => void): () => void {
  const hot = import.meta.hot;
  if (!hot) return () => {};
  hot.on("vite:afterUpdate", onChange);
  return () => hot.off("vite:afterUpdate", onChange);
}

/** A token's value as app.css writes it for `theme`: its side of a
 * `light-dark(light, dark)`, or the whole of a value both themes share. */
function valueFor(raw: string, theme: Theme): string {
  const inner = /^light-dark\((.*)\)$/s.exec(raw)?.[1];
  if (inner === undefined) return raw;
  // The two colors part at the one comma outside any parentheses.
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "(") depth++;
    else if (inner[i] === ")") depth--;
    else if (inner[i] === "," && depth === 0) {
      return (
        theme === "light" ? inner.slice(0, i) : inner.slice(i + 1)
      ).trim();
    }
  }
  return raw;
}

function useTokenValue(name: string, theme: Theme): string {
  return useSyncExternalStore(subscribeToHotUpdates, () =>
    valueFor(
      getComputedStyle(document.documentElement)
        .getPropertyValue(`--${name}`)
        .trim(),
      theme,
    ),
  );
}

function Swatch(props: { name: string; theme: Theme }): JSX.Element {
  const value = useTokenValue(props.name, props.theme);
  return (
    <div className="flex items-center gap-2">
      <span
        className="border-edge size-7 shrink-0 rounded border"
        style={{ background: `var(--${props.name})` }}
      />
      <div className="min-w-0 text-xs leading-4">
        <div className="text-ink font-mono">--{props.name}</div>
        <div className="text-ink-weak font-mono">{value}</div>
      </div>
    </div>
  );
}

function Section(props: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="border-edge border-t px-4 py-3">
      <h2 className="text-ink-weak mb-2 text-xs font-semibold tracking-wide uppercase">
        {props.title}
      </h2>
      {props.children}
    </section>
  );
}

/** A row of specimens, each over its caption. */
function Row(props: { children: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
      {props.children}
    </div>
  );
}

/** `stretch` gives the specimen its whole width, for a component that sizes
 * itself from what it's given (an embedded record). */
function Specimen(props: {
  caption: string;
  stretch?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      className={cx("flex flex-col gap-1", {
        "items-start": !props.stretch,
      })}
    >
      {props.children}
      <span className="text-ink-weak text-[11px]">{props.caption}</span>
    </div>
  );
}

const primitive = (label: string, valueType: ValueType): FormField => ({
  kind: "primitive",
  key: label,
  label,
  column: label,
  valueType,
  nullable: true,
  readOnly: false,
});

/** One field of every kind a label tells apart, captioned with what makes it
 * that kind. */
const FIELDS: readonly { caption: string; field: FormField }[] = [
  { caption: "text", field: primitive("title", "text") },
  { caption: "number", field: primitive("track_number", "number") },
  { caption: "uuid", field: primitive("id", "uuid") },
  { caption: "timestamp", field: primitive("added_at", "timestamp") },
  { caption: "boolean", field: primitive("compilation", "boolean") },
  { caption: "other", field: primitive("format", "other") },
  {
    caption: "link",
    field: {
      kind: "scalarLink",
      key: "album",
      label: "album",
      column: "album",
      table: "album",
      keyColumn: "id",
      nullable: true,
    },
  },
  {
    caption: "records",
    field: {
      kind: "multiRecord",
      key: "#credit",
      label: "credit",
      table: "credit",
      column: "track",
      keyColumns: ["track", "artist"],
    },
  },
];

function Label(props: { field: FormField; menuOpen?: boolean }): JSX.Element {
  return (
    <FieldLabel
      field={props.field}
      itemId={props.field.key}
      menuOpen={props.menuOpen ?? false}
      onClick={() => {}}
      onDblClick={() => {}}
      onFocus={() => {}}
      onKeyDown={() => {}}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}

function FieldLabels(): JSX.Element {
  return (
    <Section title="Record editor field labels">
      <div className="flex flex-col gap-3">
        <Row>
          {FIELDS.map(({ caption, field }) => (
            <Specimen key={field.key} caption={caption}>
              <Label field={field} />
            </Specimen>
          ))}
        </Row>
        <Row>
          {FIELDS.map(({ caption, field }) => (
            <Specimen key={field.key} caption={`${caption}, focused`}>
              <Label field={field} menuOpen />
            </Specimen>
          ))}
        </Row>
        <Row>
          <Specimen caption="modified">
            <span className="relative">
              <ModifiedStar label="Modified" />
              <Label field={FIELDS[0].field} />
            </span>
          </Specimen>
        </Row>
      </div>
    </Section>
  );
}

// The text buttons' classes, as the modals spell them (see the note at the
// top of this file).
const PRIMARY =
  "control bg-accent text-panel rounded-md px-3 disabled:opacity-40";
const DANGER = "control bg-danger rounded-md px-3 text-white";
const BORDERED = "control text-ink border-edge hover:bg-hover rounded-md px-3";
const PLAIN = "control text-ink hover:bg-hover rounded-md px-3";

function Buttons(): JSX.Element {
  const [filterOn, setFilterOn] = useState(true);
  const [sortOn, setSortOn] = useState(false);
  return (
    <Section title="Buttons">
      <div className="flex flex-col gap-3">
        <Row>
          <Specimen caption="sidebar resize handle">
            <span className="bg-accent/40 block h-[26px] w-[7px]" />
          </Specimen>
          <Specimen caption="primary">
            <button type="button" className={PRIMARY}>
              Save
            </button>
          </Specimen>
          <Specimen caption="primary, disabled">
            <button type="button" className={PRIMARY} disabled>
              Save
            </button>
          </Specimen>
          <Specimen caption="danger">
            <button type="button" className={DANGER}>
              Delete
            </button>
          </Specimen>
          <Specimen caption="bordered">
            <button type="button" className={BORDERED}>
              New query
            </button>
          </Specimen>
          <Specimen caption="plain">
            <button type="button" className={PLAIN}>
              Cancel
            </button>
          </Specimen>
        </Row>
        <Row>
          <Specimen caption="icon">
            <IconButton icon={Icons.Refresh} label="Refresh" />
          </Specimen>
          <Specimen caption="icon, active">
            <IconButton icon={Icons.SelectMultiple} label="Select" active />
          </Specimen>
          <Specimen caption="icon, danger">
            <IconButton icon={Icons.Delete} label="Delete" danger />
          </Specimen>
          <Specimen caption="icon, disabled">
            <IconButton icon={Icons.Undo} label="Undo" disabled />
          </Specimen>
          <Specimen caption="split, on">
            <SplitButton
              icon={Icons.Filter}
              label="Filter"
              active={filterOn}
              onMainClick={() => setFilterOn(!filterOn)}
              menu={<MenuItem label="Clear" />}
            />
          </Specimen>
          <Specimen caption="split, off">
            <SplitButton
              icon={Icons.Sort}
              label="Sort"
              active={sortOn}
              onMainClick={() => setSortOn(!sortOn)}
              menu={<MenuItem label="Clear" />}
            />
          </Specimen>
          <Specimen caption="split, problem">
            <SplitButton
              icon={Icons.Display}
              label="Display"
              active
              alert
              onMainClick={() => {}}
              menu={<MenuItem label="Clear" />}
            />
          </Specimen>
        </Row>
        <Row>
          <Specimen caption="shortcut">
            <Kbd chord={chordOf("mod+shift+P")} className="text-ink" />
          </Specimen>
          <Specimen caption="shortcut, overridden">
            <Kbd chord={chordOf("mod+alt+J")} className="text-accent" />
          </Specimen>
        </Row>
      </div>
    </Section>
  );
}

const INPUT =
  "control bg-panel border-edge text-ink placeholder:text-ink-weak focus:border-accent rounded-md px-2.5 outline-none";
const SELECT =
  "control bg-panel border-edge text-ink focus:border-accent h-[26px] rounded-md px-2 py-0 outline-none";

/** A display section touching most of the highlighting's palette: columns,
 * a path, a count, a function, an alias, and annotations. */
const DISPLAY =
  "$title|upper -> name $album.year $#play @{align:right color:light} $file.added @{width:[120 300] formatter:{type:relativeTime units:[days weeks]}}";

/** A Querydown problem over the editor's own text, so it's underlined. */
const PROBLEM: QueryDiagnostic = {
  kind: "syntax",
  reason: "Unexpected end of input. Expected a value.",
  hint: null,
  origin: { kind: "custom", section: "filter" },
  source: "jazz year:",
  range: { start: 10, end: 10 },
  notes: [],
};

function Inputs(): JSX.Element {
  const [checked, setChecked] = useState(true);
  const [unchecked, setUnchecked] = useState(false);
  const [query, setQuery] = useState("jazz playcount:<100");
  const [broken, setBroken] = useState(PROBLEM.source);
  const [display, setDisplay] = useState(DISPLAY);
  return (
    <Section title="Inputs">
      <div className="flex flex-col gap-3">
        <Row>
          <Specimen caption="checkbox">
            <Checkbox
              label="Apply by default"
              checked={checked}
              onChange={setChecked}
            />
          </Specimen>
          <Specimen caption="checkbox">
            <Checkbox
              label="Apply by default"
              checked={unchecked}
              onChange={setUnchecked}
            />
          </Specimen>
          <Specimen caption="text">
            <input type="text" placeholder="Preset name" className={INPUT} />
          </Specimen>
          <Specimen caption="text, focused">
            <input
              type="text"
              defaultValue="Road trip"
              className={`${INPUT} border-accent`}
            />
          </Specimen>
          <Specimen caption="select">
            <select className={SELECT} defaultValue="track">
              <option value="track">track</option>
              <option value="album">album</option>
            </select>
          </Specimen>
          <Specimen caption="record value, editing">
            <textarea
              rows={1}
              defaultValue="Lemonade"
              className="control border-accent bg-panel text-ink w-48 resize-none rounded px-1 outline-none"
            />
          </Specimen>
        </Row>
        <Row>
          <div className="w-72">
            <Specimen caption="querydown">
              <QuerydownEditor
                value={query}
                onChange={setQuery}
                context={{ grammar: "conditions", baseTable: "track" }}
                label="Filter"
              />
            </Specimen>
          </div>
          <div className="w-72">
            <Specimen caption="querydown, problem">
              <QuerydownEditor
                value={broken}
                onChange={setBroken}
                context={{ grammar: "conditions", baseTable: "track" }}
                label="Broken filter"
                diagnostic={PROBLEM}
              />
            </Specimen>
          </div>
        </Row>
        <Row>
          <div className="w-[36rem]">
            <Specimen caption="querydown, highlighted">
              <QuerydownEditor
                value={display}
                onChange={setDisplay}
                label="Display"
                context={{ grammar: "display", baseTable: "track" }}
              />
            </Specimen>
          </div>
        </Row>
      </div>
    </Section>
  );
}

/** A menu's rows on a static panel: the menu's own look, without its
 * positioning (`MENU_PANEL_CLASS`, less `fixed`). */
function Menus(): JSX.Element {
  const [checks, setChecks] = useState({ filter: true, sort: false });
  const [radio, setRadio] = useState<"custom" | "querydown">("custom");
  return (
    <Section title="Menus">
      <div className="bg-panel border-edge flex w-56 flex-col gap-0.5 rounded-md border p-1 shadow-lg">
        <MenuItem icon={Icons.Rename} label="Rename" />
        <MenuItem icon={Icons.Duplicate} label="Duplicate" disabled />
        <MenuItem icon={Icons.Delete} label="Delete" danger />
        <MenuToggleItem
          kind="checkbox"
          icon={Icons.Filter}
          label="Filter"
          checked={checks.filter}
          onClick={() => setChecks({ ...checks, filter: !checks.filter })}
        />
        <MenuToggleItem
          kind="checkbox"
          icon={Icons.Sort}
          label="Sort"
          checked={checks.sort}
          onClick={() => setChecks({ ...checks, sort: !checks.sort })}
        />
        <MenuToggleItem
          kind="radio"
          icon={Icons.Custom}
          label="Builder"
          checked={radio === "custom"}
          onClick={() => setRadio("custom")}
        />
        <MenuToggleItem
          kind="radio"
          icon={Icons.Querydown}
          label="Full Querydown"
          checked={radio === "querydown"}
          onClick={() => setRadio("querydown")}
        />
      </div>
    </Section>
  );
}

const noop = () => {};

function Surfaces(): JSX.Element {
  return (
    <Section title="Presets, records and chips">
      <div className="flex flex-col gap-3">
        <Row>
          <Specimen caption="preset">
            <PresetRowView name="Vetted" expanded={false} onToggle={noop} />
          </Specimen>
          <Specimen caption="preset, expanded">
            <PresetRowView
              name="Vetted"
              isDefault
              expanded
              onToggle={noop}
              usage="in 5 queries"
            >
              <div className="text-ink px-2 pb-1.5 font-mono text-xs">
                rating.value:&gt;=4
              </div>
            </PresetRowView>
          </Specimen>
          <Specimen caption="preset, problem">
            <PresetRowView
              name="Vetted"
              expanded={false}
              problem
              onToggle={noop}
            />
          </Specimen>
          <Specimen caption="preset, unsaved">
            <PresetRowView name="" unsaved expanded={false} onToggle={noop} />
          </Specimen>
          <Specimen caption="drag chip">
            <div className="control bg-accent text-panel flex items-center gap-1 rounded-md px-2 whitespace-nowrap shadow-md">
              <Icons.Playlist className="size-[14px] shrink-0" />3 tracks
            </div>
          </Specimen>
        </Row>
        <Row>
          <div className="w-56">
            <Specimen caption="embedded record" stretch>
              <div className="flex">
                <EmbeddedRecord cells={["Beyoncé", "Featured"]} focusable />
              </div>
            </Specimen>
          </div>
          <div className="w-56">
            <Specimen caption="embedded record, selected" stretch>
              <div className="flex">
                <EmbeddedRecord
                  cells={["Jack White", "Featured"]}
                  focusable
                  selected
                />
              </div>
            </Specimen>
          </div>
        </Row>
      </div>
    </Section>
  );
}

function Messages(): JSX.Element {
  return (
    <Section title="Banners and messages">
      <div className="flex flex-col gap-3">
        <UpdateBar notice="ready" onReload={() => {}} onDismiss={() => {}} />
        <UpdateBar notice="stale" onReload={() => {}} onDismiss={() => {}} />
        <RpcErrorBar
          notice={{
            method: "setting.set",
            message: "Failed to fetch",
            count: 3,
          }}
          onDismiss={() => {}}
        />
        {/* The record editor's failed-save strip (RecordEditorPanel). */}
        <div className="text-danger border-edge bg-danger/10 flex items-center gap-1 border-y py-1.5 pr-1.5 pl-2 text-xs">
          <p className="min-w-0 flex-1">
            Constraint Error: duplicate key "track-3"
          </p>
          <IconButton icon={Icons.Close} label="Dismiss error" size="sm" />
        </div>
        <DiagnosticMessage diagnostic={PROBLEM} place="Filter" />
        <p className="text-accent text-sm">This query has unsaved changes.</p>
        <p className="text-danger text-sm">The export failed: disk full.</p>
      </div>
    </Section>
  );
}

export default function KitchenSink(props: { theme: Theme }): JSX.Element {
  const other: Theme = props.theme === "light" ? "dark" : "light";
  return (
    <div className="bg-panel text-ink">
      <header className="flex items-baseline gap-3 px-4 pt-3 pb-2">
        <h1 className="text-base font-semibold capitalize">{props.theme}</h1>
        <a
          className="text-ink-weak text-xs underline"
          href={`?theme=${props.theme}`}
          target="_top"
        >
          alone
        </a>
        <a
          className="text-ink-weak text-xs underline"
          href={`?theme=${other}`}
          target="_top"
        >
          {other} alone
        </a>
        <a className="text-ink-weak text-xs underline" href="?" target="_top">
          side by side
        </a>
        <a
          className="text-ink-weak text-xs underline"
          href="/mockup.html"
          target="_top"
        >
          mockup
        </a>
      </header>
      <Section title="Tokens">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-2">
          {TOKENS.map((name) => (
            <Swatch key={name} name={name} theme={props.theme} />
          ))}
        </div>
      </Section>
      <FieldLabels />
      <Buttons />
      <Inputs />
      <Menus />
      <Surfaces />
      <Messages />
    </div>
  );
}
