import { Show, type JSX } from "solid-js";
import { Icons } from "../icons";
import { useAppState } from "../state/store";
import IconButton from "./ui/IconButton";
import { Menu } from "./ui/Menu";
import PlaybackActionsMenu from "./PlaybackActionsMenu";

/** The played/remaining progress bar pinned to the bottom of the bar: two pills
 * with a gap between them, the played one in the accent blue. Display only —
 * there's no scrubbing here (the lock-screen scrubber handles that). */
function Timeline(props: { progress: number }): JSX.Element {
  // Each pill gives up half the 4px gap, so the boundary between them sits
  // exactly at the played fraction of the full track (`draw_now_playing_
  // timeline`). At zero progress the played pill is dropped entirely, which also
  // drops the flex gap.
  const played = () => `max(0px, calc(${props.progress * 100}% - 2px))`;
  return (
    <div
      aria-hidden="true"
      class="flex h-[4px] shrink-0 gap-[4px] px-[2px] pb-[2px]"
    >
      <Show when={props.progress > 0}>
        <div
          class="bg-accent-soft h-full rounded-full"
          style={{ width: played() }}
        />
      </Show>
      <div class="bg-timeline-rest h-full flex-1 rounded-full" />
    </div>
  );
}

/** The now-playing bar: the playing track's title and artists on the left, a
 * play/pause toggle and an overflow menu on the right, and the progress timeline
 * across the bottom. Renders nothing when no track is loaded. */
export default function NowPlaying(): JSX.Element {
  const store = useAppState();

  const track = () => store.state.currentTrack;
  const artists = () => track()?.artists.join(", ") ?? "";
  const playing = () => store.state.playback.playing;
  const progress = () => {
    const { position, duration } = store.state.playback;
    if (duration === null || duration <= 0) return 0;
    return Math.min(Math.max(position / duration, 0), 1);
  };

  return (
    <Show when={track()}>
      {(current) => (
        <div
          data-testid="now-playing"
          class="bg-sheet border-edge flex h-[40px] shrink-0 flex-col border-t"
        >
          <div class="flex min-h-0 flex-1 items-center gap-1 px-2">
            <div class="min-w-0 flex-1">
              <div class="text-ink truncate text-[13px] leading-[15px]">
                {current().title ?? ""}
              </div>
              <div class="text-ink-weak truncate text-[11px] leading-[12px]">
                {artists()}
              </div>
            </div>
            <IconButton
              icon={playing() ? Icons.Pause : Icons.Play}
              label={playing() ? "Pause" : "Play"}
              onClick={() => store.togglePlayPause()}
            />
            <Menu
              side="above"
              align="end"
              width="130px"
              trigger={(api) => (
                <IconButton
                  icon={Icons.More}
                  label="Playback actions"
                  active={api.open}
                  onClick={() => api.toggle()}
                />
              )}
            >
              <PlaybackActionsMenu />
            </Menu>
          </div>
          <Timeline progress={progress()} />
        </div>
      )}
    </Show>
  );
}
