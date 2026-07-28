import {
  createContext,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js";
import { keybindingDelete, keybindingList, keybindingSet } from "api-client";
import {
  chordFromEvent,
  chordToStorage,
  chordsEqual,
  type Chord,
} from "../commands/chord";
import {
  bindingFor,
  commandForChord,
  isOverridden,
  overridesFromEntries,
  resolveBindings,
  withOverride,
  type Overrides,
} from "../commands/keymap";
import { rankCommands } from "../commands/rank";
import {
  ALL_COMMANDS,
  commandDef,
  whenSatisfied,
  type CommandContext,
  type CommandDef,
  type CommandId,
} from "../commands/registry";
import {
  focusedForm,
  recordPickerOpen,
} from "../components/record/formRegistry";
import { useAppState, type AppStore } from "./store";

// The command system: the keymap (persisted user overrides over the built-in
// defaults), the global keyboard-shortcut pass, and the single dispatch point
// every command runs through.
//
// It sits in its own context, layered over the app store: commands are defined
// in terms of store actions, and keeping them out of the store keeps that file
// about application state rather than input handling.

/** How many recently-used commands the palette floats to the top. */
const MRU_LIMIT = 10;

/** The rebind-capture dialog's state: which command is being edited and the
 * chord pressed so far. */
export interface CaptureState {
  cmd: CommandId;
  pending: Chord | null;
}

export interface CommandStore {
  // ── The keymap ──
  /** The effective chord for a command (`null` when unbound). */
  binding: (cmd: CommandId) => Chord | null;
  /** Whether the command's binding differs from its built-in default. */
  overridden: (cmd: CommandId) => boolean;
  /** The command currently bound to `chord`, if any. */
  commandForChord: (chord: Chord) => CommandId | null;
  /** Rebind (or, with `null`, explicitly unbind) a command, stealing the chord
   * from whichever command holds it. Persists both changes. */
  setBinding: (cmd: CommandId, chord: Chord | null) => void;
  /** Revert a command to its built-in default, dropping the override. */
  resetBinding: (cmd: CommandId) => void;

  // ── Dispatch ──
  /** The `When` predicates' inputs, read from the app store. */
  context: Accessor<CommandContext>;
  /** The commands whose context is currently satisfied, in registry order. */
  available: Accessor<CommandDef[]>;
  /** Record the command as used and run it — the single dispatch point shared
   * by the palette, the keyboard pass, and the shortcuts editor. */
  run: (cmd: CommandId) => void;

  // ── The command palette ──
  paletteOpen: Accessor<boolean>;
  togglePalette: () => void;
  closePalette: () => void;
  paletteQuery: Accessor<string>;
  setPaletteQuery: (text: string) => void;
  /** The ranked, context-filtered commands the palette lists. */
  paletteItems: Accessor<CommandDef[]>;
  /** The highlighted row, clamped to the current list. */
  paletteIndex: Accessor<number>;
  setPaletteIndex: (index: number) => void;
  /** Move the highlight by `delta`, wrapping at both ends. */
  movePaletteIndex: (delta: number) => void;

  // ── The keyboard-shortcuts editor ──
  // Its transient UI state lives here rather than in the page component: the
  // editor is a tab, so the component unmounts whenever another tab is showing.
  /** The editor's command-name search text (unused in record mode). */
  shortcutsSearch: Accessor<string>;
  setShortcutsSearch: (text: string) => void;
  /** Release the editor's hold on the keyboard — cancel the capture dialog and
   * leave record mode. Called when the editor's page unmounts; while either is
   * live the global shortcut pass stands down. */
  stopCapturingKeys: () => void;
  /** The open rebind-capture dialog, if any. */
  capture: Accessor<CaptureState | null>;
  openCapture: (cmd: CommandId) => void;
  closeCapture: () => void;
  setCapturePending: (chord: Chord) => void;
  /** Whether the editor's search bar is capturing a chord instead of text. */
  recordMode: Accessor<boolean>;
  setRecordMode: (on: boolean) => void;
  /** The chord captured in record mode, filtering the table to its command. */
  recorded: Accessor<Chord | null>;
  setRecorded: (chord: Chord | null) => void;
}

const CommandContextObj = createContext<CommandStore>();

/** Whether the event landed in a text field, which owns its own keys. Plain and
 * shift-only chords stand down for it; ⌘/Ctrl and Alt chords still fire. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

function createCommandStore(store: AppStore): CommandStore {
  const [overrides, setOverrides] = createSignal<Overrides>({});
  const [mru, setMru] = createSignal<CommandId[]>([]);

  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [paletteQuery, setPaletteQuery] = createSignal("");
  const [paletteIndex, setPaletteIndex] = createSignal(0);

  const [shortcutsSearch, setShortcutsSearch] = createSignal("");
  const [capture, setCapture] = createSignal<CaptureState | null>(null);
  const [recordMode, setRecordModeSignal] = createSignal(false);
  const [recorded, setRecorded] = createSignal<Chord | null>(null);

  // Persisted overrides, loaded once. A backend without any (or a mocked RPC
  // returning null) simply leaves every command on its default.
  onMount(() => {
    void keybindingList()
      .then((list) => setOverrides(overridesFromEntries(list ?? [])))
      .catch((err) => console.error("keybinding list failed", err));
  });

  const binding = (cmd: CommandId) => bindingFor(overrides(), cmd);

  /** Applies one binding and persists it: an override that matches the default
   * is stored as a deletion (the row disappears), otherwise as a set — a `null`
   * chord recording an explicit unbind. */
  const applyBinding = (cmd: CommandId, chord: Chord | null) => {
    const next = withOverride(overrides(), cmd, chord);
    setOverrides(next);
    if (cmd in next) {
      void keybindingSet({
        commandId: cmd,
        chord: chord ? chordToStorage(chord) : null,
      }).catch((err) => console.error("keybinding set failed", err));
    } else {
      void keybindingDelete({ commandId: cmd }).catch((err) =>
        console.error("keybinding delete failed", err),
      );
    }
  };

  const setBinding = (cmd: CommandId, chord: Chord | null) => {
    if (chord) {
      const other = commandForChord(overrides(), chord);
      // A chord belongs to one command: whoever held it becomes unbound.
      if (other && other !== cmd) applyBinding(other, null);
    }
    applyBinding(cmd, chord);
  };

  const context = createMemo<CommandContext>(() => {
    const active = store.state.activeTabId;
    return {
      activeTab: active !== null,
      queryTabActive: active !== null && store.queryTab(active) !== undefined,
      resultsAvailable: active !== null && (store.resultCount(active) ?? 0) > 0,
      trackLoaded: store.state.currentTrack !== null,
      recordFormFocused: focusedForm() !== undefined,
    };
  });

  const available = createMemo(() =>
    ALL_COMMANDS.filter((c) => whenSatisfied(c.when, context())),
  );

  const paletteItems = createMemo(() =>
    rankCommands(paletteQuery(), available(), mru()),
  );

  /** The highlight, clamped to the list that's actually on screen (the list
   * shrinks as the query narrows it). */
  const clampedIndex = createMemo(() => {
    const n = paletteItems().length;
    if (n === 0) return 0;
    return Math.min(paletteIndex(), n - 1);
  });

  const closePalette = () => setPaletteOpen(false);

  const togglePalette = () => {
    if (paletteOpen()) {
      closePalette();
      return;
    }
    setPaletteQuery("");
    setPaletteIndex(0);
    setPaletteOpen(true);
  };

  const capturingKeys = () => capture() !== null || recordMode();

  const stopCapturingKeys = () => {
    setCapture(null);
    setRecordModeSignal(false);
    setRecorded(null);
  };

  // ── Command implementations ────────────────────────────────────────────────

  /** The active tab's id, or `null` — the guard nearly every tab command opens
   * with (its `When` already gates the shortcut, but the palette can be racing a
   * tab close). */
  const activeTab = () => store.state.activeTabId;

  /** The active tab's id when it holds a *query*, else `null` — the same guard
   * for the commands that act on a query page, so one aimed at the settings tab
   * does nothing rather than writing query state under its id. */
  const activeQueryTab = () => {
    const id = activeTab();
    return id !== null && store.queryTab(id) !== undefined ? id : null;
  };

  /** Selects the next (`forward`) or previous tab, wrapping around. */
  const cycleTab = (forward: boolean) => {
    const tabs = store.state.tabs;
    const cur = activeTab();
    if (tabs.length === 0 || cur === null) return;
    const idx = tabs.findIndex((t) => t.id === cur);
    if (idx === -1) return;
    const next = forward
      ? (idx + 1) % tabs.length
      : (idx + tabs.length - 1) % tabs.length;
    store.selectTab(tabs[next].id);
  };

  /** Moves the active tab one slot right (`forward`) or left, clamped in
   * range. */
  const moveActiveTab = (forward: boolean) => {
    const tabs = store.state.tabs;
    const cur = activeTab();
    if (cur === null) return;
    const idx = tabs.findIndex((t) => t.id === cur);
    if (idx === -1) return;
    store.reorderTab(cur, forward ? idx + 1 : idx - 1);
  };

  const execute = (cmd: CommandId) => {
    const tabId = activeTab();
    // Query-page commands read this instead, so they stand down on a settings tab.
    const queryId = activeQueryTab();
    // The record editor form the user is working in, if any — the target of the
    // selection commands, and the first claim on the arrow keys.
    const form = focusedForm();
    switch (cmd) {
      case "palette.open":
        togglePalette();
        break;
      case "shortcuts.configure":
        store.openShortcutsTab();
        break;
      case "explorer.toggle":
        store.toggleSidebar();
        break;
      case "playback.toggle_play":
        store.togglePlayPause();
        break;
      case "playback.next_track":
        store.skipNext();
        break;
      case "query.focus_filter":
        if (queryId) store.focusBuilderSection(queryId, "filter");
        break;
      case "query.focus_sort":
        if (queryId) store.focusBuilderSection(queryId, "sort");
        break;
      case "query.focus_display":
        if (queryId) store.focusBuilderSection(queryId, "display");
        break;
      // Up/Down move the row selection — unless the user is inside a record
      // editor form, where they move between its items instead (the form is
      // reached *from* the rows, and its items are what's in front of the user
      // once it is).
      case "results.select_next":
        if (form) form.model.focusAdjacent(true);
        else if (tabId) store.moveRowSelection(tabId, true, false);
        break;
      case "results.select_previous":
        if (form) form.model.focusAdjacent(false);
        else if (tabId) store.moveRowSelection(tabId, false, false);
        break;
      case "results.extend_selection_down":
        if (tabId) store.moveRowSelection(tabId, true, true);
        break;
      case "results.extend_selection_up":
        if (tabId) store.moveRowSelection(tabId, false, true);
        break;
      case "results.edit_selected": {
        if (!tabId) break;
        // Same table for every row in the selection: the first selected row's
        // first record picks it (context-menu order — the row's "primary"
        // table), then the rest of the selection is filtered down to records
        // of that same table, mirroring the "Dynamic updates" resync in
        // QueryPage.
        const indices = [...store.rowSelection(tabId)].sort((a, b) => a - b);
        const table = store.rowRecords(tabId, indices[0] ?? -1)[0]?.table;
        if (table === undefined) break;
        const records = indices.flatMap((index) =>
          store.rowRecords(tabId, index).filter((r) => r.table === table),
        );
        store.setRecordEditorRecords(tabId, table, records);
        break;
      }
      case "selection.expand_nested":
        form?.model.expandSelection(true);
        break;
      case "selection.collapse_nested":
        form?.model.expandSelection(false);
        break;
      case "selection.delete":
        form?.model.deleteSelection();
        break;
      case "tabs.save_active":
        // Guarded on `isUnsaved`: a save is a backend write that bumps
        // `modified_at`, and the toolbar's Save button is likewise only there
        // while unsaved.
        if (queryId && store.isUnsaved(queryId)) store.saveQuery(queryId);
        break;
      case "tabs.save_all":
        // Snapshot the ids first: saving mutates the tabs array.
        for (const id of store.state.tabs.map((t) => t.id)) {
          if (store.isUnsaved(id)) store.saveQuery(id);
        }
        break;
      case "tabs.close_active":
        if (tabId) store.closeTab(tabId);
        break;
      case "tabs.next":
        cycleTab(true);
        break;
      case "tabs.previous":
        cycleTab(false);
        break;
      case "tabs.move_left":
        moveActiveTab(false);
        break;
      case "tabs.move_right":
        moveActiveTab(true);
        break;
    }
  };

  /** Records a command as used and runs it.
   *
   * `palette.open` is left out of the MRU: it's the command that *opened* the
   * list, so listing it back as the most recent thing you did would
   * permanently occupy the top slot with the one command nobody needs to find
   * there. */
  const run = (cmd: CommandId) => {
    if (cmd !== "palette.open") {
      setMru((prev) =>
        [cmd, ...prev.filter((c) => c !== cmd)].slice(0, MRU_LIMIT),
      );
    }
    execute(cmd);
  };

  // ── The global shortcut pass ───────────────────────────────────────────────

  /** Whether something that owns the keyboard is up, so the global pass stands
   * down. The shortcuts editor's *tab* does not count — the app keeps running
   * behind it — but its chord capture does, so a chord typed at it rebinds
   * instead of firing. */
  const suppressed = () =>
    paletteOpen() ||
    capturingKeys() ||
    store.state.pendingDelete !== null ||
    store.state.viewSql !== null ||
    store.state.presetSave !== null ||
    store.state.renaming !== null ||
    recordPickerOpen();

  onMount(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (suppressed()) return;
      const pressed = chordFromEvent(e);
      if (!pressed) return;
      const typing = isTypingTarget(e.target);
      const ctx = context();
      for (const { chord, command } of resolveBindings(overrides())) {
        // A text field keeps its own plain / shift-only keys.
        if (typing && !(chord.mod || chord.alt)) continue;
        if (!whenSatisfied(commandDef(command).when, ctx)) continue;
        if (!chordsEqual(chord, pressed)) continue;
        // Matched: the key belongs to the command, not to the page.
        e.preventDefault();
        e.stopPropagation();
        run(command);
        return;
      }
    };
    // Capture phase, so a chord is claimed before a focused widget acts on it.
    document.addEventListener("keydown", onKeyDown, true);
    onCleanup(() => document.removeEventListener("keydown", onKeyDown, true));
  });

  return {
    binding,
    overridden: (cmd) => isOverridden(overrides(), cmd),
    commandForChord: (chord) => commandForChord(overrides(), chord),
    setBinding,
    resetBinding: (cmd) => applyBinding(cmd, commandDef(cmd).defaultChord),

    context,
    available,
    run,

    paletteOpen,
    togglePalette,
    closePalette,
    paletteQuery,
    setPaletteQuery: (text) => {
      setPaletteQuery(text);
      // A new query means a new list; start from the top of it.
      setPaletteIndex(0);
    },
    paletteItems,
    paletteIndex: clampedIndex,
    setPaletteIndex,
    movePaletteIndex: (delta) => {
      const n = paletteItems().length;
      if (n === 0) return;
      setPaletteIndex((clampedIndex() + delta + n) % n);
    },

    shortcutsSearch,
    setShortcutsSearch,
    stopCapturingKeys,
    capture,
    openCapture: (cmd) => setCapture({ cmd, pending: binding(cmd) }),
    closeCapture: () => setCapture(null),
    setCapturePending: (chord) =>
      setCapture((c) => (c ? { ...c, pending: chord } : c)),
    recordMode,
    setRecordMode: (on) => {
      setRecordModeSignal(on);
      setRecorded(null);
    },
    recorded,
    setRecorded,
  };
}

export function CommandProvider(props: ParentProps) {
  const commands = createCommandStore(useAppState());
  return (
    <CommandContextObj.Provider value={commands}>
      {props.children}
    </CommandContextObj.Provider>
  );
}

export function useCommands(): CommandStore {
  const commands = useContext(CommandContextObj);
  if (!commands)
    throw new Error("useCommands must be used within CommandProvider");
  return commands;
}
