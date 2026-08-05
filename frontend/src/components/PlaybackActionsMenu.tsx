import { type JSX } from "solid-js";
import { Icons } from "../icons";
import { useAppState } from "../state/store";
import { MenuItem } from "./ui/Menu";

/** The now-playing bar's overflow menu body: skip to the next queued track,
 * dismiss the bar, or jump back to the playing track's result row. The last two
 * are only live when there is something to act on — "Locate" needs the track to
 * have been found in the current results. */
export default function PlaybackActionsMenu(): JSX.Element {
  const store = useAppState();
  return (
    <>
      <MenuItem
        icon={Icons.Next}
        label="Next"
        disabled={!store.state.playback.hasNext}
        onClick={() => store.skipNext()}
      />
      <MenuItem
        icon={Icons.Close}
        label="Close"
        onClick={() => store.stopPlayback()}
      />
      <MenuItem
        icon={Icons.Locate}
        label="Locate"
        disabled={store.state.currentTrack?.rowIndex == null}
        onClick={() => store.locateCurrentTrack()}
      />
    </>
  );
}
