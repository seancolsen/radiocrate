import type { JSX } from "react";
import { Icons } from "../icons";
import {
  audioFileCount,
  audioFilesLabel,
  audioFilesNote,
  blockedNote,
  deleteTitle,
  itemLabel,
  itemNote,
  missingNote,
  recordCount,
  recordNoun,
  totalsNote,
} from "../record/deleteText";
import type { RecordDelete } from "../stores/app";
import { useApp, useAppActions } from "../stores/react";
import { Checkbox } from "./ui/Checkbox";
import { cx } from "./ui/cx";
import { Modal } from "./ui/Modal";

/** The dialog's body, for the deletion pending.
 *
 * It says what deleting the records takes, a line for each relationship the
 * deletion reaches (`record/deletePlan.ts`): the records that refer to a
 * deleted one, and the records a deleted one leaves with nothing referring to
 * them. Each line is a checkbox for whether those records are deleted too.
 * It's checked and can't be changed where they can't be kept, and unchecked to
 * begin with everywhere else, unless the user checked it the last time.
 * Changing one works the plan out again, which can add lines: tracks deleted
 * with their album take their credits with them.
 *
 * When the deletion takes `file` records, one more checkbox, checked unless the
 * user unchecked it the last time, deletes their audio files from disk too.
 *
 * The lines stay up while a plan is being worked out, showing the last one's
 * counts, and Delete waits for the new one. */
function RecordDeleteModalBody(props: { pending: RecordDelete }): JSX.Element {
  const { pending } = props;
  const {
    cancelRecordDelete,
    confirmRecordDelete,
    setRecordDeleteAudioFiles,
    setRecordDeleteChoice,
  } = useAppActions();
  const { summary, status, choices } = pending;
  const planning = status === "planning";
  const deleting = status === "deleting";
  const missing =
    summary && missingNote(pending.table, pending.count, summary.found);
  const nothingLeft = summary?.found === 0;
  const blocked = summary?.blocked ?? [];
  const totals = summary && totalsNote(summary);
  const audioFiles = summary ? audioFileCount(summary) : 0;
  const canDelete =
    status === "ready" &&
    summary !== null &&
    pending.error === null &&
    blocked.length === 0;

  return (
    <Modal
      title={deleteTitle(pending.table, pending.count)}
      onClose={() => cancelRecordDelete()}
      width="400px"
    >
      {nothingLeft ? (
        <p className="text-ink text-sm">{missing}</p>
      ) : (
        <p className="text-ink text-sm">
          Delete{" "}
          <span className="font-medium">
            {pending.count === 1
              ? `this ${recordNoun(pending.table, 1)}`
              : recordCount(pending.table, summary?.found ?? pending.count)}
          </span>
          ? This can&rsquo;t be undone.
        </p>
      )}
      {missing && !nothingLeft && (
        <p className="text-ink-weak mt-1 text-sm">{missing}</p>
      )}

      {summary === null && pending.error === null && (
        <p className="text-ink-weak mt-3 flex items-center gap-2 text-sm">
          <Icons.Spinner className="size-4" />
          Looking for the records tied to {pending.count === 1 ? "it" : "them"}
          &hellip;
        </p>
      )}

      {summary !== null && summary.items.length > 0 && (
        <div className="mt-3" aria-busy={planning}>
          <p className="text-ink-weak text-sm">
            Other records are tied to {pending.count === 1 ? "it" : "them"}:
          </p>
          <ul className="mt-2 flex flex-col gap-2">
            {summary.items.map((item) => (
              <li key={item.id}>
                <Checkbox
                  label={itemLabel(item)}
                  description={itemNote(item)}
                  // The choice as it stands, which is ahead of the plan while
                  // the plan for it is being worked out.
                  checked={
                    item.required ||
                    choices[item.kind][item.relationship.id] === true
                  }
                  disabled={item.required || deleting}
                  onChange={(checked) =>
                    setRecordDeleteChoice(
                      item.kind,
                      item.relationship.id,
                      checked,
                    )
                  }
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      {audioFiles > 0 && (
        <div className="mt-3" aria-busy={planning}>
          <Checkbox
            label={audioFilesLabel(audioFiles)}
            description={audioFilesNote(audioFiles)}
            checked={pending.deleteAudioFiles}
            disabled={deleting}
            onChange={(checked) => setRecordDeleteAudioFiles(checked)}
          />
        </div>
      )}

      {blocked.map((item) => (
        <p key={item.relationship.id} className="text-danger mt-3 text-sm">
          {blockedNote(item)}
        </p>
      ))}

      {totals !== undefined && totals !== null && (
        <p
          className={cx("text-ink-weak mt-3 text-sm", {
            "opacity-50": planning,
          })}
        >
          {totals}
        </p>
      )}

      {pending.error !== null && (
        <p role="alert" className="text-danger mt-3 text-sm break-words">
          {pending.error}
        </p>
      )}

      <div className="mt-4 flex items-center justify-end gap-2">
        {summary !== null && (planning || deleting) && (
          <span className="text-ink-weak mr-auto flex items-center gap-2 text-sm">
            <Icons.Spinner className="size-4" />
            {deleting ? "Deleting…" : "Working it out…"}
          </span>
        )}
        <button
          type="button"
          className="control text-ink hover:bg-hover rounded-md disabled:opacity-40"
          disabled={deleting}
          onClick={() => cancelRecordDelete()}
        >
          Cancel
        </button>
        <button
          type="button"
          className="control bg-danger rounded-md text-white disabled:opacity-40"
          disabled={!canDelete || nothingLeft}
          onClick={() => confirmRecordDelete()}
        >
          Delete
        </button>
      </div>
    </Modal>
  );
}

/** The "Delete records" confirmation dialog, raised from a result row's menu
 * on the records its rows identify. Confirming deletes them, and whatever the
 * dialog's lines say goes with them, in one request; cancelling (button, ×,
 * scrim, or Esc) dismisses, though not while the deletion is in flight. */
export default function RecordDeleteModal(): JSX.Element | null {
  const pending = useApp((s) => s.recordDelete);
  return pending ? <RecordDeleteModalBody pending={pending} /> : null;
}
