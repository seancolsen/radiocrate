import { useLayoutEffect, useRef, type JSX } from "react";
import {
  selectCanExport,
  selectRowSelection,
  type ExportData,
  type ExportRows,
} from "../stores/app";
import { useApp, useAppActions } from "../stores/react";
import { Modal } from "./ui/Modal";

/** The "Export data" dialog: which rows to export, and where to — the
 * clipboard, or a CSV file. Takes its values as props, like
 * {@link import("./SettingModal").SettingDialog}, so the visual harness can
 * render it without a store; {@link ExportDataModal} is the wired version.
 *
 * "Selected rows" is offered only while some are selected. Copy and Download
 * hand their click straight to the caller, which must start the clipboard
 * write or the save dialog within it. */
export function ExportDataDialog(props: {
  rows: ExportRows;
  selectedCount: number;
  canExport: boolean;
  error: string | null;
  onRowsChange: (rows: ExportRows) => void;
  onCopy: () => void;
  onDownload: () => void;
  onClose: () => void;
}): JSX.Element {
  const fieldRef = useRef<HTMLSelectElement>(null);
  useLayoutEffect(() => {
    fieldRef.current?.focus();
  }, []);

  return (
    <Modal onClose={() => props.onClose()} width="400px">
      <h2 className="text-ink mb-3 text-base font-semibold">Export data</h2>
      <form
        onSubmit={(e) => e.preventDefault()}
        className="flex items-center gap-3"
      >
        <label htmlFor="export-rows" className="text-ink text-sm">
          Rows
        </label>
        <select
          id="export-rows"
          ref={fieldRef}
          className="bg-panel border-edge text-ink focus:border-accent flex-1 rounded-md border px-2 py-1.5 text-sm outline-none"
          value={props.rows}
          onChange={(e) =>
            props.onRowsChange(e.currentTarget.value as ExportRows)
          }
        >
          <option value="all">All rows</option>
          <option value="selected" disabled={props.selectedCount === 0}>
            Selected rows
          </option>
        </select>
      </form>
      {props.error !== null && (
        <p role="alert" className="text-danger mt-3 text-sm">
          {props.error}
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          className="text-ink hover:bg-hover mr-auto rounded-md px-3 py-1.5 text-sm"
          onClick={() => props.onClose()}
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!props.canExport}
          className="text-ink border-edge hover:bg-hover rounded-md border px-3 py-1.5 text-sm disabled:opacity-40"
          onClick={() => props.onCopy()}
        >
          Copy to clipboard
        </button>
        <button
          type="button"
          disabled={!props.canExport}
          className="bg-accent text-panel rounded-md px-3 py-1.5 text-sm disabled:opacity-40"
          onClick={() => props.onDownload()}
        >
          Download CSV
        </button>
      </div>
    </Modal>
  );
}

/** The export dialog wired to the store, for the page `pending` names. Its own
 * component so the rows field is focused afresh each time the dialog opens. */
function ExportDataModalBody(props: { pending: ExportData }): JSX.Element {
  const { tabId, rows, error } = props.pending;
  const selectedCount = useApp((s) => selectRowSelection(s, tabId).size);
  const canExport = useApp(selectCanExport);
  const { setExportRows, copyExportData, downloadExportData, closeExportData } =
    useAppActions();

  return (
    <ExportDataDialog
      rows={rows}
      selectedCount={selectedCount}
      canExport={canExport}
      error={error}
      onRowsChange={setExportRows}
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
