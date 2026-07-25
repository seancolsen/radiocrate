import { describe, expect, it } from "vitest";
import {
  chordFromEvent,
  chordMatchesEvent,
  chordToStorage,
  chordsEqual,
  formatChord,
  keyNameFromCode,
  parseChord,
  type Chord,
  type KeyEventLike,
} from "./chord";

/** A key-press event with no modifiers held unless overridden. */
function ev(code: string, mods: Partial<KeyEventLike> = {}): KeyEventLike {
  return {
    code,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  };
}

const chord = (over: Partial<Chord>): Chord => ({
  mod: false,
  ctrl: false,
  shift: false,
  alt: false,
  key: "P",
  ...over,
});

describe("parseChord / chordToStorage", () => {
  it("round-trips the storage form", () => {
    for (const s of [
      "mod+shift+P",
      "mod+B",
      "shift+N",
      "shift+Space",
      "Down",
      "shift+Up",
      "mod+alt+Right",
      "mod+shift+alt+Left",
      "ctrl+K",
      "F5",
      "mod+1",
    ]) {
      const parsed = parseChord(s);
      expect(parsed, s).not.toBeNull();
      expect(chordToStorage(parsed!)).toBe(s);
    }
  });

  it("rejects unknown modifier tokens and key names", () => {
    expect(parseChord("hyper+P")).toBeNull();
    expect(parseChord("mod+shift+NotAKey")).toBeNull();
    expect(parseChord("")).toBeNull();
  });

  it("accepts legacy key-name aliases, canonicalizing them", () => {
    expect(parseChord("shift+ArrowDown")).toEqual(
      chord({ shift: true, key: "Down" }),
    );
    expect(parseChord("mod+p")).toEqual(chord({ mod: true, key: "P" }));
    expect(chordToStorage(parseChord("shift+ArrowDown")!)).toBe("shift+Down");
  });

  it("keeps a bare ctrl chord distinct from a mod chord", () => {
    expect(chordToStorage(chord({ ctrl: true, key: "K" }))).toBe("ctrl+K");
    // `mod` wins: no separate `ctrl+` token is written alongside it.
    expect(chordToStorage(chord({ mod: true, ctrl: true, key: "K" }))).toBe(
      "mod+K",
    );
  });
});

describe("keyNameFromCode", () => {
  it("maps DOM codes to canonical key names", () => {
    expect(keyNameFromCode("KeyP")).toBe("P");
    expect(keyNameFromCode("Digit4")).toBe("4");
    expect(keyNameFromCode("Numpad4")).toBe("4");
    expect(keyNameFromCode("ArrowDown")).toBe("Down");
    expect(keyNameFromCode("Space")).toBe("Space");
    expect(keyNameFromCode("Equal")).toBe("Equals");
    expect(keyNameFromCode("F12")).toBe("F12");
  });

  it("has no name for an unbindable key", () => {
    expect(keyNameFromCode("ShiftLeft")).toBeNull();
    expect(keyNameFromCode("MetaRight")).toBeNull();
    expect(keyNameFromCode("Lang1")).toBeNull();
  });
});

describe("chordFromEvent", () => {
  it("reads Ctrl as the mod key off-mac", () => {
    expect(chordFromEvent(ev("KeyB", { ctrlKey: true }), false)).toEqual(
      chord({ mod: true, key: "B" }),
    );
  });

  it("reads ⌘ as mod and Control as itself on mac", () => {
    expect(chordFromEvent(ev("KeyB", { metaKey: true }), true)).toEqual(
      chord({ mod: true, key: "B" }),
    );
    expect(chordFromEvent(ev("KeyB", { ctrlKey: true }), true)).toEqual(
      chord({ ctrl: true, key: "B" }),
    );
  });

  it("is null for a bare modifier press", () => {
    expect(
      chordFromEvent(ev("ShiftLeft", { shiftKey: true }), false),
    ).toBeNull();
  });
});

describe("chordMatchesEvent", () => {
  const down = chord({ key: "Down" });
  const shiftDown = chord({ shift: true, key: "Down" });

  it("matches exactly, so plain and shift chords stay distinct", () => {
    expect(chordMatchesEvent(down, ev("ArrowDown"), false)).toBe(true);
    expect(
      chordMatchesEvent(down, ev("ArrowDown", { shiftKey: true }), false),
    ).toBe(false);
    expect(
      chordMatchesEvent(shiftDown, ev("ArrowDown", { shiftKey: true }), false),
    ).toBe(true);
    expect(chordMatchesEvent(shiftDown, ev("ArrowDown"), false)).toBe(false);
  });

  it("treats a chord's ctrl as the mod key off-mac only", () => {
    const ctrlK = chord({ ctrl: true, key: "K" });
    expect(chordMatchesEvent(ctrlK, ev("KeyK", { ctrlKey: true }), false)).toBe(
      true,
    );
    expect(chordMatchesEvent(ctrlK, ev("KeyK", { ctrlKey: true }), true)).toBe(
      true,
    );
    expect(chordMatchesEvent(ctrlK, ev("KeyK", { metaKey: true }), true)).toBe(
      false,
    );
  });

  it("never matches a Meta press off-mac", () => {
    const modP = chord({ mod: true, key: "P" });
    expect(chordMatchesEvent(modP, ev("KeyP", { metaKey: true }), false)).toBe(
      false,
    );
  });
});

describe("formatChord", () => {
  it("uses glyphs on mac and names elsewhere", () => {
    const c = chord({ mod: true, shift: true, key: "P" });
    expect(formatChord(c, true)).toBe("⇧⌘P");
    expect(formatChord(c, false)).toBe("Ctrl+Shift+P");
  });

  it("orders mac modifiers ⌃⌥⇧⌘", () => {
    const c = chord({
      mod: true,
      ctrl: true,
      shift: true,
      alt: true,
      key: "Q",
    });
    // `ctrl` alongside `mod` is folded into ⌘, as `to_storage` folds it away.
    expect(formatChord(c, true)).toBe("⌥⇧⌘Q");
    expect(formatChord(chord({ ctrl: true, alt: true, key: "Q" }), true)).toBe(
      "⌃⌥Q",
    );
  });
});

describe("chordsEqual", () => {
  it("compares every field", () => {
    expect(chordsEqual(chord({}), chord({}))).toBe(true);
    expect(chordsEqual(chord({}), chord({ shift: true }))).toBe(false);
    expect(chordsEqual(chord({}), chord({ key: "Q" }))).toBe(false);
  });
});
