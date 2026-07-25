// The command registry, ported from `frontend-old-egui/src/commands.rs`
// (`CommandId`, `ALL_COMMANDS`, `When`).
//
// Every user-triggerable action the command palette or a keyboard shortcut can
// invoke is one entry here: a stable `snake_case`-ish id (the string persisted
// to the `settings.keybinding` table — never change a shipped one), a
// human-readable `"Category: Action"` title, a {@link When} context gating when
// its shortcut may fire, and a built-in default chord. User overrides layer on
// top (see `keymap.ts`); everything else uses its default.
//
// ## What the egui registry had that this one doesn't
//
// Commands whose target feature hasn't been ported to the DOM frontend are
// omitted rather than left dead:
//
// - `query.new` — the tab bar's "+" is still an inert placeholder; there is no
//   create-a-query path in the store yet.
// - `tabs.pin_active` / `tabs.unpin_active` — tabs carry no pinned state.
// - `selection.expand_nested` / `selection.collapse_nested` /
//   `selection.delete` — these act on the record editor's *form* selection, and
//   the form (`form.rs`) is not ported; the editor panel only names the record
//   it points at.
//
// Their ids stay reserved: an override persisted for one by the egui build is
// skipped on load (`overridesFromEntries`) and left in the database untouched,
// so it comes back if the command does.
//
// The `When` set is likewise smaller. egui separated `ActiveTab`, `AnyTabOpen`
// and `QueryTabActive`; here every tab is a query tab and a tab is active
// exactly when one is open, so those three collapse into `activeTab`. Its
// `SelectionAvailable` (results *or* form selection) collapses into `results`
// for the same reason as the omissions above.

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
  | "tabs.save_active"
  | "tabs.save_all"
  | "tabs.close_active"
  | "tabs.next"
  | "tabs.previous"
  | "tabs.move_left"
  | "tabs.move_right";

/** The context gating a command. Deliberately a fixed set of boolean predicates
 * over {@link CommandContext}, not an expression language. */
export type When = "always" | "activeTab" | "results" | "trackLoaded";

/** A snapshot of the app state the {@link When} predicates read, computed per
 * input pass / palette render. */
export interface CommandContext {
  /** A tab is open (and therefore active). */
  activeTab: boolean;
  /** The active tab has result rows. */
  resultsAvailable: boolean;
  /** A track is loaded in the now-playing bar. */
  trackLoaded: boolean;
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
    // Ships unbound, as in egui — it's reachable from the palette, and an
    // editor that can rebind everything doesn't need to claim a chord itself.
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
    when: "activeTab",
    defaultChord: chordOf("mod+shift+F"),
  },
  {
    id: "query.focus_sort",
    title: "Query: Focus sort builder",
    when: "activeTab",
    defaultChord: chordOf("mod+shift+S"),
  },
  {
    id: "query.focus_display",
    title: "Query: Focus display builder",
    when: "activeTab",
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
    id: "tabs.save_active",
    title: "Tabs: Save active tab",
    when: "activeTab",
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
    case "results":
      return ctx.resultsAvailable;
    case "trackLoaded":
      return ctx.trackLoaded;
  }
}

/** A short label for the shortcuts editor's "When" column. Empty for `always`. */
export function whenLabel(when: When): string {
  switch (when) {
    case "always":
      return "";
    case "activeTab":
      return "tab open";
    case "results":
      return "results";
    case "trackLoaded":
      return "track loaded";
  }
}
