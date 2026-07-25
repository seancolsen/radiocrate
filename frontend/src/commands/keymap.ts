// The resolved keymap: user overrides layered over the built-in defaults.
// Ported from `frontend-old-egui/src/commands.rs` (`Keymap`), but as pure
// functions over an immutable overrides map rather than a mutating struct — the
// provider holds it in a signal and replaces it wholesale, so every read is
// reactive.

import { chordsEqual, parseChord, type Chord } from "./chord";
import {
  ALL_COMMANDS,
  commandDef,
  commandDefById,
  type CommandId,
} from "./registry";

/** User overrides. A `Chord` rebinds; `null` explicitly unbinds; a command
 * absent from the map uses its built-in default. */
export type Overrides = Partial<Record<CommandId, Chord | null>>;

/** The effective chord for a command: its override if present, else its
 * default. `null` means unbound. */
export function bindingFor(overrides: Overrides, id: CommandId): Chord | null {
  const over = overrides[id];
  return over !== undefined ? over : commandDef(id).defaultChord;
}

/** Whether the command's binding differs from its built-in default. */
export function isOverridden(overrides: Overrides, id: CommandId): boolean {
  return id in overrides;
}

/** The active bindings in registry order. Chords are unique (assignment steals
 * conflicts), so a first match is unambiguous. */
export function resolveBindings(
  overrides: Overrides,
): { chord: Chord; command: CommandId }[] {
  const out: { chord: Chord; command: CommandId }[] = [];
  for (const def of ALL_COMMANDS) {
    const chord = bindingFor(overrides, def.id);
    if (chord) out.push({ chord, command: def.id });
  }
  return out;
}

/** The command currently bound to `chord`, if any. */
export function commandForChord(
  overrides: Overrides,
  chord: Chord,
): CommandId | null {
  for (const def of ALL_COMMANDS) {
    const bound = bindingFor(overrides, def.id);
    if (bound && chordsEqual(bound, chord)) return def.id;
  }
  return null;
}

/** The overrides map with `id` rebound. Setting a command's *default* chord
 * clears its override instead (so it reverts to — and is persisted as — the
 * default), mirroring `Keymap::set_override`. */
export function withOverride(
  overrides: Overrides,
  id: CommandId,
  chord: Chord | null,
): Overrides {
  const next: Overrides = { ...overrides };
  const def = commandDef(id).defaultChord;
  const isDefault =
    chord === null ? def === null : def !== null && chordsEqual(chord, def);
  if (isDefault) delete next[id];
  else next[id] = chord;
  return next;
}

/** Builds the overrides map from persisted `keybinding.list` rows. Unknown ids
 * (an omitted or newer command) and unparseable chords are skipped, leaving
 * those commands on their defaults rather than dropping the stored row. */
export function overridesFromEntries(
  entries: readonly { commandId: string; chord: string | null }[],
): Overrides {
  const out: Overrides = {};
  for (const entry of entries) {
    const def = commandDefById(entry.commandId);
    if (!def) continue;
    if (entry.chord === null) {
      out[def.id] = null;
      continue;
    }
    const chord = parseChord(entry.chord);
    if (chord) out[def.id] = chord;
  }
  return out;
}
