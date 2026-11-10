import { useLayoutEffect, useRef, type JSX } from "react";
import { Icons } from "../icons";
import {
  LOG_SOURCE_NAMES,
  MAX_LOG_ENTRIES,
  formatLogDate,
  formatLogTime,
  sameLogDay,
  type LogEntry,
} from "../log/log";
import { useApp, useAppActions } from "../stores/react";
import HelpPopover from "./ui/HelpPopover";

// The Logging page: a tab holding the app's log (see `log/log.ts`) under a
// toolbar of Start/Stop logging · Copy log · Clear log … and, at the far
// right, a "?" whose popover says what the log is, how to use it, and how to
// read the playback entries.
//
// The log reads oldest first, as it does when copied, and keeps to its newest
// entry as entries arrive, unless the user has scrolled up to read.

const TOOLBAR_BUTTON =
  "text-ink hover:bg-hover flex h-[26px] shrink-0 items-center gap-1.5 rounded px-2 text-sm disabled:opacity-40 disabled:hover:bg-transparent";

/** How close to the foot of the log, in px, still counts as at the foot. */
const FOOT_SLACK = 8;

export default function LogPage(): JSX.Element {
  const logging = useApp((s) => s.logging);
  const entries = useApp((s) => s.logEntries);
  const { startLogging, stopLogging, copyLog, clearLog } = useAppActions();

  return (
    <div
      data-testid="log-page"
      className="bg-panel flex min-h-0 flex-1 flex-col"
    >
      <div className="border-edge flex h-[38px] shrink-0 items-center gap-1 border-b px-1.5">
        {logging ? (
          <button
            type="button"
            className={TOOLBAR_BUTTON}
            onClick={() => stopLogging()}
          >
            <Icons.StopLogging className="text-ink-weak size-4" />
            Stop logging
          </button>
        ) : (
          <button
            type="button"
            className={TOOLBAR_BUTTON}
            onClick={() => startLogging()}
          >
            <Icons.StartLogging className="text-ink-weak size-4" />
            Start logging
          </button>
        )}
        {entries.length > 0 && (
          <>
            <button
              type="button"
              className={TOOLBAR_BUTTON}
              onClick={() => copyLog()}
            >
              <Icons.Copy className="text-ink-weak size-4" />
              Copy log
            </button>
            <button
              type="button"
              className={TOOLBAR_BUTTON}
              onClick={() => clearLog()}
            >
              <Icons.Delete className="text-ink-weak size-4" />
              Clear log
            </button>
          </>
        )}
        <div className="flex-1" />
        <HelpPopover label="About logging" align="end">
          <LogHelp />
        </HelpPopover>
      </div>
      {entries.length > 0 ? (
        <LogEntries entries={entries} />
      ) : (
        <p className="text-ink-weak mx-auto max-w-md px-4 py-8 text-center text-sm">
          {logging
            ? "Nothing has been logged yet."
            : "Logging is off. Start logging, make the problem happen, then copy the log into your report."}
        </p>
      )}
    </div>
  );
}

/** The entries, oldest first, with the date wherever it changes. */
function LogEntries(props: { entries: readonly LogEntry[] }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the view is at its foot, so a new entry should scroll into view.
  // Written by the scroll handler, read when entries arrive.
  const atFoot = useRef(true);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atFoot.current) el.scrollTop = el.scrollHeight;
  }, [props.entries]);

  return (
    <div
      ref={scrollRef}
      data-testid="log-entries"
      className="min-h-0 flex-1 overflow-y-auto py-2"
      onScroll={(e) => {
        const el = e.currentTarget;
        atFoot.current =
          el.scrollHeight - el.scrollTop - el.clientHeight <= FOOT_SLACK;
      }}
    >
      {props.entries.map((entry, i) => {
        const previous = props.entries[i - 1];
        return (
          <div key={entry.id}>
            {(!previous || !sameLogDay(previous.time, entry.time)) && (
              <h3 className="text-ink-weak px-3 pt-3 pb-1 text-xs font-medium">
                {formatLogDate(entry.time)}
              </h3>
            )}
            <LogRow entry={entry} />
          </div>
        );
      })}
    </div>
  );
}

/** One entry: time, source and message — side by side where there's room,
 * the message under the other two where there isn't — with its details
 * below the message. */
function LogRow(props: { entry: LogEntry }): JSX.Element {
  const { entry } = props;
  return (
    <div className="flex flex-col px-3 py-1 font-mono text-xs leading-5 sm:flex-row sm:gap-3">
      <div className="text-ink-weak flex shrink-0 gap-3">
        <span>{formatLogTime(entry.time)}</span>
        <span className="w-[8ch]">{LOG_SOURCE_NAMES[entry.source]}</span>
      </div>
      <div className="min-w-0 break-words">
        <div className="text-ink">{entry.message}</div>
        {entry.details?.map((detail, i) => (
          <div key={i} className="text-ink-weak">
            {detail}
          </div>
        ))}
      </div>
    </div>
  );
}

/** What the "?" says: what the log is for, how to use it, and how to read
 * it — the playback entries above all, which talk about the parts of the
 * player nobody sees. */
function LogHelp(): JSX.Element {
  return (
    <div className="space-y-2">
      <p>
        The log records what the app does — playback, the app going into the
        background, the network, failed requests to the server, errors — so a
        problem nobody could watch, like playback stopping on a locked phone,
        can be looked into afterwards.
      </p>
      <p>
        To report a problem, start logging, make it happen, then copy the log
        into your report and say when you noticed it.
      </p>
      <p>
        The log stays on this device, through reloads, and keeps the latest{" "}
        {MAX_LOG_ENTRIES.toLocaleString("en-US")} entries. Turn logging off when
        you’re done: during playback it writes every few seconds.
      </p>
      <h3 className="pt-1 font-semibold">Reading it</h3>
      <p>
        Each entry gives the time by this device’s clock, the part of the app it
        came from, and what happened, with the state at that moment on the lines
        under it.
      </p>
      <dl className="space-y-1">
        <HelpTerm term="Players A and B">
          Two hidden players take turns: the current one plays, and the standby
          one preloads the next track. They swap at each track change.
        </HelpTerm>
        <HelpTerm term="Keep-alive player">
          Android only: loops silence, so the phone doesn’t cut the sound
          between tracks.
        </HelpTerm>
        <HelpTerm term="Status">
          Logged while a track is loaded: every 3 s in the background, every 15
          s on screen. A longer gap means the app wasn’t running.
        </HelpTerm>
        <HelpTerm term="Track 3f2a1b9c">
          A track, by the start of its id. “Now playing” entries give titles.
        </HelpTerm>
      </dl>
    </div>
  );
}

function HelpTerm(props: { term: string; children: string }): JSX.Element {
  return (
    <div>
      <dt className="inline font-medium">{props.term}: </dt>
      <dd className="text-ink-weak inline">{props.children}</dd>
    </div>
  );
}
