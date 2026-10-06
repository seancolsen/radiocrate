// The resolved keymap: user overrides layered over the built-in defaults, as
// pure functions over an immutable overrides map, which the command store holds
// and replaces wholesale on every change.

import { chordsEqual, parseChord, type Chord } from "./chord";
import {
  ALL_COMMANDS,
  commandDef,
  commandDefById,
  whenSatisfied,
  whensOverlap,
  type CommandContext,
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

/** The command that `chord` runs in context `ctx`: the first, in registry
 * order, that's bound to it and whose `when` holds. A chord can belong to
 * several commands whose contexts never overlap (see {@link conflictsFor}), so
 * which one it runs depends on the context. `null` when none applies. */
export function commandForChord(
  overrides: Overrides,
  chord: Chord,
  ctx: CommandContext,
): CommandId | null {
  for (const def of ALL_COMMANDS) {
    const bound = bindingFor(overrides, def.id);
    if (!bound || !chordsEqual(bound, chord)) continue;
    if (whenSatisfied(def.when, ctx)) return def.id;
  }
  return null;
}

/** The commands that binding `chord` to `id` would take it from: those bound
 * to it whose contexts can overlap `id`'s, so that one keypress would have two
 * commands to choose between. Commands whose contexts can't overlap share a
 * chord instead (as `Delete` is both the record form's and a playlist's
 * results'), which is also why there can be more than one. Empty when nothing
 * conflicts. */
export function conflictsFor(
  overrides: Overrides,
  id: CommandId,
  chord: Chord,
): CommandId[] {
  const when = commandDef(id).when;
  return ALL_COMMANDS.filter((def) => {
    if (def.id === id || !whensOverlap(def.when, when)) return false;
    const bound = bindingFor(overrides, def.id);
    return bound !== null && chordsEqual(bound, chord);
  }).map((def) => def.id);
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
