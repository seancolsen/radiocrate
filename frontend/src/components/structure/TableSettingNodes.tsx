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
import {
  selectPreludeText,
  selectTableQuerydown,
  selectUserPrelude,
} from "../../stores/app";
import { useApp, useAppActions } from "../../stores/react";
import DiagnosticMessage from "../builder/DiagnosticMessage";
import QuerydownEditor from "../builder/QuerydownEditor";
import {
  useCheckContext,
  useSettledDiagnostic,
} from "../builder/useDiagnostics";
import { QuerySectionsView } from "../record/FieldQueryEditor";
import IconButton from "../ui/IconButton";
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

/** A setting's help: what it does, in the tooltip of its "?". */
function settingHelp(table: string, setting: PreludeSetting): string {
  if (setting === "defaultTextSearch") {
    return `When you enter bare words into a Querydown filter for ${table} records, this setting customizes how a filter condition is constructed from the text you enter. Use ${SETTING_VARIABLE} in this field to represent the text entered.`;
  }
  return `When a column in another table refers to records in this table, this setting lets you control the behavior of comparisons in the other table which include that linked record column. To customize the behavior, write a Querydown comparison expression here, in the context of this table, using ${SETTING_VARIABLE} to represent the compared value. For example, if this table has a name column, you can write name:@x to compare linked records by name.`;
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
  const tables = useApp((s) => s.schema.allTables);
  const settings = useApp((s) => s.tableSettings.data);
  const computed = useApp((s) => s.computedColumns.data);
  const comparisons = useApp((s) => s.customComparisons.data);
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
        generatedPrelude(tables, settings, computed, comparisons, {
          table,
          setting,
        }),
        user,
      ),
    [tables, settings, computed, comparisons, table, setting, user],
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
        <IconButton
          icon={Icons.Help}
          label="Help"
          description={settingHelp(table, setting)}
        />
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

/** The record picker's help, in the tooltip of its "?". */
function recordPickerHelp(table: string): string {
  return `When selecting a ${table} record, these settings allow you to customize the sorting and display of such records.`;
}

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
  const prelude = useApp(selectPreludeText);
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
        definitions={prelude}
        text={stored ?? generated[section]}
        onChange={(text) => setTableQuerydown(table, part, text)}
        onEscape={() => focusOwnRow(wrapRef.current)}
        help={recordPickerHelp(table)}
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
