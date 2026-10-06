import { describe, expect, it } from "vitest";
import { chordToStorage, parseChord } from "./chord";
import {
  bindingFor,
  commandForChord,
  conflictsFor,
  overridesFromEntries,
  withOverride,
} from "./keymap";
import {
  ALL_COMMANDS,
  commandDef,
  commandDefById,
  whensOverlap,
  type CommandContext,
} from "./registry";
import { rankCommands } from "./rank";

// The registry invariants.
describe("the command registry", () => {
  it("gives every command a unique id", () => {
    const ids = new Set(ALL_COMMANDS.map((c) => c.id));
    expect(ids.size).toBe(ALL_COMMANDS.length);
  });

  it("resolves every id back to its command", () => {
    for (const def of ALL_COMMANDS) {
      expect(commandDefById(def.id)).toBe(def);
      expect(commandDef(def.id)).toBe(def);
    }
  });

  it("does not resolve an id this build doesn't know", () => {
    // A command whose feature isn't built yet (see registry.ts).
    expect(commandDefById("tabs.pin_active")).toBeUndefined();
  });

  it("round-trips every default chord through storage", () => {
    for (const def of ALL_COMMANDS) {
      if (!def.defaultChord) continue;
      const s = chordToStorage(def.defaultChord);
      expect(parseChord(s), `${def.id}: ${s}`).toEqual(def.defaultChord);
    }
  });

  it("gives no two commands whose contexts overlap the same default chord", () => {
    for (const [i, a] of ALL_COMMANDS.entries()) {
      for (const b of ALL_COMMANDS.slice(i + 1)) {
        if (!a.defaultChord || !b.defaultChord) continue;
        if (!whensOverlap(a.when, b.when)) continue;
        expect(
          chordToStorage(a.defaultChord),
          `${a.id} and ${b.id} share a default chord`,
        ).not.toBe(chordToStorage(b.defaultChord));
      }
    }
  });

  it("binds plain and shift arrows to distinct commands", () => {
    const next = commandDef("results.select_next").defaultChord!;
    const extend = commandDef("results.extend_selection_down").defaultChord!;
    expect(next.key).toBe(extend.key);
    expect(next.shift).toBe(false);
    expect(extend.shift).toBe(true);
  });

  it("titles every command as 'Category: Action'", () => {
    for (const def of ALL_COMMANDS) expect(def.title).toMatch(/^[A-Z].+: .+/);
  });
});

/** A context in which no command but an `always` one applies. */
const NOWHERE: CommandContext = {
  activeTab: false,
  queryTabActive: false,
  queryTracksActive: false,
  playlistResultsActive: false,
  resultsAvailable: false,
  trackLoaded: false,
  recordFormFocused: false,
};

/** A context in which every command applies (which no real state is). */
const EVERYWHERE: CommandContext = {
  activeTab: true,
  queryTabActive: true,
  queryTracksActive: true,
  playlistResultsActive: true,
  resultsAvailable: true,
  trackLoaded: true,
  recordFormFocused: true,
};

describe("the keymap", () => {
  it("falls back to the default when there's no override", () => {
    expect(bindingFor({}, "explorer.toggle")).toEqual(
      commandDef("explorer.toggle").defaultChord,
    );
  });

  it("treats a null override as an explicit unbind", () => {
    const overrides = withOverride({}, "explorer.toggle", null);
    expect(bindingFor(overrides, "explorer.toggle")).toBeNull();
    expect(
      commandForChord(overrides, parseChord("mod+B")!, EVERYWHERE),
    ).toBeNull();
  });

  it("clears the override when a command is rebound to its default", () => {
    const def = commandDef("explorer.toggle").defaultChord!;
    const overrides = withOverride(
      withOverride({}, "explorer.toggle", parseChord("mod+J")!),
      "explorer.toggle",
      def,
    );
    expect("explorer.toggle" in overrides).toBe(false);
  });

  it("finds the command holding a chord, override or default", () => {
    expect(commandForChord({}, parseChord("mod+shift+P")!, EVERYWHERE)).toBe(
      "palette.open",
    );
    const overrides = withOverride({}, "palette.open", parseChord("mod+J")!);
    expect(commandForChord(overrides, parseChord("mod+J")!, EVERYWHERE)).toBe(
      "palette.open",
    );
    expect(
      commandForChord(overrides, parseChord("mod+shift+P")!, EVERYWHERE),
    ).toBeNull();
  });

  it("runs a shared chord's command whose context holds", () => {
    const del = parseChord("Delete")!;
    expect(
      commandForChord({}, del, { ...NOWHERE, recordFormFocused: true }),
    ).toBe("selection.delete");
    expect(
      commandForChord({}, del, { ...NOWHERE, playlistResultsActive: true }),
    ).toBe("playlist.remove_selected_tracks");
    expect(commandForChord({}, del, NOWHERE)).toBeNull();
  });

  it("finds conflicts only in commands whose contexts can overlap", () => {
    const del = parseChord("Delete")!;
    // The record form's Delete and a playlist's never compete.
    expect(conflictsFor({}, "playlist.remove_selected_tracks", del)).toEqual(
      [],
    );
    expect(conflictsFor({}, "selection.delete", del)).toEqual([]);
    // A results command competes with both: it holds wherever either does.
    expect(conflictsFor({}, "results.edit_selected", del)).toEqual([
      "playlist.remove_selected_tracks",
      "selection.delete",
    ]);
    // Rebinding a command to its own chord is no conflict.
    expect(conflictsFor({}, "explorer.toggle", parseChord("mod+B")!)).toEqual(
      [],
    );
    expect(conflictsFor({}, "tabs.next", parseChord("mod+B")!)).toEqual([
      "explorer.toggle",
    ]);
  });

  it("loads persisted rows, skipping unknown ids and bad chords", () => {
    const overrides = overridesFromEntries([
      { commandId: "explorer.toggle", chord: "mod+J" },
      { commandId: "palette.open", chord: null },
      { commandId: "tabs.pin_active", chord: "mod+alt+P" }, // not in this build
      { commandId: "tabs.next", chord: "hyper+X" }, // unparseable
    ]);
    expect(overrides["explorer.toggle"]).toEqual(parseChord("mod+J"));
    expect(overrides["palette.open"]).toBeNull();
    expect("tabs.pin_active" in overrides).toBe(false);
    expect("tabs.next" in overrides).toBe(false);
    expect(bindingFor(overrides, "tabs.next")).toEqual(
      commandDef("tabs.next").defaultChord,
    );
  });
});

describe("palette ranking", () => {
  const all = ALL_COMMANDS;

  it("lists MRU commands first, then registry order, for an empty query", () => {
    const ranked = rankCommands("", all, ["tabs.next", "explorer.toggle"]);
    expect(ranked.slice(0, 2).map((c) => c.id)).toEqual([
      "tabs.next",
      "explorer.toggle",
    ]);
    expect(ranked.length).toBe(all.length);
    expect(new Set(ranked).size).toBe(all.length);
  });

  it("ignores MRU entries that aren't currently available", () => {
    const available = all.filter((c) => c.when === "always");
    const ranked = rankCommands("", available, ["tabs.next"]);
    expect(ranked.map((c) => c.id)).toEqual(available.map((c) => c.id));
  });

  it("ranks substring matches above subsequence matches", () => {
    const ranked = rankCommands("tabs", all, []);
    // Every "Tabs: …" title contains the substring; nothing else may outrank it.
    expect(ranked[0].title.startsWith("Tabs:")).toBe(true);
    expect(ranked.some((c) => c.id === "tabs.close_active")).toBe(true);
  });

  it("matches a subsequence and drops non-matches", () => {
    // 'command' minus an m: no title contains it, but it is a subsequence of
    // "Commands: Open command palette".
    const fuzzy = rankCommands("comand", all, []);
    expect(fuzzy.map((c) => c.id)).toContain("palette.open");
    expect(all.some((c) => c.title.toLowerCase().includes("comand"))).toBe(
      false,
    );
    expect(rankCommands("zqx", all, [])).toEqual([]);
  });

  it("ignores spaces in the needle when matching a subsequence", () => {
    const ranked = rankCommands("expl side", all, []);
    expect(ranked.map((c) => c.id)).toContain("explorer.toggle");
  });
});
