import type { JSX } from "react";
import { Icons } from "../icons";
import { audioFileCount } from "../record/audioFiles";
import type { DeleteChoices, PlanItem } from "../record/deletePlan";
import type { LeftoverFolder } from "api-client";
import {
  audioFilesLabel,
  audioFilesNote,
  blockedNote,
  deleteTitle,
  folderContents,
  folderName,
  itemLabel,
  itemNote,
  leftoverFoldersLabel,
  leftoverFoldersNote,
  missingNote,
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
 * with their album take their credits with them. Those lines are nested under
 * the one that brought them, so the lines make a tree of what leads to what.
 *
 * When the deletion takes `file` records, one more checkbox, checked unless the
 * user unchecked it the last time, deletes their audio files from disk too.
 * Under it, when that would leave folders with no audio in them but other
 * files (cover art, a cue sheet, a rip log), another deletes those folders
 * whole, naming each and what's in it. That one is unchecked unless the user
 * checked it the last time, and can only be checked along with the audio.
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
    setRecordDeleteFolders,
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
      <p className="text-ink text-sm">
        {nothingLeft ? missing : <>This can&rsquo;t be undone.</>}
      </p>
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
          <PlanItemList
            parent={null}
            items={summary.items}
            choices={choices}
            disabled={deleting}
            onChange={(item, checked) =>
              setRecordDeleteChoice(item.kind, item.relationship.id, checked)
            }
          />
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
          {pending.leftoverFolders.length > 0 && (
            <div className="mt-2 ml-6">
              <Checkbox
                label={leftoverFoldersLabel(pending.leftoverFolders)}
                description={leftoverFoldersNote(pending.leftoverFolders)}
                checked={pending.deleteAudioFiles && pending.deleteFolders}
                disabled={!pending.deleteAudioFiles || deleting}
                onChange={(checked) => setRecordDeleteFolders(checked)}
              />
              <FolderList
                folders={pending.leftoverFolders}
                dimmed={!pending.deleteAudioFiles}
              />
            </div>
          )}
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

/** The lines of a plan under `parent` (`null` for the top level), each with
 * its own lines nested under it. */
function PlanItemList(props: {
  parent: string | null;
  items: readonly PlanItem[];
  choices: DeleteChoices;
  disabled: boolean;
  onChange: (item: PlanItem, checked: boolean) => void;
}): JSX.Element | null {
  const { parent, items, choices, disabled, onChange } = props;
  const children = items.filter((item) => item.parent === parent);
  if (children.length === 0) return null;
  return (
    <ul
      className={cx("mt-2 flex flex-col gap-2", {
        "border-edge ml-2 border-l pl-4": parent !== null,
      })}
    >
      {children.map((item) => (
        <li key={item.id}>
          <Checkbox
            label={itemLabel(item)}
            description={itemNote(item)}
            // The choice as it stands, which is ahead of the plan while the
            // plan for it is being worked out.
            checked={
              item.required || choices[item.kind][item.relationship.id] === true
            }
            disabled={item.required || disabled}
            onChange={(checked) => onChange(item, checked)}
          />
          <PlanItemList {...props} parent={item.id} />
        </li>
      ))}
    </ul>
  );
}

/** How many folders the list names before it counts the rest. */
const LISTED_FOLDERS = 4;

/** The folders the "Delete the rest of the folder" checkbox would delete:
 * each one's name, and what's in it, in brief. A name cut short by the
 * dialog's width, and the whole list of files, show on hover. */
function FolderList(props: {
  folders: readonly LeftoverFolder[];
  dimmed: boolean;
}): JSX.Element {
  const { folders, dimmed } = props;
  const listed = folders.slice(0, LISTED_FOLDERS);
  const more = folders.length - listed.length;
  return (
    <ul
      aria-label="Folders"
      className={cx("mt-1 ml-6 flex flex-col gap-1 text-xs", {
        "opacity-50": dimmed,
      })}
    >
      {listed.map((folder) => (
        <li
          key={folder.path}
          title={`${folderName(folder)}\n${folder.files.join("\n")}`}
        >
          <span className="text-ink block truncate">{folderName(folder)}</span>
          <span className="text-ink-weak block break-words">
            {folderContents(folder)}
          </span>
        </li>
      ))}
      {more > 0 && (
        <li className="text-ink-weak">
          and {more.toLocaleString("en-US")} more{" "}
          {more === 1 ? "folder" : "folders"}
        </li>
      )}
    </ul>
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
