import { describe, expect, it } from "vitest";
import { chordToStorage, parseChord } from "./chord";
import {
  bindingFor,
  commandForChord,
  overridesFromEntries,
  resolveBindings,
  withOverride,
} from "./keymap";
import { ALL_COMMANDS, commandDef, commandDefById } from "./registry";
import { rankCommands } from "./rank";

// The registry invariants, mirroring the `commands.rs` test module.
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
    // An egui-only command whose feature isn't ported (see registry.ts).
    expect(commandDefById("tabs.pin_active")).toBeUndefined();
  });

  it("round-trips every default chord through storage", () => {
    for (const def of ALL_COMMANDS) {
      if (!def.defaultChord) continue;
      const s = chordToStorage(def.defaultChord);
      expect(parseChord(s), `${def.id}: ${s}`).toEqual(def.defaultChord);
    }
  });

  it("gives no two commands the same default chord", () => {
    const seen = new Set<string>();
    for (const def of ALL_COMMANDS) {
      if (!def.defaultChord) continue;
      const s = chordToStorage(def.defaultChord);
      expect(seen.has(s), `duplicate default chord ${s} on ${def.id}`).toBe(
        false,
      );
      seen.add(s);
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
      resolveBindings(overrides).some((b) => b.command === "explorer.toggle"),
    ).toBe(false);
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
    expect(commandForChord({}, parseChord("mod+shift+P")!)).toBe(
      "palette.open",
    );
    const overrides = withOverride({}, "palette.open", parseChord("mod+J")!);
    expect(commandForChord(overrides, parseChord("mod+J")!)).toBe(
      "palette.open",
    );
    expect(commandForChord(overrides, parseChord("mod+shift+P")!)).toBeNull();
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
