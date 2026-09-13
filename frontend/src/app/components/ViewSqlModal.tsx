import type { JSX } from "react";
import { useApp, useAppActions } from "../stores/react";
import { Modal } from "./ui/Modal";

/** The "View SQL" dialog: the working query compiled to DuckDB SQL (read-only).
 * Compilation happens in `openViewSql`; this just displays the result. */
export default function ViewSqlModal(): JSX.Element | null {
  const sql = useApp((s) => s.viewSql);
  const { closeViewSql } = useAppActions();

  if (sql == null) return null;

  return (
    <Modal onClose={() => closeViewSql()} width="640px">
      <h2 className="text-ink mb-3 text-base font-semibold">SQL</h2>
      <pre className="bg-sheet text-ink max-h-[60vh] overflow-auto rounded-md p-3 font-mono text-xs leading-5 whitespace-pre-wrap">
        {sql}
      </pre>
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          className="text-ink hover:bg-hover rounded-md px-3 py-1.5 text-sm"
          onClick={() => closeViewSql()}
        >
          Close
        </button>
      </div>
    </Modal>
  );
}
