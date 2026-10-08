import { useLayoutEffect, useMemo, useRef, type JSX } from "react";
import { exportCellText, hasFormatting } from "../query/exportCsv";
import {
  selectCanExport,
  selectRowSelection,
  type ExportData,
  type ExportRows,
} from "../stores/app";
import { useApp, useAppActions } from "../stores/react";
import { Icons } from "../icons";
import { Checkbox } from "./ui/Checkbox";
import IconButton from "./ui/IconButton";
import { Modal } from "./ui/Modal";

/** One visible result column as the export dialog lists it. */
export interface ExportColumnOption {
  /** The column's `ResultColumn.index`, which the choices are keyed by. */
  index: number;
  /** "Column 0", "Column 1", … by position among the visible columns. */
  label: string;
  /** One of its cells as it would be exported. */
  sample: string;
  /** Whether it has a formatter, prefix or suffix — and so a choice between
   * its displayed and raw data. */
  formatted: boolean;
  included: boolean;
  raw: boolean;
}

const BUTTON_CLASS =
  "text-ink border-edge hover:bg-hover flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm disabled:opacity-40";

/** A button that shows its border only on hover or focus. */
const QUIET_BUTTON_CLASS =
  "text-ink enabled:hover:border-edge focus-visible:border-accent flex items-center gap-1 rounded-md border border-transparent px-1.5 py-0.5 text-sm outline-none disabled:opacity-40";

const SELECT_CLASS =
  "bg-panel border-edge text-ink focus:border-accent rounded-md border px-2 py-1.5 text-sm outline-none";

/** The "Export data" dialog: which rows and columns to export, and where to —
 * the clipboard, or a CSV file. Takes its values as props, like
 * {@link import("./SettingModal").SettingDialog}, so the visual harness can
 * render it without a store; {@link ExportDataModal} is the wired version.
 *
 * The Rows field shows only while some rows are selected; with none, every row
 * is exported. The column list is folded away under a "Columns" summary that
 * counts the columns checked. Copy and Download hand their click straight to
 * the caller, which must start the clipboard write or the save dialog within
 * it. */
export function ExportDataDialog(props: {
  rows: ExportRows;
  selectedCount: number;
  columns: readonly ExportColumnOption[];
  canExport: boolean;
  error: string | null;
  onRowsChange: (rows: ExportRows) => void;
  onAllColumnsIncludedChange: (included: boolean) => void;
  onColumnIncludedChange: (column: number, included: boolean) => void;
  onColumnRawChange: (column: number, raw: boolean) => void;
  onCopy: () => void;
  onDownload: () => void;
  onClose: () => void;
}): JSX.Element {
  const showRows = props.selectedCount > 0;
  const rowsRef = useRef<HTMLSelectElement>(null);
  const columnsRef = useRef<HTMLElement>(null);
  // The first field takes focus as the dialog opens.
  useLayoutEffect(() => {
    (rowsRef.current ?? columnsRef.current)?.focus();
  }, []);

  const total = props.columns.length;
  const included = props.columns.filter((c) => c.included).length;

  return (
    <Modal onClose={() => props.onClose()} width="480px">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-ink text-base font-semibold">Export data</h2>
        <IconButton
          icon={Icons.Close}
          label="Close"
          onClick={() => props.onClose()}
        />
      </div>
      <form
        onSubmit={(e) => e.preventDefault()}
        className="flex flex-col gap-4"
      >
        {showRows && (
          <div className="flex items-center gap-3">
            <label htmlFor="export-rows" className="text-ink text-sm">
              Rows
            </label>
            <select
              id="export-rows"
              ref={rowsRef}
              className={`${SELECT_CLASS} flex-1`}
              value={props.rows}
              onChange={(e) =>
                props.onRowsChange(e.currentTarget.value as ExportRows)
              }
            >
              <option value="all">All rows</option>
              <option value="selected">Selected rows</option>
            </select>
          </div>
        )}
        {/* Check all / Uncheck all sit at the right of the summary's line, but
            outside the summary itself — a button nested in the toggle would
            be an interactive control inside another — and so show only while
            the list is unfolded. */}
        <details className="group/columns relative">
          <summary
            ref={columnsRef}
            className="text-ink focus-visible:ring-accent -mx-1 flex min-h-7 w-fit cursor-pointer items-center gap-1 rounded-sm px-1 text-sm outline-none select-none focus-visible:ring-2 [&::-webkit-details-marker]:hidden"
          >
            <Icons.ExpandClosed className="text-ink-weak size-4 group-open/columns:rotate-90" />
            Columns
            <span className="text-ink-weak">
              ({included === total ? "All" : `${included}/${total}`})
            </span>
          </summary>
          <div className="absolute top-0 right-0 flex h-7 items-center gap-1">
            <button
              type="button"
              disabled={included === total}
              className={QUIET_BUTTON_CLASS}
              onClick={() => props.onAllColumnsIncludedChange(true)}
            >
              <Icons.CheckAll className="size-4" />
              Check all
            </button>
            <button
              type="button"
              disabled={included === 0}
              className={QUIET_BUTTON_CLASS}
              onClick={() => props.onAllColumnsIncludedChange(false)}
            >
              <Icons.UncheckAll className="size-4" />
              Uncheck all
            </button>
          </div>
          <div className="mt-2 flex flex-col gap-2 pl-5">
            {props.columns.map((column) => (
              <ColumnRow
                key={column.index}
                column={column}
                onIncludedChange={(included) =>
                  props.onColumnIncludedChange(column.index, included)
                }
                onRawChange={(raw) =>
                  props.onColumnRawChange(column.index, raw)
                }
              />
            ))}
          </div>
        </details>
      </form>
      {props.error !== null && (
        <p role="alert" className="text-danger mt-3 text-sm">
          {props.error}
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          disabled={!props.canExport}
          className={BUTTON_CLASS}
          onClick={() => props.onCopy()}
        >
          <Icons.Copy className="size-4" />
          Copy to clipboard
        </button>
        <button
          type="button"
          disabled={!props.canExport}
          className="bg-accent text-panel flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm disabled:opacity-40"
          onClick={() => props.onDownload()}
        >
          <Icons.Download className="size-4" />
          Download CSV
        </button>
      </div>
    </Modal>
  );
}

/** One column's line in the list: whether it's exported, a sample of it, and —
 * for a formatted column — whether as displayed or raw. */
function ColumnRow(props: {
  column: ExportColumnOption;
  onIncludedChange: (included: boolean) => void;
  onRawChange: (raw: boolean) => void;
}): JSX.Element {
  const { column } = props;
  return (
    <div className="flex min-h-8 items-center gap-3">
      <Checkbox
        label={column.label}
        checked={column.included}
        onChange={(included) => props.onIncludedChange(included)}
      />
      <span
        className="text-ink-weak min-w-0 flex-1 truncate text-sm"
        title={column.sample}
      >
        {column.sample}
      </span>
      {column.formatted && (
        <select
          aria-label={`${column.label} data`}
          className={SELECT_CLASS}
          value={column.raw ? "raw" : "displayed"}
          onChange={(e) => props.onRawChange(e.currentTarget.value === "raw")}
        >
          <option value="displayed">Displayed data</option>
          <option value="raw">Raw data</option>
        </select>
      )}
    </div>
  );
}

/** The export dialog wired to the store, for the page `pending` names. Its own
 * component so the first field is focused afresh each time the dialog opens. */
function ExportDataModalBody(props: { pending: ExportData }): JSX.Element {
  const { tabId, rows, excludedColumns, rawColumns, error } = props.pending;
  const result = useApp((s) => s.pages[tabId]?.result);
  const selection = useApp((s) => selectRowSelection(s, tabId));
  const canExport = useApp(selectCanExport);
  const {
    setExportRows,
    setExportAllColumnsIncluded,
    setExportColumnIncluded,
    setExportColumnRaw,
    copyExportData,
    downloadExportData,
    closeExportData,
  } = useAppActions();

  const columns = useMemo((): ExportColumnOption[] => {
    if (!result) return [];
    // Samples come from the first selected row, or the first row with none.
    let sampleRow: number | undefined;
    for (const row of selection) {
      if (row < result.rowCount && (sampleRow === undefined || row < sampleRow))
        sampleRow = row;
    }
    if (sampleRow === undefined && result.rowCount > 0) sampleRow = 0;
    return result.visible.map((column, position) => {
      const raw = rawColumns.includes(column.index);
      return {
        index: column.index,
        label: `Column ${position}`,
        sample:
          sampleRow === undefined
            ? ""
            : exportCellText(result, sampleRow, column, raw),
        formatted: hasFormatting(column.meta),
        included: !excludedColumns.includes(column.index),
        raw,
      };
    });
  }, [result, selection, excludedColumns, rawColumns]);

  return (
    <ExportDataDialog
      rows={rows}
      selectedCount={selection.size}
      columns={columns}
      canExport={canExport}
      error={error}
      onRowsChange={setExportRows}
      onAllColumnsIncludedChange={setExportAllColumnsIncluded}
      onColumnIncludedChange={setExportColumnIncluded}
      onColumnRawChange={setExportColumnRaw}
      onCopy={copyExportData}
      onDownload={downloadExportData}
      onClose={closeExportData}
    />
  );
}

/** The export dialog's mount point: an app-wide overlay, raised by the wrench
 * menu's "Export results data" on a query or playlist page. */
export default function ExportDataModal(): JSX.Element | null {
  const pending = useApp((s) => s.exportData);
  return pending ? <ExportDataModalBody pending={pending} /> : null;
}
