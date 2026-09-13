import type { JSX } from "react";
import { Icons } from "../icons";
import { useApp, useAppActions } from "../stores/react";
import { MenuItem } from "./ui/Menu";

/** The now-playing bar's overflow menu body: skip to the next queued track,
 * dismiss the bar, or jump back to the playing track's result row. The last two
 * are only live when there is something to act on — "Locate" needs the track to
 * have been found in the current results. */
export default function PlaybackActionsMenu(): JSX.Element {
  const hasNext = useApp((s) => s.playback.hasNext);
  const rowIndex = useApp((s) => s.currentTrack?.rowIndex);
  const actions = useAppActions();
  return (
    <>
      <MenuItem
        icon={Icons.Next}
        label="Next"
        disabled={!hasNext}
        onClick={() => actions.skipNext()}
      />
      <MenuItem
        icon={Icons.Close}
        label="Close"
        onClick={() => actions.stopPlayback()}
      />
      <MenuItem
        icon={Icons.Locate}
        label="Locate"
        disabled={rowIndex == null}
        onClick={() => actions.locateCurrentTrack()}
      />
    </>
  );
}
