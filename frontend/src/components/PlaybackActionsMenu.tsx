import type { JSX } from "react";
import { Icons } from "../icons";
import { selectQueueLength } from "../stores/app";
import { useApp, useAppActions } from "../stores/react";
import { MenuItem } from "./ui/Menu";

/** The now-playing bar's overflow menu body: dismiss the bar, jump back to the
 * playing track's result row, or empty the queue. "Locate" is only live when
 * the track has been found in the current results, and "Clear queue" is only
 * there while something is queued. (Next sits on the bar itself.) */
export default function PlaybackActionsMenu(): JSX.Element {
  const rowIndex = useApp((s) => s.currentTrack?.rowIndex);
  const queued = useApp(selectQueueLength);
  const actions = useAppActions();
  return (
    <>
      <MenuItem
        icon={Icons.Close}
        label="Close"
        onClick={() => actions.stopPlayback()}
      />
      <MenuItem
        icon={Icons.Locate}
        label="Locate"
        command="results.go_to_playing_track"
        disabled={rowIndex == null}
        onClick={() => actions.locateCurrentTrack()}
      />
      {queued > 0 && (
        <MenuItem
          icon={Icons.ClearQueue}
          label="Clear queue"
          command="queue.clear"
          onClick={() => actions.clearQueue()}
        />
      )}
    </>
  );
}
