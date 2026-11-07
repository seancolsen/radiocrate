import { useState, type JSX, type ReactNode } from "react";
import {
  selectRecordEditor,
  type RecordEditorTarget,
  type RecordRef,
} from "../stores/app";
import { entityNames } from "../query/entityNames";
import { recordIdentity } from "../stores/forms";
import {
  createRecordForm,
  selectAnyExpanded,
  selectFormModified,
  type RecordFormModel,
} from "../stores/recordForm";
import {
  useApp,
  useAppActions,
  useFormState,
  useStores,
} from "../stores/react";
import { Icons, type IconComponent } from "../icons";
import RecordForm from "./record/RecordForm";
import IconButton from "./ui/IconButton";
import { Menu, MenuItem } from "./ui/Menu";
import ScrollArea from "./ui/ScrollArea";
import SidebarResizeHandle from "./ui/SidebarResizeHandle";
import { cx } from "./ui/cx";
import { usePersistentSidebar } from "./ui/usePersistentSidebar";

// The record editor: a sidebar within the query page, opened from a result row's
// "Edit {table}" context-menu entry or the "Results: Edit selected rows"
// command, and kept in sync with the result-row selection while it's open
// (`createStores()` owns that wiring). It lives *inside* the page (not the app
// frame) so opening it narrows the toolbar and the results and leaves the tab
// bar and the now-playing bar alone.
//
// The panel itself is the frame — heading, close/reset/save buttons, resize
// divider — and the dynamic-form work happens below it in `record/`. A multi-row
// selection is no exception here: the same form is built for every record the
// selection covers, and what differs about editing several at once is settled
// field by field, well below this (see `record/formValues.ts`).

/** Least width left to the results, so the pane the editor was opened *from*
 * can't be squeezed away entirely. A phone can't spare much of its width, and
 * the editor is the one that needs it there. */
const MIN_RESULTS_WIDTH = 160;
const MIN_RESULTS_WIDTH_NARROW = 48;

/** The records' identities as strings — table plus key each — for comparing two
 * selections without caring which objects carry them. The same strings key the
 * stashed form, so "the same records" means one thing throughout. */
function identities(records: readonly RecordRef[]): string[] {
  return records.map((record) => recordIdentity(record.table, record.key));
}

/** One labelled button of the panel's toolbar: the icon and the word, since
 * these two are consequential enough to be worth naming (unlike the icon-only
 * controls elsewhere). */
function ToolbarButton(props: {
  icon: IconComponent;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}): JSX.Element {
  const Icon = props.icon;
  return (
    <button
      type="button"
      disabled={props.disabled}
      className={cx("control flex shrink-0 items-center gap-1 rounded", {
        "text-ink hover:bg-hover": !props.disabled,
        "text-ink-weak/40": props.disabled,
      })}
      onClick={() => props.onClick()}
    >
      <Icon className="size-4" />
      {props.label}
    </button>
  );
}

/** The form's actions menu (⋮): Collapse all, shown only while something is
 * expanded, and Refresh, which reloads the record from the database. Refresh
 * is off while there are unsaved changes or a save is in flight, since it would
 * throw the changes away — Reset is the deliberate way to do that. */
function FormActionsMenu(props: { model: RecordFormModel }): JSX.Element {
  const { model } = props;
  const anyExpanded = useFormState(model, selectAnyExpanded);
  const modified = useFormState(model, selectFormModified);
  const saving = useFormState(model, (s) => s.saving);
  return (
    <Menu
      align="end"
      width="180px"
      trigger={(api) => (
        <IconButton
          icon={Icons.More}
          label="Record actions"
          active={api.open}
          onClick={() => api.toggle()}
        />
      )}
    >
      {anyExpanded && (
        <MenuItem
          icon={Icons.ExpandClosed}
          label="Collapse all"
          onClick={() => model.collapseAll()}
        />
      )}
      <MenuItem
        icon={Icons.Refresh}
        label="Refresh"
        disabled={modified || saving}
        onClick={() => model.reset()}
      />
    </Menu>
  );
}

/** The record editor toolbar: what the form is editing, and the ways out of it.
 * `children` are the form's own buttons (Reset and Save), which only appear once
 * there's a form with something to reset or save; `menu` is its actions menu;
 * the X always closes the sidebar (the changes, if any, stay with the tab). */
function PanelHeader(props: {
  heading: string;
  onClose: () => void;
  menu?: ReactNode;
  children?: ReactNode;
}): JSX.Element {
  return (
    <header className="border-edge flex items-center gap-1 border-b px-2 py-1.5">
      <h2 className="text-ink min-w-0 flex-1 truncate text-sm font-semibold">
        {props.heading}
      </h2>
      {props.children}
      {props.menu}
      <IconButton
        icon={Icons.Close}
        label="Close record editor"
        onClick={props.onClose}
      />
    </header>
  );
}

/** The record-editor sidebar for `tabId`, when its editor is open.
 *
 * Reads what it's open on from the store rather than taking it from the
 * caller: the forms store keeps a form alive *because* it's the tab's editor
 * target, so the form on screen must be the target the store holds — never a
 * copy of it that could drift. */
export default function RecordEditorPanel(props: {
  tabId: string;
}): JSX.Element | null {
  const target = useApp((s) => selectRecordEditor(s, props.tabId));
  if (!target) return null;
  return <OpenPanel tabId={props.tabId} target={target} />;
}

/** The open sidebar, showing the record(s) the editor is on. `target.records`
 * holds more than one entry when the result-row selection it tracks widens to
 * multiple rows; the form below handles that as a matter of course. */
function OpenPanel(props: {
  tabId: string;
  target: RecordEditorTarget;
}): JSX.Element {
  const { setRecordSidebarWidth, commitRecordSidebarWidth, closeRecordEditor } =
    useAppActions();
  const width = useApp((s) => s.recordSidebarWidth);
  const schemaJson = useApp((s) => s.schema.json);
  const minResultsWidth = usePersistentSidebar()
    ? MIN_RESULTS_WIDTH
    : MIN_RESULTS_WIDTH_NARROW;

  const records = props.target.records;
  const names = entityNames(props.target.table);
  const heading =
    records.length > 1
      ? `Edit ${records.length} ${names?.[1] ?? `${props.target.table} records`}`
      : `Edit ${names?.[0] ?? props.target.table}`;
  const onClose = () => closeRecordEditor(props.tabId);

  /** The records the form is for, compared by identity-in-the-database rather
   * than by object identity: the resyncing the sidebar does as the selection
   * moves only yields a new key when it has genuinely landed on different
   * records — and only then is the form (and its load) rebuilt underneath the
   * user. */
  const formKey = identities(records).join(" ");

  return (
    <aside
      className="bg-panel border-edge relative flex shrink-0 flex-col border-l shadow-[-8px_0_16px_-4px_rgba(0,0,0,0.25)]"
      style={{
        width: `${width}px`,
        maxWidth: `calc(100% - ${minResultsWidth}px)`,
      }}
      aria-label={`Edit ${names?.[0] ?? props.target.table}`}
    >
      <SidebarResizeHandle
        edge="left"
        label="Resize record editor"
        maxWidth={(panel) => panel.parentElement!.clientWidth - minResultsWidth}
        onResize={setRecordSidebarWidth}
        onCommit={commitRecordSidebarWidth}
      />

      {/* The form needs the schema — its whole structure comes from
          introspection — which by this point has long since loaded, since
          running the query the rows came from needed it too. Until it has,
          the panel is its frame alone. */}
      {schemaJson === undefined ? (
        <>
          <PanelHeader heading={heading} onClose={onClose} />
          <div className="min-h-0 flex-1" />
        </>
      ) : (
        <PanelForm
          key={formKey}
          tabId={props.tabId}
          table={props.target.table}
          records={records}
          schemaJson={schemaJson}
          heading={heading}
          onClose={onClose}
        />
      )}
    </aside>
  );
}

/** The panel below its divider, for one set of records: the toolbar, a failed
 * save's message, and the form. Keyed on the records, so re-pointing the sidebar builds a fresh form rather than mutating this one.
 *
 * The form belongs to the tab rather than to this component (the forms store's
 * stash), so this takes it from there — creating it on first use — by the same
 * identities the form registers itself under, and hands it to both the toolbar
 * and `RecordForm`. Taking it here rather than inside `RecordForm` means the
 * panel never has to look it up in the stash while the form mounts. */
function PanelForm(props: {
  tabId: string;
  table: string;
  records: readonly RecordRef[];
  schemaJson: string;
  heading: string;
  onClose: () => void;
}): JSX.Element {
  const stores = useStores();
  const tables = useApp((s) => s.schema.tables);

  // This instance's subject is fixed for its life — different records mean a
  // different instance — so it's read once. `stashedForm` is idempotent (it
  // looks the stash up first), so StrictMode's second initializer call reuses
  // the model the first one stashed; the load waits for `RecordForm`'s effect.
  const [form] = useState(() => {
    const { tabId, table, records, schemaJson } = props;
    const ids = identities(records);
    const model = stores.forms.actions.stashedForm(tabId, ids, () =>
      createRecordForm({
        tables,
        table,
        keys: records.map((record) => record.key),
        schemaJson,
        // The save is a write *from* result rows, so it goes through the
        // store: what it changed is read back into the rows the editor was
        // opened on (see `query/rowDml.ts`).
        runDml: (operations) =>
          stores.app.actions.runRecordDml(tabId, records, operations),
        openRecords: (query, name) =>
          stores.app.actions.openRecordsTab(tabId, query, name),
      }),
    );
    return { identities: ids, model };
  });
  const { model } = form;

  const modified = useFormState(model, selectFormModified);
  const saving = useFormState(model, (s) => s.saving);
  const saveError = useFormState(model, (s) => s.saveError);

  return (
    <>
      <PanelHeader
        heading={props.heading}
        onClose={props.onClose}
        menu={<FormActionsMenu model={model} />}
      >
        {modified && (
          <>
            <ToolbarButton
              icon={Icons.Revert}
              label="Reset"
              disabled={saving}
              onClick={() => model.reset()}
            />
            <ToolbarButton
              icon={Icons.Save}
              label={saving ? "Saving…" : "Save"}
              disabled={saving}
              onClick={() => void model.save()}
            />
          </>
        )}
      </PanelHeader>

      {/* A save that failed says why, and keeps saying so until the next one (or
          it's dismissed). The changes it couldn't write are still in the form
          below. */}
      {saveError ? (
        <div
          role="alert"
          className="text-danger border-edge bg-danger/10 flex items-center gap-1 border-b py-1.5 pr-1.5 pl-2 text-xs"
        >
          <p className="min-w-0 flex-1">{saveError}</p>
          <IconButton
            icon={Icons.Close}
            label="Dismiss error"
            size="sm"
            onClick={() => model.clearSaveError()}
          />
        </div>
      ) : null}

      <ScrollArea className="p-2">
        <RecordForm
          tabId={props.tabId}
          identities={form.identities}
          model={model}
          schemaJson={props.schemaJson}
        />
      </ScrollArea>
    </>
  );
}
