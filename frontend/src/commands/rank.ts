// The command palette's ranking, ported from
// `frontend-old-egui/src/palette.rs` (`rank_commands` / `is_subsequence`).

import type { CommandDef, CommandId } from "./registry";

/** Ranks `available` commands for `query`. With an empty query, recently-used
 * commands come first (in MRU order), then the rest in registry order.
 * Otherwise substring title matches rank above subsequence matches, ties broken
 * by registry order, and non-matches are dropped. */
export function rankCommands(
  query: string,
  available: readonly CommandDef[],
  mru: readonly CommandId[],
): CommandDef[] {
  const q = query.trim().toLowerCase();
  if (q === "") {
    const out: CommandDef[] = [];
    for (const id of mru) {
      const def = available.find((c) => c.id === id);
      if (def && !out.includes(def)) out.push(def);
    }
    for (const def of available) if (!out.includes(def)) out.push(def);
    return out;
  }

  const scored: { score: number; index: number; def: CommandDef }[] = [];
  available.forEach((def, index) => {
    const title = def.title.toLowerCase();
    if (title.includes(q)) scored.push({ score: 0, index, def });
    else if (isSubsequence(q, title)) scored.push({ score: 1, index, def });
  });
  scored.sort((a, b) => a.score - b.score || a.index - b.index);
  return scored.map((s) => s.def);
}

/** Whether every non-space character of `needle` appears in `haystack` in
 * order. */
export function isSubsequence(needle: string, haystack: string): boolean {
  let h = 0;
  for (const nc of needle) {
    if (nc === " ") continue;
    while (h < haystack.length && haystack[h] !== nc) h++;
    if (h >= haystack.length) return false;
    h++;
  }
  return true;
}
