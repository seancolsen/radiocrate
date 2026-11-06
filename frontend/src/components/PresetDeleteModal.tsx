import { useMemo, type JSX } from "react";
import { asSection, sectionNoun } from "../query/definition";
import { presetUsers, selectPreset, type Preset } from "../stores/app";
import { useApp, useAppActions } from "../stores/react";
import { Modal } from "./ui/Modal";

/** At most this many users are named; the rest are counted. */
const NAMED_USERS = 5;

/** The dialog's body, for the preset pending delete. */
function PresetDeleteModalBody(props: { preset: Preset }): JSX.Element {
  const { preset } = props;
  const tabs = useApp((s) => s.tabs);
  const sources = useApp((s) => s.sources.data);
  const { cancelPresetDelete, confirmPresetDelete } = useAppActions();
  const users = useMemo(
    () => presetUsers(tabs, sources, preset.id),
    [tabs, sources, preset.id],
  );
  const named = users.slice(0, NAMED_USERS);
  const more = users.length - named.length;

  return (
    <Modal onClose={() => cancelPresetDelete()} width="340px">
      <h2 className="text-ink mb-3 text-base font-semibold">Delete preset</h2>
      <p className="text-ink text-sm">
        Delete the {sectionNoun(asSection(preset.section)).toLowerCase()} preset{" "}
        <span className="font-medium">&ldquo;{preset.name}&rdquo;</span> for{" "}
        {preset.baseTable}?
      </p>
      {users.length > 0 && (
        <div className="text-accent mt-2 text-sm">
          <p>
            {users.length === 1
              ? "It's used by one query or playlist, which"
              : `It's used by ${users.length} queries and playlists, which`}{" "}
            won&rsquo;t run until it&rsquo;s taken out of them:
          </p>
          <ul className="mt-1 list-disc pl-5">
            {named.map((u) => (
              <li key={u.id}>
                {u.name === "" ? "New query" : u.name}
                <span className="text-ink-weak"> ({u.kind})</span>
              </li>
            ))}
            {more > 0 && <li>and {more} more</li>}
          </ul>
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          className="control text-ink hover:bg-hover rounded-md px-3"
          onClick={() => cancelPresetDelete()}
        >
          Cancel
        </button>
        <button
          type="button"
          className="control bg-danger rounded-md px-3 text-white"
          onClick={() => confirmPresetDelete()}
        >
          Delete
        </button>
      </div>
    </Modal>
  );
}

/** The delete-preset confirmation dialog. It names each query and playlist
 * that uses the preset, since deleting it leaves them referring to nothing.
 * Confirming deletes it; cancelling (button, scrim, or Esc) dismisses. */
export default function PresetDeleteModal(): JSX.Element | null {
  const preset = useApp((s) =>
    s.pendingPresetDelete === null
      ? undefined
      : selectPreset(s, s.pendingPresetDelete),
  );
  return preset ? <PresetDeleteModalBody preset={preset} /> : null;
}
