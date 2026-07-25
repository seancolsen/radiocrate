// The keybinding chord model. A chord is a set of modifiers plus one key,
// stored platform-neutrally and rendered with per-OS glyphs.
//
// ## Storage compatibility
//
// The serialized form (`mod+shift+P`, `shift+Down`) is the *same string*
// written to the `settings.keybinding` table by earlier versions of this app,
// so existing stored bindings still resolve: letters are uppercase (`P`),
// digits bare (`1`), and the arrows are `Down`/`Up`/`Left`/`Right` (not the
// DOM's `ArrowDown`). Parsing additionally accepts a set of legacy aliases, so
// a hand-written or older stored value still resolves.
//
// ## Cross-platform modifiers
//
// `mod` is the platform command key — ⌘ on macOS, Ctrl everywhere else. `ctrl`
// is *physical* Control as distinct from `mod`, which only exists as a separate
// thing on macOS: on Windows/Linux a Control press is the mod key, so a
// chord's `ctrl` and `mod` both match `ctrlKey` there.

/** A modifier+key chord, e.g. ⌘⇧P. */
export interface Chord {
  /** The platform command key: ⌘ on macOS, Ctrl elsewhere. */
  mod: boolean;
  /** Physical Control, as distinct from {@link Chord.mod} (macOS only). */
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  /** A canonical key name — see the module comment. */
  key: string;
}

/** The subset of `KeyboardEvent` a chord is read from. Narrowed to a plain shape
 * so the chord logic stays testable under Vitest's `node` environment (no DOM). */
export interface KeyEventLike {
  /** The physical key (`KeyP`, `ArrowDown`, `Space`) — layout- and
   * shift-independent, unlike `key`, so ⇧P and P read as the same key. */
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Whether this is a Mac, which decides both what `mod` matches and how a chord
 * is rendered. Guarded so the module is importable without a DOM. */
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

/** `KeyboardEvent.code` → canonical key name, for the codes worth binding. */
const CODE_NAMES: Readonly<Record<string, string>> = {
  Space: "Space",
  Enter: "Enter",
  NumpadEnter: "Enter",
  Escape: "Escape",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowDown: "Down",
  ArrowUp: "Up",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Comma: "Comma",
  Period: "Period",
  Minus: "Minus",
  Equal: "Equals",
  Slash: "Slash",
  Backslash: "Backslash",
  Semicolon: "Semicolon",
  Quote: "Quote",
  Backquote: "Backtick",
  BracketLeft: "OpenBracket",
  BracketRight: "CloseBracket",
};

/** Names accepted on parse but stored/emitted under a different spelling —
 * legacy stored-format aliases, plus the DOM arrow spellings. */
const NAME_ALIASES: Readonly<Record<string, string>> = {
  ArrowDown: "Down",
  ArrowUp: "Up",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Esc: "Escape",
  Return: "Enter",
  " ": "Space",
};

/** The canonical spellings of the non-alphanumeric keys. */
const NAMED_KEYS: ReadonlySet<string> = new Set(Object.values(CODE_NAMES));

/** The canonical key name for a `KeyboardEvent.code`, or `null` for a code that
 * can't be bound (a bare modifier, an IME key, an unmapped code). */
export function keyNameFromCode(code: string): string | null {
  const named = CODE_NAMES[code];
  if (named) return named;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (digit) return digit[1];
  const fn = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code);
  if (fn) return `F${fn[1]}`;
  return null;
}

/** Canonicalizes a key name read from storage, or `null` when unrecognized. */
function normalizeKeyName(token: string): string | null {
  const alias = NAME_ALIASES[token];
  if (alias) return alias;
  if (/^[A-Za-z]$/.test(token)) return token.toUpperCase();
  if (/^[0-9]$/.test(token)) return token;
  const fn = /^[fF]([1-9]|1[0-9]|2[0-4])$/.exec(token);
  if (fn) return `F${fn[1]}`;
  return NAMED_KEYS.has(token) ? token : null;
}

/** Serializes to the form persisted in `settings.keybinding.chord`, e.g.
 * `"mod+shift+P"`. Modifier tokens are lowercase and canonically ordered (mod,
 * ctrl, shift, alt). */
export function chordToStorage(chord: Chord): string {
  let s = "";
  if (chord.mod) s += "mod+";
  if (chord.ctrl && !chord.mod) s += "ctrl+";
  if (chord.shift) s += "shift+";
  if (chord.alt) s += "alt+";
  return s + chord.key;
}

/** Parses the storage form. Returns `null` for an unrecognized modifier token or
 * key name (so a binding written by a newer build is ignored, not misapplied).
 * The key is the last `+`-separated token. */
export function parseChord(s: string): Chord | null {
  const parts = s.split("+");
  const keyToken = parts.pop();
  if (keyToken === undefined) return null;
  const chord: Chord = {
    mod: false,
    ctrl: false,
    shift: false,
    alt: false,
    key: "",
  };
  for (const part of parts) {
    switch (part.toLowerCase()) {
      case "mod":
        chord.mod = true;
        break;
      case "ctrl":
        chord.ctrl = true;
        break;
      case "shift":
        chord.shift = true;
        break;
      case "alt":
        chord.alt = true;
        break;
      default:
        return null;
    }
  }
  const key = normalizeKeyName(keyToken);
  if (key === null) return null;
  chord.key = key;
  return chord;
}

/** {@link parseChord} for literals known to be valid (the built-in defaults).
 * Throws rather than returning `null`, so a typo fails at module load. */
export function chordOf(s: string): Chord {
  const chord = parseChord(s);
  if (!chord) throw new Error(`invalid default chord: ${s}`);
  return chord;
}

export function chordsEqual(a: Chord, b: Chord): boolean {
  return (
    a.mod === b.mod &&
    a.ctrl === b.ctrl &&
    a.shift === b.shift &&
    a.alt === b.alt &&
    a.key === b.key
  );
}

/** A human-readable rendering for the current OS: `⇧⌘P` on macOS (⌃⌥⇧⌘ order,
 * no separators), `Ctrl+Shift+P` elsewhere. */
export function formatChord(chord: Chord, mac: boolean = isMac()): string {
  let s = "";
  if (mac) {
    if (chord.ctrl && !chord.mod) s += "⌃"; // ⌃
    if (chord.alt) s += "⌥"; // ⌥
    if (chord.shift) s += "⇧"; // ⇧
    if (chord.mod) s += "⌘"; // ⌘
  } else {
    if (chord.mod || chord.ctrl) s += "Ctrl+";
    if (chord.alt) s += "Alt+";
    if (chord.shift) s += "Shift+";
  }
  return s + chord.key;
}

/** The chord a key-press event stands for, or `null` when its key can't be
 * bound. Off-mac a Control press reads as `mod` (never as the separate
 * `ctrl`). */
export function chordFromEvent(
  e: KeyEventLike,
  mac: boolean = isMac(),
): Chord | null {
  const key = keyNameFromCode(e.code);
  if (key === null) return null;
  return {
    mod: mac ? e.metaKey : e.ctrlKey,
    ctrl: mac ? e.ctrlKey : false,
    shift: e.shiftKey,
    alt: e.altKey,
    key,
  };
}

/** Whether an event is exactly this chord — every modifier compared, so a
 * plain `Down` binding does not also swallow `Shift+Down` (they're distinct
 * commands: select vs. extend).
 *
 * Off-mac a chord's `ctrl` is the same physical key as its `mod`, so either
 * matches `ctrlKey`; a Meta press (the Windows/Super key) never matches. */
export function chordMatchesEvent(
  chord: Chord,
  e: KeyEventLike,
  mac: boolean = isMac(),
): boolean {
  const pressed = chordFromEvent(e, mac);
  if (!pressed) return false;
  if (!mac && chord.ctrl && !chord.mod) {
    return chordsEqual({ ...chord, mod: true, ctrl: false }, pressed);
  }
  return chordsEqual(chord, pressed);
}
