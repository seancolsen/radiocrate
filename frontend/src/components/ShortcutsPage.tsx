import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";
import { useCommands } from "../state/commands";
import {
  chordFromEvent,
  chordsEqual,
  formatChord,
  type Chord,
} from "../commands/chord";
import {
  ALL_COMMANDS,
  commandDef,
  whenLabel,
  type CommandDef,
  type CommandId,
} from "../commands/registry";
import { Icons } from "../icons";
import { Modal } from "./ui/Modal";
import { ContextMenu } from "./ui/ContextMenu";
import { MenuItem } from "./ui/Menu";

// The Keyboard Shortcuts editor: a VS Code-style table of every command, its
// bound shortcut and the context it fires in, with a search bar (by command
// name or, in "record" mode, by pressing the chord) and a capture dialog for
// rebinding.
//
// It fills a tab — `shortcuts.configure` and the explorer's Settings menu open
// that tab (the command ships unbound). The editor's transient state (search
// text, record mode, the open capture dialog) lives in the command store
// rather than here, so it survives switching away to another tab and back.
//
// A row opens the capture dialog on a single click rather than a
// double-click, since here a row does exactly one thing (no other click
// target competes for it).
//
// The app keeps running behind the editor, so global shortcuts keep firing while
// it's open — except while it is itself grabbing keys (record mode or the capture
// dialog), when the global pass stands down (see `commands.tsx:suppressed`).

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
function RecordBox(props: { text: string; class?: string }): JSX.Element {
  return (
    <div
      class={`bg-panel border-accent text-ink flex h-[34px] items-center rounded-md border px-2.5 text-[13px] ${props.class ?? ""}`}
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
  const commands = useCommands();
  /** The command that currently holds the pending chord, when it's some *other*
   * command — assigning would steal it away. */
  const conflict = () => {
    const chord = props.pending;
    if (!chord) return null;
    const other = commands.commandForChord(chord);
    return other && other !== props.cmd ? commandDef(other) : null;
  };

  return (
    <Modal onClose={() => props.onCancel()} width="380px">
      <h2 class="text-ink mb-3 text-base font-semibold">
        Set keyboard shortcut
      </h2>
      <p class="text-ink mb-3 text-sm">{commandDef(props.cmd).title}</p>
      <RecordBox
        text={
          props.pending
            ? formatChord(props.pending)
            : "Press desired key combination…"
        }
      />
      <Show when={conflict()}>
        {(other) => (
          <p class="text-accent mt-2 text-xs">
            Currently bound to “{other().title}”
          </p>
        )}
      </Show>
      <div class="mt-4 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          class="text-ink hover:bg-hover rounded-md px-3 py-1.5 text-sm"
          onClick={() => props.onCancel()}
        >
          Cancel
        </button>
        <button
          type="button"
          class="text-ink hover:bg-hover rounded-md px-3 py-1.5 text-sm"
          onClick={() => props.onReset()}
        >
          Reset to default
        </button>
        <button
          type="button"
          class="text-ink hover:bg-hover rounded-md px-3 py-1.5 text-sm"
          onClick={() => props.onUnbind()}
        >
          Unbind
        </button>
        <button
          type="button"
          disabled={props.pending === null}
          class="bg-accent text-panel rounded-md px-3 py-1.5 text-sm disabled:opacity-40"
          onClick={() => props.onAssign()}
        >
          Assign
        </button>
      </div>
    </Modal>
  );
}

/** The Keyboard Shortcuts tab's page. */
export default function ShortcutsPage(): JSX.Element {
  const commands = useCommands();
  const [rowMenu, setRowMenu] = createSignal<RowMenu | undefined>();

  /** The commands the table lists, filtered by the search bar — by name, or in
   * record mode by the chord pressed into it. */
  const rows = createMemo<CommandDef[]>(() => {
    if (commands.recordMode()) {
      const chord = commands.recorded();
      if (!chord) return [...ALL_COMMANDS];
      return ALL_COMMANDS.filter((def) => {
        const bound = commands.binding(def.id);
        return bound !== null && chordsEqual(bound, chord);
      });
    }
    const needle = commands.shortcutsSearch().trim().toLowerCase();
    if (needle === "") return [...ALL_COMMANDS];
    return ALL_COMMANDS.filter((def) =>
      def.title.toLowerCase().includes(needle),
    );
  });

  const applyAction = (cmd: CommandId, action: RowAction) => {
    switch (action) {
      case "change":
        commands.openCapture(cmd);
        break;
      case "remove":
        commands.setBinding(cmd, null);
        break;
      case "reset":
        commands.resetBinding(cmd);
        break;
    }
  };

  const assignPending = () => {
    const cap = commands.capture();
    if (!cap?.pending) return;
    commands.setBinding(cap.cmd, cap.pending);
    commands.closeCapture();
  };

  // Key capture for the two places that read raw chords: the capture dialog and
  // the record-mode search bar. Runs in the capture phase and swallows what it
  // reads, so pressing ⌘S here rebinds rather than reaching the browser.
  //
  // Enter/Escape/Tab stay reserved for the dialog: Escape dismisses the
  // capture dialog, and in record mode it's left alone (no chord binds it).
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const capturing = commands.capture() !== null;
      if (!capturing && !commands.recordMode()) return;
      if (e.key === "Tab") return;
      if (e.key === "Escape") {
        if (!capturing) return;
        e.stopPropagation();
        commands.closeCapture();
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
      if (capturing) commands.setCapturePending(chord);
      else commands.setRecorded(chord);
    };
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => document.removeEventListener("keydown", onKey, true));
  });

  // Leaving the tab (switching away, or closing it) drops the editor's hold on
  // the keyboard — an open capture dialog or a live record mode would otherwise
  // keep the global shortcut pass suppressed with nothing on screen to see it.
  onCleanup(() => commands.stopCapturingKeys());

  return (
    <>
      <div
        data-testid="shortcuts-page"
        class="bg-panel flex min-h-0 min-w-0 flex-1 flex-col px-3 pt-3"
      >
        <h1 class="text-ink mb-3 text-lg font-semibold">Keyboard Shortcuts</h1>

        {/* Search / record bar. The field stops widening at 420px — a command
            name never needs the whole page. */}
        <div class="mb-3 flex items-center gap-2">
          <Show
            when={commands.recordMode()}
            fallback={
              <input
                type="text"
                placeholder="Search by command name"
                class="bg-panel border-edge text-ink placeholder:text-ink-weak focus:border-accent h-[34px] max-w-[420px] min-w-0 flex-1 rounded-md border px-2.5 text-sm outline-none"
                value={commands.shortcutsSearch()}
                onInput={(e) =>
                  commands.setShortcutsSearch(e.currentTarget.value)
                }
              />
            }
          >
            <RecordBox
              class="max-w-[420px] min-w-0 flex-1"
              text={
                commands.recorded()
                  ? formatChord(commands.recorded()!)
                  : "Press keys to search…"
              }
            />
          </Show>
          <button
            type="button"
            aria-pressed={commands.recordMode()}
            class="border-edge text-ink hover:bg-hover flex h-[34px] shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-sm"
            classList={{ "bg-split-active": commands.recordMode() }}
            onClick={() => commands.setRecordMode(!commands.recordMode())}
          >
            <Icons.Keyboard class="size-4" />
            Record keys
          </button>
        </div>

        {/* Table header: Command | Keybinding | When. */}
        <div class="text-ink-weak border-edge flex shrink-0 items-center border-b px-2 pb-1 text-xs">
          <span class="min-w-0 flex-1">Command</span>
          <span class="w-[170px] shrink-0">Keybinding</span>
          <span class="w-[130px] shrink-0">When</span>
        </div>

        {/* The rows take the rest of the page and scroll within it. */}
        <div class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
          <Show
            when={rows().length > 0}
            fallback={
              <div class="text-ink-weak px-2 py-3 text-[13px]">
                No matching commands
              </div>
            }
          >
            <For each={rows()}>
              {(def) => {
                const chord = () => commands.binding(def.id);
                const overridden = () => commands.overridden(def.id);
                return (
                  <button
                    type="button"
                    class="hover:bg-hover flex h-[30px] w-full items-center px-2 text-left"
                    onClick={() => commands.openCapture(def.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setRowMenu({
                        cmd: def.id,
                        x: e.clientX,
                        y: e.clientY,
                      });
                    }}
                  >
                    <span class="text-ink min-w-0 flex-1 truncate text-[13px]">
                      {def.title}
                    </span>
                    {/* Tinted when it differs from the built-in default. */}
                    <span
                      class="w-[170px] shrink-0 truncate text-xs"
                      classList={{
                        "text-accent": overridden() && chord() !== null,
                        "text-ink": !overridden() && chord() !== null,
                        "text-ink-weak": chord() === null,
                      }}
                    >
                      {chord() ? formatChord(chord()!) : "—"}
                    </span>
                    <span class="text-ink-weak w-[130px] shrink-0 truncate text-xs">
                      {whenLabel(def.when)}
                    </span>
                  </button>
                );
              }}
            </For>
          </Show>
        </div>
      </div>

      <Show when={rowMenu()}>
        {(menu) => (
          <ContextMenu
            x={menu().x}
            y={menu().y}
            onClose={() => setRowMenu(undefined)}
            width="200px"
          >
            <MenuItem
              icon={Icons.Edit}
              label="Change keybinding"
              onClick={() => applyAction(menu().cmd, "change")}
            />
            <Show when={commands.binding(menu().cmd) !== null}>
              <MenuItem
                icon={Icons.Clear}
                label="Remove keybinding"
                onClick={() => applyAction(menu().cmd, "remove")}
              />
            </Show>
            <Show when={commands.overridden(menu().cmd)}>
              <MenuItem
                icon={Icons.Revert}
                label="Reset to default"
                onClick={() => applyAction(menu().cmd, "reset")}
              />
            </Show>
          </ContextMenu>
        )}
      </Show>

      <Show when={commands.capture()}>
        {(cap) => (
          <CaptureDialog
            cmd={cap().cmd}
            pending={cap().pending}
            onAssign={assignPending}
            onUnbind={() => {
              commands.setBinding(cap().cmd, null);
              commands.closeCapture();
            }}
            onReset={() => {
              commands.resetBinding(cap().cmd);
              commands.closeCapture();
            }}
            onCancel={() => commands.closeCapture()}
          />
        )}
      </Show>
    </>
  );
}
