// Which items of the record editor's tree the user has left expanded, kept
// across forms and across visits. A form holds its own expansion in state
// (`FormState.expanded`) and is the authority on what it shows; this is only
// what a *new* form opens with.
//
// An item is remembered by its path from the root — its id, which encodes exactly
// that (`record/formIds.ts`) — under the table of the form's root record. So the
// first credit of a track is the same item on every track, and the same `artist`
// field reached from a form on credits is a different one.

import type { AppEnv } from "../env";

const STORAGE_KEY = "recordExpansion";

export interface ExpansionMemory {
  /** Whether the user left this item expanded, in a form rooted on `table`. */
  has: (table: string, itemId: string) => boolean;
  set: (table: string, itemId: string, open: boolean) => void;
  /** Forgets every item of forms rooted on `table`. */
  clear: (table: string) => void;
}

/** The paths as a previous visit left them. Anything unreadable restores
 * nothing — every item starts collapsed. */
function stored(env: Pick<AppEnv, "storage">): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  try {
    const raw = env.storage.getItem(STORAGE_KEY);
    const record: unknown = raw ? JSON.parse(raw) : null;
    if (typeof record !== "object" || record === null) return tables;
    for (const [table, ids] of Object.entries(record)) {
      if (!Array.isArray(ids)) continue;
      tables.set(
        table,
        new Set(ids.filter((id): id is string => typeof id === "string")),
      );
    }
  } catch {
    // Private-mode denial, or a value that isn't JSON.
  }
  return tables;
}

/** Reads storage once, then writes through on every change. One is shared by
 * every form, so what one form opens is there for the next. */
export function createExpansionMemory(
  env: Pick<AppEnv, "storage">,
): ExpansionMemory {
  const tables = stored(env);

  const persist = () => {
    try {
      if (tables.size === 0) {
        env.storage.removeItem(STORAGE_KEY);
        return;
      }
      const record = Object.fromEntries(
        [...tables].map(([table, ids]) => [table, [...ids]]),
      );
      env.storage.setItem(STORAGE_KEY, JSON.stringify(record));
    } catch {
      // Denied or over quota — the items just start collapsed next time.
    }
  };

  return {
    has: (table, itemId) => tables.get(table)?.has(itemId) === true,
    set: (table, itemId, open) => {
      const ids = tables.get(table) ?? new Set<string>();
      if (ids.has(itemId) === open) return;
      if (open) ids.add(itemId);
      else ids.delete(itemId);
      if (ids.size === 0) tables.delete(table);
      else tables.set(table, ids);
      persist();
    },
    clear: (table) => {
      if (tables.delete(table)) persist();
    },
  };
}
