// How the preset manager lists presets: by table, then by section, then by
// name. Pure, like the rest of `query/`.

import type { Preset } from "api-client";
import { asSection, SECTIONS, type Section } from "./definition";

/** One section's presets on one table, in name order. */
export interface PresetSectionGroup {
  section: Section;
  presets: Preset[];
}

/** One table's presets: all three sections, each in {@link SECTIONS} order,
 * whether or not it holds any. */
export interface PresetTableGroup {
  table: string;
  sections: PresetSectionGroup[];
}

const byName = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: "base" });

/** `presets` grouped by table (in name order), then section, then name —
 * narrowed to those whose name or table contains `search` (ignoring case). A
 * table with no presets left after the search isn't listed. */
export function groupPresets(
  presets: readonly Preset[],
  search: string,
): PresetTableGroup[] {
  const needle = search.trim().toLowerCase();
  const matches = (p: Preset) =>
    needle === "" ||
    p.name.toLowerCase().includes(needle) ||
    p.baseTable.toLowerCase().includes(needle);

  const byTable = new Map<string, Preset[]>();
  for (const preset of presets) {
    if (!matches(preset)) continue;
    const list = byTable.get(preset.baseTable);
    if (list) list.push(preset);
    else byTable.set(preset.baseTable, [preset]);
  }
  return [...byTable.keys()].sort(byName).map((table) => {
    const list = byTable.get(table) ?? [];
    return {
      table,
      sections: SECTIONS.map((section) => ({
        section,
        presets: list
          .filter((p) => asSection(p.section) === section)
          .sort((a, b) => byName(a.name, b.name)),
      })),
    };
  });
}
