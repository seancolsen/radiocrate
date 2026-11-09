import { keybindingDelete, keybindingList, keybindingSet } from "api-client";
import { createStore } from "zustand/vanilla";
import { subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { chordFromEvent, chordToStorage, type Chord } from "../commands/chord";
import {
  bindingFor,
  commandForChord,
  conflictsFor,
  isOverridden,
  overridesFromEntries,
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
import type { AppState, AppStoreBundle } from "./app";
import {
  selectCanConvertToPlaylist,
  selectIsUnsaved,
  selectPageTab,
  selectResultCount,
  selectRowSelection,
} from "./app";
import type { FormsState, FormsStoreBundle } from "./forms";
import {
  selectAutocompleteForm,
  selectFocusedForm,
  selectModifiedForm,
  selectRecordPickerOpen,
} from "./forms";
import type { MenusStoreBundle } from "./menus";
import { selectAnyMenuOpen } from "./menus";

// The command system: the keymap (persisted user overrides over the built-in
// defaults), the global keyboard-shortcut pass, and the single dispatch point
// every command runs through.
//
// It sits in its own store, layered over the
// app, forms and menus stores: commands are defined in terms of their actions,
// and keeping them out of those stores keeps each about its own state rather
// than input handling.

/** How many recently-used commands the palette floats to the top. */
const MRU_LIMIT = 10;

/** The rebind-capture dialog's state: which command is being edited and the
 * chord pressed so far. */
export interface CaptureState {
  cmd: CommandId;
  pending: Chord | null;
}

export interface CommandsState {
  // ── The keymap ──
  overrides: Overrides;
  /** Recently-run commands, most recent first — the palette's MRU. */
  mru: readonly CommandId[];

  // ── The command palette ──
  paletteOpen: boolean;
  paletteQuery: string;
  /** The highlighted row. Not necessarily in range of the current palette
   * list — {@link selectClampedPaletteIndex} is the read every consumer
   * actually wants. */
  paletteIndex: number;

  // ── The keyboard-shortcuts editor ──
  // Its transient UI state lives here rather than in the page component: the
  // editor is a tab, so the component unmounts whenever another tab is
  // showing.
  /** The editor's command-name search text (unused in record mode). */
  shortcutsSearch: string;
  /** The open rebind-capture dialog, if any. */
  capture: CaptureState | null;
  /** Whether the editor's search bar is capturing a chord instead of text. */
  recordMode: boolean;
  /** The chord captured in record mode, filtering the table to its command. */
  recorded: Chord | null;
}

function initialCommandsState(): CommandsState {
  return {
    overrides: {},
    mru: [],
    paletteOpen: false,
    paletteQuery: "",
    paletteIndex: 0,
    shortcutsSearch: "",
    capture: null,
    recordMode: false,
    recorded: null,
  };
}

/** Whether the event landed in a text field, which owns its own keys. Plain
 * and shift-only chords stand down for it; ⌘/Ctrl and Alt chords still
 * fire. */
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

/** How far the seek shortcuts move the playhead. */
const SEEK_STEP_SECONDS = 10;

/** Whether the focused control uses this plain key itself — Space presses a
 * button, Left/Right step a slider, tab or tree row — so the global pass leaves
 * it alone rather than turning it into a transport command. */
function claimsKey(target: EventTarget | null, chord: Chord): boolean {
  if (chord.mod || chord.alt || chord.shift || !(target instanceof HTMLElement))
    return false;
  if (chord.key === "Space")
    return (
      target.closest(
        "button, a[href], summary, [role=button], [role=menuitem], [role=checkbox], [role=switch], [role=tab], [role=treeitem]",
      ) !== null
    );
  // The explorer's rows rename their own item on F2.
  if (chord.key === "F2") return target.closest("[role=treeitem]") !== null;
  if (chord.key === "Left" || chord.key === "Right")
    return (
      target.closest("[role=slider], [role=tab], [role=treeitem]") !== null
    );
  return false;
}

// ── Selectors — pure functions of state ─────────────────────────────────────

export const selectBinding = (s: CommandsState, cmd: CommandId): Chord | null =>
  bindingFor(s.overrides, cmd);
export const selectOverridden = (s: CommandsState, cmd: CommandId): boolean =>
  isOverridden(s.overrides, cmd);
/** The commands binding `chord` to `cmd` would take it from (see
 * `conflictsFor`). A fresh array: a component wraps it in `useShallow`. */
export const selectConflicts = (
  s: CommandsState,
  cmd: CommandId,
  chord: Chord,
): CommandId[] => conflictsFor(s.overrides, cmd, chord);

/** The `When` predicates' inputs, read from the app and forms stores. A plain
 * function: the keydown pass calls it with a fresh `getState()` at keypress
 * time (state management rule 4). The command palette assembles the same shape
 * from narrower subscriptions instead (see `CommandPalette.tsx`), since a
 * component can't select whole store states. */
export function selectCommandContext(
  app: AppState,
  forms: FormsState,
): CommandContext {
  const active = app.activeTabId;
  const resultsAvailable =
    active !== null && (selectResultCount(app, active) ?? 0) > 0;
  const recordFormFocused = selectFocusedForm(forms) !== undefined;
  return {
    activeTab: active !== null,
    queryTabActive: active !== null && selectPageTab(app, active) !== undefined,
    queryTracksActive:
      active !== null && selectCanConvertToPlaylist(app, active),
    playlistResultsActive:
      active !== null &&
      resultsAvailable &&
      !recordFormFocused &&
      selectPageTab(app, active)?.kind === "playlist",
    resultsAvailable,
    trackLoaded: app.currentTrack !== null,
    tracksQueued: app.queuedTracks.length > 0,
    recordFormFocused,
    recordFormModified:
      active !== null && selectModifiedForm(forms, active) !== undefined,
    recordAutocompleteAvailable: selectAutocompleteForm(forms) !== undefined,
  };
}

/** The commands whose context is currently satisfied, in registry order.
 * Builds a fresh array on every call (rule 2) — the palette wraps it in a
 * `useMemo` rather than subscribing to it directly. */
export const selectAvailableCommands = (
  context: CommandContext,
): CommandDef[] => ALL_COMMANDS.filter((c) => whenSatisfied(c.when, context));

/** The ranked, context-filtered commands the palette lists. */
export function selectPaletteItems(
  s: CommandsState,
  context: CommandContext,
): CommandDef[] {
  return rankCommands(s.paletteQuery, selectAvailableCommands(context), s.mru);
}

/** The highlight, clamped to the list that's actually on screen (the list
 * shrinks as the query narrows it). */
export function selectClampedPaletteIndex(
  s: CommandsState,
  itemCount: number,
): number {
  if (itemCount === 0) return 0;
  return Math.min(s.paletteIndex, itemCount - 1);
}

function createCommandsVanillaStore() {
  return createStore<CommandsState>()(
    subscribeWithSelector(immer(() => initialCommandsState())),
  );
}

export type CommandsVanillaStore = ReturnType<
  typeof createCommandsVanillaStore
>;

export interface CommandsActions {
  /** Loads persisted keymap overrides once. A backend without any (or a
   * mocked RPC returning null) simply leaves every command on its default. */
  loadKeymap: () => Promise<void>;
  /** Rebind (or, with `null`, explicitly unbind) a command, stealing the
   * chord from every command that holds it in a context that can overlap the
   * command's (`conflictsFor`). Persists every change. */
  setBinding: (cmd: CommandId, chord: Chord | null) => void;
  /** Revert a command to its built-in default, dropping the override. */
  resetBinding: (cmd: CommandId) => void;
  /** Record the command as used and run it — the single dispatch point
   * shared by the palette, the keyboard pass, and the shortcuts editor. */
  run: (cmd: CommandId) => void;

  togglePalette: () => void;
  closePalette: () => void;
  setPaletteQuery: (text: string) => void;
  setPaletteIndex: (index: number) => void;
  /** Move the highlight by `delta`, wrapping at both ends. */
  movePaletteIndex: (delta: number) => void;

  setShortcutsSearch: (text: string) => void;
  /** Release the editor's hold on the keyboard — cancel the capture dialog
   * and leave record mode. Called when the editor's page unmounts; while
   * either is live the global shortcut pass stands down. */
  stopCapturingKeys: () => void;
  openCapture: (cmd: CommandId) => void;
  closeCapture: () => void;
  setCapturePending: (chord: Chord) => void;
  setRecordMode: (on: boolean) => void;
  setRecorded: (chord: Chord | null) => void;

  /** The global capture-phase keydown pass, installed once by
   * `createStores()` (state management: "the keydown pass"). Consumes the
   * event (`preventDefault`/`stopPropagation`) when a chord matches a
   * satisfied command; otherwise leaves it alone. */
  handleKeyDown: (e: KeyboardEvent) => void;
  /** The global capture-phase keyup pass, installed beside it: closes the tab
   * switcher on the release of the modifier that opened it. */
  handleKeyUp: (e: KeyboardEvent) => void;
}

/** Builds the command store, wired to the app, forms and menus bundles it
 * reads (state management: "the command and update stores read all the
 * others"). */
export function createCommandsStore(
  app: AppStoreBundle,
  forms: FormsStoreBundle,
  menus: MenusStoreBundle,
): { store: CommandsVanillaStore; actions: CommandsActions } {
  const store = createCommandsVanillaStore();

  const context = (): CommandContext =>
    selectCommandContext(app.store.getState(), forms.store.getState());

  /** Applies one binding and persists it: an override that matches the
   * default is stored as a deletion (the row disappears), otherwise as a set
   * — a `null` chord recording an explicit unbind. */
  const applyBinding = (cmd: CommandId, chord: Chord | null) => {
    let next!: Overrides;
    store.setState((s) => {
      next = withOverride(s.overrides, cmd, chord);
      s.overrides = next;
    });
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
      // A chord runs one command in any given context: whoever held it where
      // `cmd` could also run becomes unbound.
      for (const other of conflictsFor(store.getState().overrides, cmd, chord))
        applyBinding(other, null);
    }
    applyBinding(cmd, chord);
  };

  const closePalette = () => store.setState({ paletteOpen: false });

  const togglePalette = () => {
    if (store.getState().paletteOpen) {
      closePalette();
      return;
    }
    store.setState({ paletteQuery: "", paletteIndex: 0, paletteOpen: true });
  };

  const capturingKeys = (): boolean => {
    const s = store.getState();
    return s.capture !== null || s.recordMode;
  };

  const stopCapturingKeys = () =>
    store.setState({ capture: null, recordMode: false, recorded: null });

  // ── Command implementations ────────────────────────────────────────────

  /** The active tab's id, or `null` — the guard nearly every tab command
   * opens with (its `When` already gates the shortcut, but the palette can
   * be racing a tab close). */
  const activeTab = (): string | null => app.store.getState().activeTabId;

  /** The active tab's id when it holds a query page — a query's or a
   * playlist's — else `null`: the same guard for the commands that act on a
   * query page, so one aimed at the settings tab does nothing rather than
   * writing query state under its id. */
  const activeQueryTab = (): string | null => {
    const id = activeTab();
    return id !== null && selectPageTab(app.store.getState(), id) !== undefined
      ? id
      : null;
  };

  /** Selects the next (`forward`) or previous tab, wrapping around. */
  const cycleTab = (forward: boolean) => {
    const tabs = app.store.getState().tabs;
    const cur = activeTab();
    if (tabs.length === 0 || cur === null) return;
    const idx = tabs.findIndex((t) => t.id === cur);
    if (idx === -1) return;
    const next = forward
      ? (idx + 1) % tabs.length
      : (idx + tabs.length - 1) % tabs.length;
    app.actions.selectTab(tabs[next].id);
  };

  /** Moves the active tab one slot right (`forward`) or left, clamped in
   * range. */
  const moveActiveTab = (forward: boolean) => {
    const tabs = app.store.getState().tabs;
    const cur = activeTab();
    if (cur === null) return;
    const idx = tabs.findIndex((t) => t.id === cur);
    if (idx === -1) return;
    app.actions.reorderTab(cur, forward ? idx + 1 : idx - 1);
  };

  /** Hands the keyboard back to the result rows: lets go of whatever holds DOM
   * focus (a text field, a record editor form item) and empties the form's
   * selection, since a form with a focus or selection is what keeps the arrow
   * keys from the rows (`recordFormFocused`). The rows are a canvas, so there
   * is no element to focus: the global key pass reaches them once nothing else
   * claims the keys. */
  const focusResults = (form: ReturnType<typeof selectFocusedForm>) => {
    if (
      typeof document !== "undefined" &&
      document.activeElement instanceof HTMLElement
    ) {
      document.activeElement.blur();
    }
    form?.noteBlur();
  };

  const execute = (cmd: CommandId) => {
    const tabId = activeTab();
    // Query-page commands read this instead, so they stand down on a
    // settings tab.
    const queryId = activeQueryTab();
    // The record editor form the user is working in, if any — the target of
    // the selection commands, and the first claim on the arrow keys.
    const form = selectFocusedForm(forms.store.getState());
    switch (cmd) {
      case "palette.open":
        togglePalette();
        break;
      case "shortcuts.configure":
        app.actions.openShortcutsTab();
        break;
      case "presets.manage":
        app.actions.openPresetsTab();
        break;
      // The About panel runs a check as it opens, so this is the check *and*
      // somewhere to see its answer.
      case "app.check_for_updates":
        app.actions.openAbout();
        break;
      case "explorer.toggle":
        app.actions.toggleSidebar();
        break;
      case "playback.toggle_play":
        app.actions.togglePlayPause();
        break;
      case "playback.next_track":
        app.actions.skipNext();
        break;
      case "playback.previous_track":
        app.actions.skipPrevious();
        break;
      case "playback.seek_backward":
        app.actions.seekBy(-SEEK_STEP_SECONDS);
        break;
      case "playback.seek_forward":
        app.actions.seekBy(SEEK_STEP_SECONDS);
        break;
      // Like the row menu's entries, these act on the selected rows.
      case "queue.add_selected":
        if (tabId)
          app.actions.queueRows(
            tabId,
            selectRowSelection(app.store.getState(), tabId),
            "last",
          );
        break;
      case "queue.add_selected_next":
        if (tabId)
          app.actions.queueRows(
            tabId,
            selectRowSelection(app.store.getState(), tabId),
            "next",
          );
        break;
      case "queue.remove_selected":
        if (tabId)
          app.actions.unqueueRows(
            tabId,
            selectRowSelection(app.store.getState(), tabId),
          );
        break;
      case "queue.clear":
        app.actions.clearQueue();
        break;
      case "query.new":
        app.actions.newQueryTab();
        break;
      case "query.focus_filter":
        if (queryId) app.actions.focusBuilderSection(queryId, "filter");
        break;
      case "query.focus_sort":
        if (queryId) app.actions.focusBuilderSection(queryId, "sort");
        break;
      case "query.focus_display":
        if (queryId) app.actions.focusBuilderSection(queryId, "display");
        break;
      case "query.convert_to_playlist":
        // The action checks that the rows are the query's tracks.
        if (tabId) app.actions.convertToPlaylist(tabId);
        break;
      case "playlist.remove_selected_tracks":
        // The action checks that the tab is a playlist's.
        if (tabId)
          app.actions.removeRows(
            tabId,
            selectRowSelection(app.store.getState(), tabId),
          );
        break;
      // Up/Down move the row selection — unless the user is inside a record
      // editor form, where they move between its items instead (the form is
      // reached *from* the rows, and its items are what's in front of the
      // user once it is).
      case "results.select_next":
        if (form) form.focusAdjacent(true);
        else if (tabId) app.actions.moveRowSelection(tabId, true, false);
        break;
      case "results.select_previous":
        if (form) form.focusAdjacent(false);
        else if (tabId) app.actions.moveRowSelection(tabId, false, false);
        break;
      case "results.extend_selection_down":
        if (tabId) app.actions.moveRowSelection(tabId, true, true);
        break;
      case "results.extend_selection_up":
        if (tabId) app.actions.moveRowSelection(tabId, false, true);
        break;
      case "results.select_all":
        if (tabId) app.actions.selectAllRows(tabId);
        break;
      case "record.save":
        if (tabId)
          void selectModifiedForm(forms.store.getState(), tabId)?.save();
        break;
      case "record.autocomplete":
        selectAutocompleteForm(forms.store.getState())?.toggleAutocomplete();
        break;
      case "results.edit_selected":
        if (tabId) app.actions.toggleRecordEditor(tabId);
        break;
      case "results.go_to_playing_track":
        app.actions.locateCurrentTrack();
        break;
      case "results.focus":
        focusResults(form);
        break;
      case "record.focus":
        if (queryId) app.actions.focusRecordEditor(queryId);
        break;
      case "rating.playing_most_common":
        app.actions.ratePlayingTrackMostCommon();
        break;
      case "rating.selected_most_common":
        if (tabId) app.actions.rateSelectedTracksMostCommon(tabId);
        break;
      case "rating.playing_decrease":
        app.actions.stepPlayingTrackRating(-1);
        break;
      case "rating.playing_increase":
        app.actions.stepPlayingTrackRating(1);
        break;
      case "selection.expand_nested":
        form?.expandSelection(true);
        break;
      case "selection.collapse_nested":
        form?.expandSelection(false);
        break;
      case "selection.delete":
        form?.deleteSelection();
        break;
      case "tabs.save_active":
        // Guarded on `isUnsaved`: a save is a backend write that bumps
        // `modified_at`, and the toolbar's Save button is likewise only
        // there while unsaved.
        if (queryId && selectIsUnsaved(app.store.getState(), queryId))
          app.actions.saveQuery(queryId);
        break;
      case "tabs.save_all": {
        // Snapshot the ids first: saving mutates the tabs array.
        const state = app.store.getState();
        for (const id of state.tabs.map((t) => t.id)) {
          if (selectIsUnsaved(state, id)) app.actions.saveQuery(id);
        }
        break;
      }
      case "tabs.close_active":
        if (tabId) app.actions.closeTab(tabId);
        break;
      case "tabs.rename_active":
        // `beginRename` itself stands down for a tab with no source to rename.
        if (queryId) app.actions.beginRename(queryId);
        break;
      case "tabs.next":
        cycleTab(true);
        break;
      case "tabs.previous":
        cycleTab(false);
        break;
      case "tabs.switch_next":
        app.actions.stepTabSwitcher(1);
        break;
      case "tabs.switch_previous":
        app.actions.stepTabSwitcher(-1);
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
   * `palette.open` is left out of the MRU: it's the command that *opened*
   * the list, so listing it back as the most recent thing you did would
   * permanently occupy the top slot with the one command nobody needs to
   * find there. */
  const run = (cmd: CommandId) => {
    if (cmd !== "palette.open") {
      store.setState((s) => {
        s.mru = [cmd, ...s.mru.filter((c) => c !== cmd)].slice(0, MRU_LIMIT);
      });
    }
    execute(cmd);
  };

  // ── The global shortcut pass ─────────────────────────────────────────────

  /** Whether something that owns the keyboard is up, so the global pass
   * stands down. The shortcuts editor's *tab* does not count — the app keeps
   * running behind it — but its chord capture does, so a chord typed at it
   * rebinds instead of firing. An open dropdown/context menu counts too: its
   * own Up/Down/Enter handling (`ui/useMenu`) must be the
   * only thing acting on those keys, not also a page command like row
   * selection underneath it. So do result rows in hand: a key mustn't act on
   * the rows being dragged (Escape, which calls the drag off, is the grid's). */
  const suppressed = (): boolean => {
    const s = store.getState();
    const a = app.store.getState();
    return (
      s.paletteOpen ||
      capturingKeys() ||
      a.pendingDelete !== null ||
      a.pendingAddToPlaylist !== null ||
      a.rowDrag !== null ||
      a.viewSql !== null ||
      a.exportData !== null ||
      a.presetSave !== null ||
      a.renaming !== null ||
      a.aboutOpen ||
      selectRecordPickerOpen(forms.store.getState()) ||
      selectAnyMenuOpen(menus.store.getState())
    );
  };

  /** The keys of the open tab switcher, which owns the keyboard: its own
   * chords step it, Enter and Escape close it, and the arrows move the
   * highlight. Everything else is swallowed, so a key can't act on the page
   * behind the overlay. */
  const handleSwitcherKey = (e: KeyboardEvent, pressed: Chord | null) => {
    // A modifier on its own (the one being held, or Shift joining it).
    if (!pressed) return;
    e.preventDefault();
    e.stopPropagation();
    const command = commandForChord(
      store.getState().overrides,
      pressed,
      context(),
    );
    if (command === "tabs.switch_next") return app.actions.stepTabSwitcher(1);
    if (command === "tabs.switch_previous")
      return app.actions.stepTabSwitcher(-1);
    // The modifier is still held, so it doesn't count against the key.
    switch (pressed.key) {
      case "Escape":
        return app.actions.cancelTabSwitcher();
      case "Enter":
        return app.actions.commitTabSwitcher();
      case "Down":
      case "Right":
        return app.actions.stepTabSwitcher(1);
      case "Up":
      case "Left":
        return app.actions.stepTabSwitcher(-1);
      case "Tab":
        return app.actions.stepTabSwitcher(pressed.shift ? -1 : 1);
    }
  };

  /** Letting go of the modifier the switcher was opened with picks the
   * highlighted tab. */
  const handleKeyUp = (e: KeyboardEvent) => {
    if (!app.store.getState().tabSwitcher) return;
    if (e.key === "Control" || e.key === "Meta" || e.key === "Alt") {
      app.actions.commitTabSwitcher();
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    const pressed = chordFromEvent(e);
    if (app.store.getState().tabSwitcher) {
      handleSwitcherKey(e, pressed);
      return;
    }
    if (suppressed()) return;
    if (!pressed) return;
    // A text field keeps its own plain / shift-only keys.
    const inTextField = isTypingTarget(e.target);
    if (inTextField && !(pressed.mod || pressed.ctrl || pressed.alt)) return;
    if (claimsKey(e.target, pressed)) return;
    const command = commandForChord(
      store.getState().overrides,
      pressed,
      context(),
      inTextField,
    );
    if (command === null) return;
    // Matched: the key belongs to the command, not to the page.
    e.preventDefault();
    e.stopPropagation();
    run(command);
  };

  const actions: CommandsActions = {
    loadKeymap: async () => {
      try {
        const list = await keybindingList();
        store.setState({ overrides: overridesFromEntries(list ?? []) });
      } catch (err) {
        console.error("keybinding list failed", err);
      }
    },
    setBinding,
    resetBinding: (cmd) => applyBinding(cmd, commandDef(cmd).defaultChord),
    run,

    togglePalette,
    closePalette,
    setPaletteQuery: (text) =>
      // A new query means a new list; start from the top of it.
      store.setState({ paletteQuery: text, paletteIndex: 0 }),
    setPaletteIndex: (index) => store.setState({ paletteIndex: index }),
    movePaletteIndex: (delta) => {
      const s = store.getState();
      const n = selectPaletteItems(s, context()).length;
      if (n === 0) return;
      const clamped = selectClampedPaletteIndex(s, n);
      store.setState({ paletteIndex: (clamped + delta + n) % n });
    },

    setShortcutsSearch: (text) => store.setState({ shortcutsSearch: text }),
    stopCapturingKeys,
    openCapture: (cmd) =>
      store.setState({
        capture: { cmd, pending: selectBinding(store.getState(), cmd) },
      }),
    closeCapture: () => store.setState({ capture: null }),
    setCapturePending: (chord) =>
      store.setState((s) => {
        if (s.capture) s.capture.pending = chord;
      }),
    setRecordMode: (on) => store.setState({ recordMode: on, recorded: null }),
    setRecorded: (chord) => store.setState({ recorded: chord }),

    handleKeyDown,
    handleKeyUp,
  };

  return { store, actions };
}

export type CommandsStoreBundle = ReturnType<typeof createCommandsStore>;
