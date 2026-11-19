import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { Icons, type IconComponent } from "../../icons";
import { checkSetting } from "../../query/compile";
import type { Section } from "../../query/definition";
import { recordPickerDefaults } from "../../query/embeddedRecord";
import { tableSettingItemId } from "../../query/structure";
import {
  builtInSetting,
  composePrelude,
  generatedPrelude,
  isCustomized,
  PICKER_SETTINGS,
  PRELUDE_SETTING_LABELS,
  SETTING_VARIABLE,
  type PreludeSetting,
} from "../../query/tableSettings";
import { selectTableQuerydown, selectUserPrelude } from "../../stores/app";
import { useApp, useAppActions } from "../../stores/react";
import DiagnosticMessage from "../builder/DiagnosticMessage";
import QuerydownEditor from "../builder/QuerydownEditor";
import {
  useCheckContext,
  useSettledDiagnostic,
} from "../builder/useDiagnostics";
import { QuerySectionsView } from "../record/FieldQueryEditor";
import HelpPopover from "../ui/HelpPopover";
import { MenuItem } from "../ui/Menu";
import { TreeName, TreeNode, TreeNote, useFocusOnReveal } from "./Tree";

// A table's settings under "Query settings" on the Data structure page, beside
// its presets:
//
// - "Text search" and "Linked record comparison", the two Querydown expressions
//   the app builds into the prelude for the table (`query/tableSettings.ts`),
//   each opening into its editor;
// - "Record picker", the sorting and display the record picker opens with on the
//   table, opening into the same editor a related-records field's query has.
//
// What's typed is the table's at once, and written once the app goes quiet, or
// as the editor goes away. "Reset to default" goes back to the app's own.

const TOOLBAR_BUTTON =
  "text-ink hover:bg-hover flex h-[26px] shrink-0 items-center gap-1.5 rounded px-2 text-sm disabled:opacity-40 disabled:hover:bg-transparent";

const SETTING_ICONS: Record<PreludeSetting, IconComponent> = {
  defaultTextSearch: Icons.TextSearch,
  linkedRecordComparison: Icons.LinkedComparison,
};

/** Gives the keyboard back to the row of the item `el` is under: the way out of
 * an editor, on Escape. */
function focusOwnRow(el: HTMLElement | null): void {
  el?.closest("[data-tree-node]")
    ?.querySelector<HTMLElement>("[data-tree-item]")
    ?.focus();
}

/** What's said beside a setting's name: whether it's the user's, or the app's
 * built-in default, or — with no default to go by — nothing at all. ("Default"
 * is taken, on this page: it's a preset applied by default.) */
function settingState(customized: boolean, hasDefault: boolean): string {
  if (customized) return "Customized";
  return hasDefault ? "Built-in" : "None";
}

/** A setting's help: what it does, in the popover behind its "?". */
function SettingHelp(props: {
  table: string;
  setting: PreludeSetting;
}): JSX.Element {
  const { table } = props;
  const code = (text: string) => (
    <code className="bg-hover rounded px-0.5 font-mono text-xs">{text}</code>
  );
  const hasDefault = builtInSetting(table, props.setting) !== null;
  let fallback: string;
  if (hasDefault) {
    fallback = `Left blank, or reset, it’s the app’s default for ${table}.`;
  } else if (props.setting === "defaultTextSearch") {
    fallback = `Left blank, Querydown’s own search is used: it looks through the text columns of ${table}.`;
  } else {
    fallback = `Left blank, a link to ${table} is compared with the linked record’s id.`;
  }
  if (props.setting === "defaultTextSearch") {
    return (
      <>
        <p>
          What a quoted string on its own searches for in a filter on {table}:
          one condition, with {code(SETTING_VARIABLE)} standing for the string.
          With {code("title:@x")}, the filter {code('"love"')} finds the records
          whose title contains “love”.
        </p>
        <p className="mt-2">
          To search several columns at once, list a condition for each between{" "}
          {code("[")} and {code("]")}: a record matching any of them is found.
        </p>
        <p className="mt-2">{fallback}</p>
      </>
    );
  }
  return (
    <>
      <p>
        What comparing a link to {table} with a value compares, in a filter on a
        table that links here: one condition on {table}, with{" "}
        {code(SETTING_VARIABLE)} standing for the value. With {code("value:@x")}{" "}
        on rating, the filter {code("rating:2")} on track means{" "}
        {code("rating.value:2")}.
      </p>
      <p className="mt-2">{fallback}</p>
    </>
  );
}

/** The editor of one of a table's prelude settings: its toolbar, the
 * expression, and a problem with it. The expression is checked as it's typed,
 * compiled into a query that uses it, under the rest of the prelude. */
function PreludeSettingEditor(props: {
  itemId: string;
  table: string;
  setting: PreludeSetting;
}): JSX.Element {
  const { table, setting } = props;
  const stored = useApp((s) => selectTableQuerydown(s, table, setting));
  const builtIn = builtInSetting(table, setting);
  const text = stored ?? builtIn ?? "";
  const tables = useApp((s) => s.schema.tables);
  const settings = useApp((s) => s.tableSettings.data);
  const computed = useApp((s) => s.computedColumns.data);
  const user = useApp(selectUserPrelude);
  const { setTableQuerydown, flushTableQuerydown } = useAppActions();
  // Nothing typed waits on the idle queue once the editor has gone.
  useEffect(
    () => () => flushTableQuerydown(table, setting),
    [table, setting, flushTableQuerydown],
  );

  // Everything the setting runs under, but for its own definition, which the
  // check puts last.
  const prelude = useMemo(
    () =>
      composePrelude(
        generatedPrelude(tables, settings, computed, { table, setting }),
        user,
      ),
    [tables, settings, computed, table, setting, user],
  );
  const schemaJson = useCheckContext()?.schemaJson;
  const blank = !isCustomized(text);
  const latest = useMemo(
    () =>
      schemaJson === undefined || blank
        ? null
        : checkSetting(schemaJson, tables, table, setting, text, prelude),
    [schemaJson, blank, tables, table, setting, text, prelude],
  );
  const problem = useSettledDiagnostic(latest);
  const label = PRELUDE_SETTING_LABELS[setting];

  // The caret comes here when the user was sent for the setting: an error
  // strip's "Edit text search".
  const wrapRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLElement>(null);
  useFocusOnReveal(props.itemId, editorRef);

  return (
    <div ref={wrapRef} className="py-1 pr-1 pl-5" data-testid="setting-editor">
      <div className="flex items-center gap-1 pb-1">
        <button
          type="button"
          disabled={stored === null}
          className={TOOLBAR_BUTTON}
          onClick={() => setTableQuerydown(table, setting, null)}
        >
          <Icons.Revert className="text-ink-weak size-4" />
          Reset to default
        </button>
        <HelpPopover label={`About ${label.toLowerCase()}`}>
          <SettingHelp table={table} setting={setting} />
        </HelpPopover>
      </div>
      <QuerydownEditor
        ref={editorRef}
        label={`${label} of ${table}`}
        value={text}
        context={{
          grammar: "conditions",
          baseTable: table,
          definitions: prelude.text,
        }}
        onChange={(next) => setTableQuerydown(table, setting, next)}
        diagnostic={problem?.origin?.kind === "tableSetting" ? problem : null}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          focusOwnRow(wrapRef.current);
        }}
      />
      {blank && (
        <p className="text-ink-weak px-1 pt-1 text-xs">
          {builtIn === null
            ? `Blank: ${table} has no ${label.toLowerCase()}.`
            : "Blank: the default is used."}
        </p>
      )}
      {problem && (
        <div className="pt-1">
          <DiagnosticMessage diagnostic={problem} place={label} />
        </div>
      )}
    </div>
  );
}

/** One of a table's prelude settings: its row says whether it's customized,
 * and it opens into its editor. */
export function PreludeSettingNode(props: {
  table: string;
  setting: PreludeSetting;
}): JSX.Element {
  const { table, setting } = props;
  const customized = useApp((s) =>
    isCustomized(selectTableQuerydown(s, table, setting)),
  );
  const Icon = SETTING_ICONS[setting];
  const id = tableSettingItemId(table, setting);
  return (
    <TreeNode
      id={id}
      expandable
      label={
        <>
          <Icon className="text-ink-weak size-4 shrink-0" />
          <TreeName>{PRELUDE_SETTING_LABELS[setting]}</TreeName>
          <TreeNote>
            {settingState(customized, builtInSetting(table, setting) !== null)}
          </TreeNote>
        </>
      }
    >
      <PreludeSettingEditor itemId={id} table={table} setting={setting} />
    </TreeNode>
  );
}

/** The record picker's help, behind its "?". */
const RECORD_PICKER_HELP = (
  <>
    <p>
      How the record picker lists records of this table, when a linked record
      field is pointed at one: the order they’re in, and what of each it shows.
    </p>
    <p className="mt-2">
      Until they’re written here, they’re generated from the table’s columns.
      Changing them in the record picker changes them here too, for every picker
      on the table. “Restore default”, in the ⋮, goes back to what’s generated.
    </p>
  </>
);

/** The editor of a table's record picker: its sorting and display, written or
 * generated. */
function RecordPickerEditor(props: { table: string }): JSX.Element {
  const { table } = props;
  const [section, setSection] = useState<"sort" | "display">("sort");
  const part = PICKER_SETTINGS[section];
  const stored = useApp((s) => selectTableQuerydown(s, table, part));
  const tables = useApp((s) => s.schema.tables);
  const generated = useMemo(
    () => recordPickerDefaults(tables, table),
    [tables, table],
  );
  const { setTableQuerydown, flushTableQuerydown } = useAppActions();
  // Nothing typed waits on the idle queue once the editor has gone.
  useEffect(
    () => () => {
      flushTableQuerydown(table, "recordPickerSorting");
      flushTableQuerydown(table, "recordPickerDisplay");
    },
    [table, flushTableQuerydown],
  );
  const wrapRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={wrapRef}>
      <QuerySectionsView
        subject={`the record picker on ${table}`}
        sections={["sort", "display"]}
        section={section}
        onSection={(next: Section) =>
          setSection(next === "display" ? "display" : "sort")
        }
        base={table}
        definitions=""
        text={stored ?? generated[section]}
        onChange={(text) => setTableQuerydown(table, part, text)}
        onEscape={() => focusOwnRow(wrapRef.current)}
        help={RECORD_PICKER_HELP}
        inputActions={
          <MenuItem
            icon={Icons.Revert}
            label="Restore default"
            disabled={stored === null}
            onClick={() => setTableQuerydown(table, part, null)}
          />
        }
      />
    </div>
  );
}

/** A table's record picker: its row says whether its query is customized, and
 * it opens into its sorting and display. */
export function RecordPickerNode(props: { table: string }): JSX.Element {
  const { table } = props;
  const customized = useApp(
    (s) =>
      selectTableQuerydown(s, table, "recordPickerSorting") !== null ||
      selectTableQuerydown(s, table, "recordPickerDisplay") !== null,
  );
  return (
    <TreeNode
      id={tableSettingItemId(table, "recordPicker")}
      expandable
      label={
        <>
          <Icons.RecordPicker className="text-ink-weak size-4 shrink-0" />
          <TreeName>Record picker</TreeName>
          <TreeNote>{customized ? "Customized" : "Generated"}</TreeNote>
        </>
      }
    >
      <RecordPickerEditor table={table} />
    </TreeNode>
  );
}
