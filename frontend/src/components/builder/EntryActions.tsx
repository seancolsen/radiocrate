import type { JSX } from "react";
import { Icons, type IconComponent } from "../../icons";
import {
  selectCanWriteFromRows,
  selectFilterApplied,
  selectPageTab,
  selectResultCount,
  selectSortApplied,
} from "../../stores/app";
import { useApp, useAppActions } from "../../stores/react";

// The writes a playlist's filter and sort builders offer at their foot, once a
// condition applies: the filter's "Remove these tracks" and "Keep only these
// tracks", and the sort's "Commit this track order to playlist". Each one turns
// the conditions on screen into a change to the playlist's entries, and then
// clears them (see "Filtering a playlist" and "Sorting a playlist" in the
// playlists spec).

/** A labeled builder button: an icon and its words, framed like the Shuffle
 * tab's Reshuffle. */
function ActionButton(props: {
  icon: IconComponent;
  label: string;
  disabled: boolean;
  onClick: () => void;
}): JSX.Element {
  const Icon = props.icon;
  return (
    <button
      type="button"
      disabled={props.disabled}
      className="border-edge text-ink enabled:hover:bg-hover flex items-center gap-1.5 rounded border px-2 py-0.5 text-sm disabled:opacity-40"
      onClick={props.onClick}
    >
      <Icon className="text-ink-weak size-4" />
      {props.label}
    </button>
  );
}

/** Whether `tabId` is a playlist's page. */
function useIsPlaylist(tabId: string): boolean {
  return useApp((s) => selectPageTab(s, tabId)?.kind === "playlist");
}

/** The filter builder's foot on a playlist whose filter applies: "Remove these
 * tracks" and "Keep only these tracks". Disabled while the rows on screen might
 * not be the filter's, and "Remove" also when the filter matched nothing.
 * Renders nothing anywhere else. */
export function FilterEntryActions(props: {
  tabId: string;
}): JSX.Element | null {
  const playlist = useIsPlaylist(props.tabId);
  const applied = useApp((s) => selectFilterApplied(s, props.tabId));
  const canWrite = useApp((s) => selectCanWriteFromRows(s, props.tabId));
  const matched = useApp((s) => (selectResultCount(s, props.tabId) ?? 0) > 0);
  const { removeMatching, keepMatching } = useAppActions();
  if (!playlist || !applied) return null;
  return (
    <div className="flex flex-wrap gap-2">
      <ActionButton
        icon={Icons.Delete}
        label="Remove these tracks"
        disabled={!canWrite || !matched}
        onClick={() => removeMatching(props.tabId)}
      />
      <ActionButton
        icon={Icons.Check}
        label="Keep only these tracks"
        disabled={!canWrite}
        onClick={() => keepMatching(props.tabId)}
      />
    </div>
  );
}

/** The sort builder's foot on a playlist whose sort applies: "Commit this
 * track order to playlist", disabled as the filter's buttons are. Renders
 * nothing anywhere else. */
export function SortEntryActions(props: { tabId: string }): JSX.Element | null {
  const playlist = useIsPlaylist(props.tabId);
  const applied = useApp((s) => selectSortApplied(s, props.tabId));
  const canWrite = useApp((s) => selectCanWriteFromRows(s, props.tabId));
  const { commitSort } = useAppActions();
  if (!playlist || !applied) return null;
  return (
    <div className="flex">
      <ActionButton
        icon={Icons.Check}
        label="Commit this track order to playlist"
        disabled={!canWrite}
        onClick={() => commitSort(props.tabId)}
      />
    </div>
  );
}
