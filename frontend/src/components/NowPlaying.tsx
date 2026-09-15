import { useRef, useState, type JSX, type PointerEvent } from "react";
import { Icons } from "../icons";
import { formatSeconds } from "../query/format";
import { useApp, useAppActions } from "../stores/react";
import IconButton from "./ui/IconButton";
import { Menu } from "./ui/Menu";
import { cx } from "./ui/cx";
import PlaybackActionsMenu from "./PlaybackActionsMenu";

const clamp01 = (x: number) => Math.min(Math.max(x, 0), 1);

/** The row under the title: time elapsed, the seek track, and time remaining.
 * The track is solid blue up to the playhead and translucent blue after it,
 * with a round knob at the playhead.
 *
 * Pressing anywhere on the track scrubs: the knob and both clocks follow the
 * pointer, and the audio seeks once, on release — seeking on every move would
 * restart the stream's range request each time. Pointer-only: the bare arrow
 * keys belong to the global keymap.
 *
 * Its own component so the position ticks re-render this row, not the bar. */
function Timeline(): JSX.Element {
  const position = useApp((s) => s.playback.position);
  const duration = useApp((s) => s.playback.duration);
  const { seek } = useAppActions();
  const trackRef = useRef<HTMLDivElement>(null);
  // The fraction of the track under the pointer while a scrub is in progress.
  const [scrub, setScrub] = useState<number | null>(null);

  const fractionAt = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    return rect && rect.width > 0
      ? clamp01((clientX - rect.left) / rect.width)
      : 0;
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (duration === null || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setScrub(fractionAt(e.clientX));
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      setScrub(fractionAt(e.clientX));
    }
  };
  // Capture is still held during `pointerup`; `lostpointercapture` follows it
  // (and a `pointercancel`) and ends the scrub either way.
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (duration === null || !e.currentTarget.hasPointerCapture(e.pointerId)) {
      return;
    }
    seek(fractionAt(e.clientX) * duration);
  };

  const shown =
    scrub !== null && duration !== null ? scrub * duration : position;
  const progress = duration === null ? 0 : clamp01(shown / duration);
  const total = duration === null ? null : Math.round(duration);
  // Whole seconds on both clocks, so elapsed + remaining always sum to the
  // track's length.
  const elapsed = Math.min(Math.floor(Math.max(shown, 0)), total ?? Infinity);
  const elapsedText = formatSeconds(elapsed);
  const totalText = total === null ? "-:--" : formatSeconds(total);
  const remainingText =
    total === null ? null : `−${formatSeconds(total - elapsed)}`;
  const pct = `${progress * 100}%`;

  return (
    <div className="flex h-4 items-center gap-2 pr-1">
      <span className="text-ink shrink-0 text-[11px] leading-none tabular-nums">
        {elapsedText}
      </span>
      <div
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={total ?? 0}
        aria-valuenow={elapsed}
        aria-valuetext={`${elapsedText} of ${totalText}`}
        className={cx("flex h-full min-w-0 flex-1 touch-none items-center", {
          "cursor-pointer": duration !== null,
        })}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onLostPointerCapture={() => setScrub(null)}
      >
        <div
          ref={trackRef}
          className="bg-timeline-rest relative h-[3px] w-full rounded-full"
        >
          <div
            className="bg-now-playing absolute inset-y-0 left-0 rounded-full"
            style={{ width: pct }}
          />
          <div
            className="bg-now-playing absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{ left: pct }}
          />
        </div>
      </div>
      {/* Blank until the length is known; the invisible placeholder holds the
          clock's width so the track doesn't resize when it arrives. */}
      <span
        className={cx(
          "text-ink shrink-0 text-[11px] leading-none tabular-nums",
          { invisible: remainingText === null },
        )}
      >
        {remainingText ?? "−0:00"}
      </span>
    </div>
  );
}

/** The now-playing bar: a round play/pause button on the left; beside it the
 * track's title and artists over the seek timeline, with Next and the overflow
 * menu at the right end of the title row. Renders nothing when no track is
 * loaded. */
export default function NowPlaying(): JSX.Element | null {
  const track = useApp((s) => s.currentTrack);
  const playing = useApp((s) => s.playback.playing);
  const hasNext = useApp((s) => s.playback.hasNext);
  const actions = useAppActions();

  if (!track) return null;

  return (
    <div
      data-testid="now-playing"
      className="bg-sheet border-edge flex h-[52px] shrink-0 items-center gap-3 border-t pr-2 pl-3"
    >
      <button
        type="button"
        aria-label={playing ? "Pause" : "Play"}
        className="bg-now-playing flex size-9 shrink-0 items-center justify-center rounded-full text-white hover:brightness-110"
        onClick={() => actions.togglePlayPause()}
      >
        {playing ? (
          <Icons.Pause className="size-6" />
        ) : (
          <Icons.Play className="size-6" />
        )}
      </button>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-[26px] items-center gap-1">
          <div className="flex min-w-0 flex-1 items-baseline gap-5">
            <span className="text-ink max-w-[60%] shrink-0 truncate text-sm">
              {track.title ?? ""}
            </span>
            <span className="text-ink-weak min-w-0 truncate text-xs">
              {track.artists.join(", ")}
            </span>
          </div>
          <IconButton
            icon={Icons.Next}
            label="Next"
            disabled={!hasNext}
            onClick={() => actions.skipNext()}
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
        <Timeline />
      </div>
    </div>
  );
}
