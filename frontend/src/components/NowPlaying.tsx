import { useState, type JSX, type PointerEvent } from "react";
import type { LoadedRange } from "../audio/engine";
import { Icons } from "../icons";
import { formatSeconds } from "../query/format";
import { useApp, useAppActions } from "../stores/react";
import IconButton from "./ui/IconButton";
import { Menu } from "./ui/Menu";
import { useTooltip } from "./ui/Tooltip";
import { cx } from "./ui/cx";
import PlaybackActionsMenu from "./PlaybackActionsMenu";

const clamp01 = (x: number) => Math.min(Math.max(x, 0), 1);

/** The play button's look: a blue disc around a white glyph. Exported for the
 * kitchen sink, which shows its faces without a store behind them. */
export const PLAY_BUTTON_CLASS =
  "bg-now-playing relative flex size-9 shrink-0 items-center justify-center rounded-full text-white hover:brightness-110";

/** What the play button shows: Pause while the track plays (or is about to),
 * Play while it's paused, and Retry once it has failed — ringed by a spinning
 * arc while the track waits on data. */
export function PlayButtonFace(props: {
  playing: boolean;
  loading: boolean;
  failed: boolean;
}): JSX.Element {
  const Glyph = props.failed
    ? Icons.Refresh
    : props.playing
      ? Icons.Pause
      : Icons.Play;
  return (
    <>
      <Glyph className="size-6" />
      {props.loading && <LoadingRing />}
    </>
  );
}

/** A quarter arc spinning just outside the play button. It fades in only after
 * a moment, so the short waits — a seek within what's downloaded, a boundary
 * crossed onto a pre-buffered track — don't flash it. */
function LoadingRing(): JSX.Element {
  return (
    <svg
      viewBox="0 0 44 44"
      aria-hidden
      className="text-now-playing pointer-events-none absolute -top-1 -left-1 size-11 animate-spin transition-opacity delay-200 duration-150 starting:opacity-0"
    >
      <circle
        cx="22"
        cy="22"
        r="21"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="33 100"
      />
    </svg>
  );
}

/** The seek track itself: solid blue up to the playhead, with a round knob
 * there; past it, deeper translucent blue over what has downloaded and paler
 * over what hasn't. `progress` and the `loaded` stretches are fractions of the
 * track. */
export function TimelineTrack(props: {
  progress: number;
  loaded: readonly LoadedRange[];
}): JSX.Element {
  const pct = `${props.progress * 100}%`;
  return (
    <div className="bg-timeline-rest relative h-[3px] w-full rounded-full">
      {props.loaded.map(([start, end]) => (
        <div
          key={start}
          className="bg-timeline-loaded absolute inset-y-0 rounded-full"
          style={{ left: `${start * 100}%`, width: `${(end - start) * 100}%` }}
        />
      ))}
      <div
        className="bg-now-playing absolute inset-y-0 left-0 rounded-full"
        style={{ width: pct }}
      />
      <div
        className="bg-now-playing absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{ left: pct }}
      />
    </div>
  );
}

/** Why the track couldn't be played, in the timeline's place. */
export function PlaybackError(props: { message: string }): JSX.Element {
  return (
    <div
      role="alert"
      className="text-danger flex h-4 min-w-0 items-center gap-1 pr-1 text-[11px] leading-none"
    >
      <Icons.QueryError className="size-3.5 shrink-0" />
      <span className="truncate">{props.message}</span>
    </div>
  );
}

/** The row under the title: time elapsed, the seek track, and time remaining.
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
  const buffered = useApp((s) => s.playback.buffered);
  // The cached-audio overlay is a troubleshooting aid: only with logging on.
  const logging = useApp((s) => s.logging);
  const { seek } = useAppActions();
  // The fraction of the track under the pointer while a scrub is in progress.
  const [scrub, setScrub] = useState<number | null>(null);

  // The slider spans exactly the width of the track drawn inside it.
  const fractionAt = (e: PointerEvent<HTMLDivElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect();
    return rect.width > 0 ? clamp01((e.clientX - rect.left) / rect.width) : 0;
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (duration === null || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setScrub(fractionAt(e));
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      setScrub(fractionAt(e));
    }
  };
  // Capture is still held during `pointerup`; `lostpointercapture` follows it
  // (and a `pointercancel`) and ends the scrub either way.
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (duration === null || !e.currentTarget.hasPointerCapture(e.pointerId)) {
      return;
    }
    seek(fractionAt(e) * duration);
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
  const loaded: LoadedRange[] =
    duration === null || !logging
      ? []
      : buffered.map(([start, end]) => [
          clamp01(start / duration),
          clamp01(end / duration),
        ]);

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
        <TimelineTrack progress={progress} loaded={loaded} />
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
 * track's title and artists over the seek timeline (or, when the track
 * couldn't be played, why not), with Next and the overflow menu at the right
 * end of the title row. Renders nothing when no track is loaded. */
export default function NowPlaying(): JSX.Element | null {
  const track = useApp((s) => s.currentTrack);
  const playing = useApp((s) => s.playback.playing);
  const loading = useApp((s) => s.playback.loading);
  const error = useApp((s) => s.playback.error);
  const hasNext = useApp((s) => s.playback.hasNext);
  const actions = useAppActions();
  const { triggerProps, tooltip } = useTooltip({
    // Play on a failed track loads it again.
    label: error !== null ? "Retry" : playing ? "Pause" : "Play",
    command: "playback.toggle_play",
  });

  if (!track) return null;

  return (
    <div
      data-testid="now-playing"
      className="bg-sheet border-edge flex h-[52px] shrink-0 items-center gap-3 border-t pr-2 pl-3"
    >
      <button
        type="button"
        {...triggerProps}
        aria-busy={loading}
        className={PLAY_BUTTON_CLASS}
        onClick={() => actions.togglePlayPause()}
      >
        <PlayButtonFace
          playing={playing}
          loading={loading}
          failed={error !== null}
        />
      </button>
      {tooltip}
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
            command="playback.next_track"
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
        {error !== null ? <PlaybackError message={error} /> : <Timeline />}
      </div>
    </div>
  );
}
