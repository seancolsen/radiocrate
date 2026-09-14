import { useEffect, useMemo, useState, type JSX } from "react";
import {
  chordFromEvent,
  chordsEqual,
  formatChord,
  type Chord,
} from "../commands/chord";
import { bindingFor } from "../commands/keymap";
import {
  ALL_COMMANDS,
  commandDef,
  whenLabel,
  type CommandDef,
  type CommandId,
} from "../commands/registry";
import { Icons } from "../icons";
import {
  selectBinding,
  selectCommandForChord,
  selectOverridden,
} from "../stores/commands";
import { useCommandActions, useCommands } from "../stores/react";
import { Modal } from "./ui/Modal";
import { ContextMenu } from "./ui/ContextMenu";
import { MenuItem } from "./ui/Menu";
import { cx } from "./ui/cx";

// The Keyboard Shortcuts editor: a VS Code-style table of every command, its
// bound shortcut and the context it fires in, with a search bar (by command
// name or, in "record" mode, by pressing the chord) and a capture dialog for
// rebinding.
//
// Ported from `components/ShortcutsPage.tsx`. It fills a tab —
// `shortcuts.configure` and the explorer's Settings menu open that tab (the
// command ships unbound). The editor's transient state (search text, record
// mode, the open capture dialog) lives in the command store rather than here,
// so it survives switching away to another tab and back.
//
// A row opens the capture dialog on a single click rather than a
// double-click, since here a row does exactly one thing (no other click
// target competes for it).
//
// The app keeps running behind the editor, so global shortcuts keep firing while
// it's open — except while it is itself grabbing keys (record mode or the capture
// dialog), when the global pass stands down (see `stores/commands.ts`'s
// `suppressed`).

/** An action chosen from a row's context menu. */
type RowAction = "change" | "remove" | "reset";

/** An open row context menu: which command it targets, and where it was
 * raised. */
interface RowMenu {
  cmd: CommandId;
  x: number;
  y: number;
}

/** A bordered, read-only box showing a chord (or a prompt), matching the app's
 * text-input chrome so the record/capture affordance reads as a field. */
function RecordBox(props: { text: string; className?: string }): JSX.Element {
  return (
    <div
      className={`bg-panel border-accent text-ink flex h-[34px] items-center rounded-md border px-2.5 text-[13px] ${props.className ?? ""}`}
    >
      {props.text}
    </div>
  );
}

/** The rebind-capture dialog. Pressing a chord updates the pending binding; the
 * buttons (or Enter / Esc, handled by the editor's key listener) resolve it.
 *
 * Exported so it can be rendered on its own, from the props above rather than
 * from the editor around it (the visual-test harness does exactly that). */
export function CaptureDialog(props: {
  cmd: CommandId;
  pending: Chord | null;
  onAssign: () => void;
  onUnbind: () => void;
  onReset: () => void;
  onCancel: () => void;
}): JSX.Element {
  /** The command that currently holds the pending chord, when it's some *other*
   * command — assigning would steal it away. */
  const conflictId = useCommands((s) =>
    props.pending ? selectCommandForChord(s, props.pending) : null,
  );
  const conflict =
    conflictId && conflictId !== props.cmd ? commandDef(conflictId) : null;

  return (
    <Modal onClose={() => props.onCancel()} width="380px">
      <h2 className="text-ink mb-3 text-base font-semibold">
        Set keyboard shortcut
      </h2>
      <p className="text-ink mb-3 text-sm">{commandDef(props.cmd).title}</p>
      <RecordBox
        text={
          props.pending
            ? formatChord(props.pending)
            : "Press desired key combination…"
        }
      />
      {conflict && (
        <p className="text-accent mt-2 text-xs">
          Currently bound to “{conflict.title}”
        </p>
      )}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          className="text-ink hover:bg-hover rounded-md px-3 py-1.5 text-sm"
          onClick={() => props.onCancel()}
        >
          Cancel
        </button>
        <button
          type="button"
          className="text-ink hover:bg-hover rounded-md px-3 py-1.5 text-sm"
          onClick={() => props.onReset()}
        >
          Reset to default
        </button>
        <button
          type="button"
          className="text-ink hover:bg-hover rounded-md px-3 py-1.5 text-sm"
          onClick={() => props.onUnbind()}
        >
          Unbind
        </button>
        <button
          type="button"
          disabled={props.pending === null}
          className="bg-accent text-panel rounded-md px-3 py-1.5 text-sm disabled:opacity-40"
          onClick={() => props.onAssign()}
        >
          Assign
        </button>
      </div>
    </Modal>
  );
}

/** One command-table row, wired to the store. Split out from {@link
 * ShortcutsPage} so its chord/override subscriptions are narrow to this one
 * row. */
function ShortcutsRow(props: {
  def: CommandDef;
  onOpenCapture: (cmd: CommandId) => void;
  onOpenMenu: (menu: RowMenu) => void;
}): JSX.Element {
  const chord = useCommands((s) => selectBinding(s, props.def.id));
  const overridden = useCommands((s) => selectOverridden(s, props.def.id));
  return (
    <button
      type="button"
      className="hover:bg-hover flex h-[30px] w-full items-center px-2 text-left"
      onClick={() => props.onOpenCapture(props.def.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onOpenMenu({ cmd: props.def.id, x: e.clientX, y: e.clientY });
      }}
    >
      <span className="text-ink min-w-0 flex-1 truncate text-[13px]">
        {props.def.title}
      </span>
      {/* Tinted when it differs from the built-in default. */}
      <span
        className={cx("w-[170px] shrink-0 truncate text-xs", {
          "text-accent": overridden && chord !== null,
          "text-ink": !overridden && chord !== null,
          "text-ink-weak": chord === null,
        })}
      >
        {chord ? formatChord(chord) : "—"}
      </span>
      <span className="text-ink-weak w-[130px] shrink-0 truncate text-xs">
        {whenLabel(props.def.when)}
      </span>
    </button>
  );
}

/** The Keyboard Shortcuts tab's page. */
export default function ShortcutsPage(): JSX.Element {
  const recordMode = useCommands((s) => s.recordMode);
  const recorded = useCommands((s) => s.recorded);
  const shortcutsSearch = useCommands((s) => s.shortcutsSearch);
  const overrides = useCommands((s) => s.overrides);
  const capture = useCommands((s) => s.capture);
  const actions = useCommandActions();
  const [rowMenu, setRowMenu] = useState<RowMenu>();

  /** The commands the table lists, filtered by the search bar — by name, or in
   * record mode by the chord pressed into it. */
  const rows = useMemo<CommandDef[]>(() => {
    if (recordMode) {
      if (!recorded) return [...ALL_COMMANDS];
      return ALL_COMMANDS.filter((def) => {
        const bound = bindingFor(overrides, def.id);
        return bound !== null && chordsEqual(bound, recorded);
      });
    }
    const needle = shortcutsSearch.trim().toLowerCase();
    if (needle === "") return [...ALL_COMMANDS];
    return ALL_COMMANDS.filter((def) =>
      def.title.toLowerCase().includes(needle),
    );
  }, [recordMode, recorded, shortcutsSearch, overrides]);

  const applyAction = (cmd: CommandId, action: RowAction) => {
    switch (action) {
      case "change":
        actions.openCapture(cmd);
        break;
      case "remove":
        actions.setBinding(cmd, null);
        break;
      case "reset":
        actions.resetBinding(cmd);
        break;
    }
  };

  const assignPending = () => {
    if (!capture?.pending) return;
    actions.setBinding(capture.cmd, capture.pending);
    actions.closeCapture();
  };

  // Key capture for the two places that read raw chords: the capture dialog and
  // the record-mode search bar. Runs in the capture phase and swallows what it
  // reads, so pressing ⌘S here rebinds rather than reaching the browser.
  //
  // Enter/Escape/Tab stay reserved for the dialog: Escape dismisses the
  // capture dialog, and in record mode it's left alone (no chord binds it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const capturing = capture !== null;
      if (!capturing && !recordMode) return;
      if (e.key === "Tab") return;
      if (e.key === "Escape") {
        if (!capturing) return;
        e.stopPropagation();
        actions.closeCapture();
        return;
      }
      if (e.key === "Enter") {
        if (!capturing) return;
        e.preventDefault();
        e.stopPropagation();
        assignPending();
        return;
      }
      const chord = chordFromEvent(e);
      if (!chord) return; // a bare modifier, or a key with no binding name
      e.preventDefault();
      e.stopPropagation();
      if (capturing) actions.setCapturePending(chord);
      else actions.setRecorded(chord);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capture, recordMode]);

  // Leaving the tab (switching away, or closing it) drops the editor's hold on
  // the keyboard — an open capture dialog or a live record mode would otherwise
  // keep the global shortcut pass suppressed with nothing on screen to see it.
  useEffect(() => {
    return () => actions.stopCapturingKeys();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div
        data-testid="shortcuts-page"
        className="bg-panel flex min-h-0 min-w-0 flex-1 flex-col px-3 pt-3"
      >
        <h1 className="text-ink mb-3 text-lg font-semibold">
          Keyboard Shortcuts
        </h1>

        {/* Search / record bar. The field stops widening at 420px — a command
            name never needs the whole page. */}
        <div className="mb-3 flex items-center gap-2">
          {recordMode ? (
            <RecordBox
              className="max-w-[420px] min-w-0 flex-1"
              text={recorded ? formatChord(recorded) : "Press keys to search…"}
            />
          ) : (
            <input
              type="text"
              placeholder="Search by command name"
              className="bg-panel border-edge text-ink placeholder:text-ink-weak focus:border-accent h-[34px] max-w-[420px] min-w-0 flex-1 rounded-md border px-2.5 text-sm outline-none"
              value={shortcutsSearch}
              onChange={(e) =>
                actions.setShortcutsSearch(e.currentTarget.value)
              }
            />
          )}
          <button
            type="button"
            aria-pressed={recordMode}
            className={cx(
              "border-edge text-ink hover:bg-hover flex h-[34px] shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-sm",
              { "bg-split-active": recordMode },
            )}
            onClick={() => actions.setRecordMode(!recordMode)}
          >
            <Icons.Keyboard className="size-4" />
            Record keys
          </button>
        </div>

        {/* Table header: Command | Keybinding | When. */}
        <div className="text-ink-weak border-edge flex shrink-0 items-center border-b px-2 pb-1 text-xs">
          <span className="min-w-0 flex-1">Command</span>
          <span className="w-[170px] shrink-0">Keybinding</span>
          <span className="w-[130px] shrink-0">When</span>
        </div>

        {/* The rows take the rest of the page and scroll within it. */}
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
          {rows.length > 0 ? (
            rows.map((def) => (
              <ShortcutsRow
                key={def.id}
                def={def}
                onOpenCapture={(cmd) => actions.openCapture(cmd)}
                onOpenMenu={setRowMenu}
              />
            ))
          ) : (
            <div className="text-ink-weak px-2 py-3 text-[13px]">
              No matching commands
            </div>
          )}
        </div>
      </div>

      {rowMenu && (
        <RowContextMenu
          menu={rowMenu}
          onClose={() => setRowMenu(undefined)}
          onAction={applyAction}
        />
      )}

      {capture && (
        <CaptureDialog
          cmd={capture.cmd}
          pending={capture.pending}
          onAssign={assignPending}
          onUnbind={() => {
            actions.setBinding(capture.cmd, null);
            actions.closeCapture();
          }}
          onReset={() => {
            actions.resetBinding(capture.cmd);
            actions.closeCapture();
          }}
          onCancel={() => actions.closeCapture()}
        />
      )}
    </>
  );
}

/** A row's right-click menu: change, remove (when bound) and reset (when
 * overridden). Split out so its `binding`/`overridden` subscriptions are
 * narrow to the one targeted command. */
function RowContextMenu(props: {
  menu: RowMenu;
  onClose: () => void;
  onAction: (cmd: CommandId, action: RowAction) => void;
}): JSX.Element {
  const chord = useCommands((s) => selectBinding(s, props.menu.cmd));
  const overridden = useCommands((s) => selectOverridden(s, props.menu.cmd));
  return (
    <ContextMenu
      x={props.menu.x}
      y={props.menu.y}
      onClose={props.onClose}
      width="200px"
    >
      <MenuItem
        icon={Icons.Edit}
        label="Change keybinding"
        onClick={() => props.onAction(props.menu.cmd, "change")}
      />
      {chord !== null && (
        <MenuItem
          icon={Icons.Clear}
          label="Remove keybinding"
          onClick={() => props.onAction(props.menu.cmd, "remove")}
        />
      )}
      {overridden && (
        <MenuItem
          icon={Icons.Revert}
          label="Reset to default"
          onClick={() => props.onAction(props.menu.cmd, "reset")}
        />
      )}
    </ContextMenu>
  );
}
