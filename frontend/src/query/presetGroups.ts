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
  /** How many presets the table has, over all its sections. */
  count: number;
  sections: PresetSectionGroup[];
}

const byName = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: "base" });

/** The tables the preset manager lists, in name order: every one of `tables`
 * (the schema's), and any other a preset is for. */
export function presetTables(
  presets: readonly Preset[],
  tables: readonly string[],
): string[] {
  const names = new Set(tables);
  for (const preset of presets) names.add(preset.baseTable);
  return [...names].sort(byName);
}

/** `presets` grouped by table, then section, then name — one group for each of
 * {@link presetTables}, so a table with no presets is listed too. A preset in
 * `listedNames` sorts by that name rather than its own. */
export function groupPresets(
  presets: readonly Preset[],
  tables: readonly string[],
  listedNames: Readonly<Record<string, string>> = {},
): PresetTableGroup[] {
  const listedName = (p: Preset) => listedNames[p.id] ?? p.name;
  const byTable = new Map<string, Preset[]>();
  for (const preset of presets) {
    const list = byTable.get(preset.baseTable);
    if (list) list.push(preset);
    else byTable.set(preset.baseTable, [preset]);
  }
  return presetTables(presets, tables).map((table) => {
    const list = byTable.get(table) ?? [];
    return {
      table,
      count: list.length,
      sections: SECTIONS.map((section) => ({
        section,
        presets: list
          .filter((p) => asSection(p.section) === section)
          .sort((a, b) => byName(listedName(a), listedName(b))),
      })),
    };
  });
}
