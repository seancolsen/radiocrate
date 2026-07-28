// The command registry.
//
// Every user-triggerable action the command palette or a keyboard shortcut can
// invoke is one entry here: a stable `snake_case`-ish id (the string persisted
// to the `settings.keybinding` table — never change a shipped one), a
// human-readable `"Category: Action"` title, a {@link When} context gating when
// its shortcut may fire, and a built-in default chord. User overrides layer on
// top (see `keymap.ts`); everything else uses its default.
//
// ## Commands intentionally not in this registry
//
// Commands whose target feature hasn't been built yet are omitted rather than
// left dead:
//
// - `query.new` — the tab bar's "+" is still an inert placeholder; there is no
//   create-a-query path in the store yet.
// - `tabs.pin_active` / `tabs.unpin_active` — tabs carry no pinned state.
//
// Their ids stay reserved: a stored override for one of them is skipped on
// load (`overridesFromEntries`) and left in the database untouched, so it
// comes back if the command does.

import { chordOf, type Chord } from "./chord";

/** Every command the palette lists and a keyboard shortcut can invoke. */
export type CommandId =
  | "palette.open"
  | "shortcuts.configure"
  | "explorer.toggle"
  | "playback.toggle_play"
  | "playback.next_track"
  | "query.focus_filter"
  | "query.focus_sort"
  | "query.focus_display"
  | "results.select_next"
  | "results.select_previous"
  | "results.extend_selection_down"
  | "results.extend_selection_up"
  | "results.edit_selected"
  | "selection.expand_nested"
  | "selection.collapse_nested"
  | "selection.delete"
  | "tabs.save_active"
  | "tabs.save_all"
  | "tabs.close_active"
  | "tabs.next"
  | "tabs.previous"
  | "tabs.move_left"
  | "tabs.move_right";

/** The context gating a command. Deliberately a fixed set of boolean predicates
 * over {@link CommandContext}, not an expression language. */
export type When =
  | "always"
  | "activeTab"
  | "queryTab"
  | "results"
  | "trackLoaded"
  | "recordForm";

/** A snapshot of the app state the {@link When} predicates read, computed per
 * input pass / palette render. */
export interface CommandContext {
  /** A tab is open (and therefore active), whatever page it holds. */
  activeTab: boolean;
  /** The active tab is a query page — what the query-only commands need. */
  queryTabActive: boolean;
  /** The active tab has result rows. */
  resultsAvailable: boolean;
  /** A track is loaded in the now-playing bar. */
  trackLoaded: boolean;
  /** The user is working inside a record editor form: one of its items holds
   * focus, or it has a selection. The arrow keys belong to the form then, not to
   * the result rows or anything else on the page. */
  recordFormFocused: boolean;
}

export interface CommandDef {
  id: CommandId;
  /** The palette/editor display title, `"Category: Action"`. */
  title: string;
  when: When;
  /** The built-in default chord; `null` for a command that ships unbound. */
  defaultChord: Chord | null;
}

/** Every command, in the order the palette lists them (grouped by category). */
export const ALL_COMMANDS: readonly CommandDef[] = [
  {
    id: "palette.open",
    title: "Commands: Open command palette",
    when: "always",
    defaultChord: chordOf("mod+shift+P"),
  },
  {
    // Ships unbound — it's reachable from the palette, and an editor that can
    // rebind everything doesn't need to claim a chord itself.
    id: "shortcuts.configure",
    title: "Commands: Configure keyboard shortcuts",
    when: "always",
    defaultChord: null,
  },
  {
    id: "explorer.toggle",
    title: "Explorer: Toggle explorer sidebar",
    when: "always",
    defaultChord: chordOf("mod+B"),
  },
  {
    id: "playback.toggle_play",
    title: "Playback: Toggle play/pause of active track",
    when: "trackLoaded",
    defaultChord: chordOf("shift+Space"),
  },
  {
    id: "playback.next_track",
    title: "Playback: Skip to next track",
    when: "trackLoaded",
    defaultChord: chordOf("shift+N"),
  },
  {
    id: "query.focus_filter",
    title: "Query: Focus filter builder",
    when: "queryTab",
    defaultChord: chordOf("mod+shift+F"),
  },
  {
    id: "query.focus_sort",
    title: "Query: Focus sort builder",
    when: "queryTab",
    defaultChord: chordOf("mod+shift+S"),
  },
  {
    id: "query.focus_display",
    title: "Query: Focus display builder",
    when: "queryTab",
    defaultChord: chordOf("mod+shift+D"),
  },
  {
    id: "results.select_next",
    title: "Selection: Select down",
    when: "results",
    defaultChord: chordOf("Down"),
  },
  {
    id: "results.select_previous",
    title: "Selection: Select up",
    when: "results",
    defaultChord: chordOf("Up"),
  },
  {
    id: "results.extend_selection_down",
    title: "Selection: Extend selection down",
    when: "results",
    defaultChord: chordOf("shift+Down"),
  },
  {
    id: "results.extend_selection_up",
    title: "Selection: Extend selection up",
    when: "results",
    defaultChord: chordOf("shift+Up"),
  },
  {
    // Opens the record editor on the current row selection — the keyboard/
    // palette equivalent of a row's "Edit {table}" context-menu entry. `when`
    // only requires *some* results (not a non-empty selection): the command
    // simply does nothing if nothing's selected, same as the other row commands
    // racing a tab close.
    id: "results.edit_selected",
    title: "Results: Edit selected rows",
    when: "results",
    defaultChord: chordOf("mod+E"),
  },
  // The three commands below act on the record editor form's selection — the
  // items it has selected, or the one it has focused. They're gated on the form
  // holding focus, which is what lets them claim bare arrow keys and Delete
  // without taking those keys from the rest of the app.
  {
    id: "selection.expand_nested",
    title: "Selection: Expand nested items",
    when: "recordForm",
    defaultChord: chordOf("Right"),
  },
  {
    id: "selection.collapse_nested",
    title: "Selection: Collapse nested items",
    when: "recordForm",
    defaultChord: chordOf("Left"),
  },
  {
    id: "selection.delete",
    title: "Selection: Delete",
    when: "recordForm",
    defaultChord: chordOf("Delete"),
  },
  {
    id: "tabs.save_active",
    title: "Tabs: Save active tab",
    when: "queryTab",
    defaultChord: chordOf("mod+S"),
  },
  {
    id: "tabs.save_all",
    title: "Tabs: Save all unsaved tabs",
    when: "activeTab",
    defaultChord: chordOf("mod+alt+S"),
  },
  {
    id: "tabs.close_active",
    title: "Tabs: Close active tab",
    when: "activeTab",
    defaultChord: chordOf("mod+alt+W"),
  },
  {
    id: "tabs.next",
    title: "Tabs: Go to next tab",
    when: "activeTab",
    defaultChord: chordOf("mod+alt+Right"),
  },
  {
    id: "tabs.previous",
    title: "Tabs: Go to previous tab",
    when: "activeTab",
    defaultChord: chordOf("mod+alt+Left"),
  },
  {
    id: "tabs.move_left",
    title: "Tabs: Move active tab to the left",
    when: "activeTab",
    defaultChord: chordOf("mod+shift+alt+Left"),
  },
  {
    id: "tabs.move_right",
    title: "Tabs: Move active tab to the right",
    when: "activeTab",
    defaultChord: chordOf("mod+shift+alt+Right"),
  },
];

const BY_ID = new Map<CommandId, CommandDef>(
  ALL_COMMANDS.map((c) => [c.id, c]),
);

/** The definition for a known command id. */
export function commandDef(id: CommandId): CommandDef {
  const def = BY_ID.get(id);
  if (!def) throw new Error(`unknown command: ${id}`);
  return def;
}

/** Resolves a persisted id back to its command, or `undefined` for an id this
 * build doesn't know (an override for an omitted or newer command). */
export function commandDefById(id: string): CommandDef | undefined {
  return BY_ID.get(id as CommandId);
}

/** Whether a command's context is satisfied — the gate on both its shortcut
 * firing and its appearance in the palette. */
export function whenSatisfied(when: When, ctx: CommandContext): boolean {
  switch (when) {
    case "always":
      return true;
    case "activeTab":
      return ctx.activeTab;
    case "queryTab":
      return ctx.queryTabActive;
    case "results":
      return ctx.resultsAvailable;
    case "trackLoaded":
      return ctx.trackLoaded;
    case "recordForm":
      return ctx.recordFormFocused;
  }
}

/** A short label for the shortcuts editor's "When" column. Empty for `always`. */
export function whenLabel(when: When): string {
  switch (when) {
    case "always":
      return "";
    case "activeTab":
      return "tab open";
    case "queryTab":
      return "query tab active";
    case "results":
      return "results";
    case "trackLoaded":
      return "track loaded";
    case "recordForm":
      return "record editor focused";
  }
}
