import type { JSX } from "react";
import { Icons } from "../icons";
import { useApp, useAppActions } from "../stores/react";
import { MenuItem } from "./ui/Menu";

/** The now-playing bar's overflow menu body: dismiss the bar, or jump back to
 * the playing track's result row. "Locate" is only live when the track has been
 * found in the current results. (Next sits on the bar itself.) */
export default function PlaybackActionsMenu(): JSX.Element {
  const rowIndex = useApp((s) => s.currentTrack?.rowIndex);
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
        disabled={rowIndex == null}
        onClick={() => actions.locateCurrentTrack()}
      />
    </>
  );
}
