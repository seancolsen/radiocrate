// A playlist's definition, and the Querydown that lists its entries.
//
// A playlist stores the same filter / sort / display sections a query does, but
// with no base table (the base is always `track`) and no full-Querydown mode. Its
// rows come from `playlist_track`, so the sections can't be compiled as they are
// for a query: every section is scoped to each entry's related track instead
// (`track{…}`, `\\track.(…)`, `$track.(…)`), which is what lets the presets
// written for `track` apply unchanged. See "The playlist query" in
// `specs/2026-10-playlists/specs.md`. Pure string manipulation, like
// `definition.ts`: no compiler, no schema.

import type { Preset } from "api-client";
import {
  canonicalSection,
  playlistOrderContent,
  resolveFilter,
  resolveSection,
  type FilterParts,
  type QueryDefinition,
  type SectionContent,
} from "./definition";

/** The table every playlist's sections are written against. */
export const PLAYLIST_BASE = "track";

/** A playlist's three sections. `sort` holds "Playlist order" (see
 * {@link playlistOrderContent}) when no sorting conditions apply. */
export interface PlaylistDefinition {
  filter: FilterParts;
  sort: SectionContent;
  display: SectionContent;
}

/** The display a new playlist starts with: the first default `track` display
 * preset, as a new query of tracks gets (`definitionForBase`), or an empty
 * custom display when there's none. */
function defaultDisplay(presets: readonly Preset[]): SectionContent {
  const preset = presets.find(
    (p) =>
      p.isDefault &&
      p.section === "display" &&
      p.baseTable.trim().toLowerCase() === PLAYLIST_BASE,
  );
  return preset ? { preset: preset.id } : { custom: "" };
}

/** A new playlist's definition: no filter conditions (not even the `track`
 * filter presets marked as defaults), "Playlist order", and the default `track`
 * display. */
export function newPlaylistDefinition(
  presets: readonly Preset[],
): PlaylistDefinition {
  return {
    filter: { custom: "", presets: [] },
    sort: playlistOrderContent(),
    display: defaultDisplay(presets),
  };
}

/** The definition of a playlist converted from a query. Its filter and sort are
 * baked into the converted track list, so neither carries over. The display
 * does when it was written against `track`. A full-mode query has no display
 * section of its own to copy, so it gets the default display too. */
export function playlistDefinitionFromQuery(
  def: QueryDefinition,
  presets: readonly Preset[],
): PlaylistDefinition {
  const next = newPlaylistDefinition(presets);
  if (def.full == null && def.base.trim().toLowerCase() === PLAYLIST_BASE) {
    next.display = structuredClone(def.display);
  }
  return next;
}

/** Serializes a definition into the JSON stored in `playlist.definition`, in a
 * canonical key order, so that two equal definitions serialize identically. */
export function playlistDefinitionToStored(def: PlaylistDefinition): string {
  return JSON.stringify({
    filter: { custom: def.filter.custom, presets: [...def.filter.presets] },
    sort: canonicalSection(def.sort),
    display: canonicalSection(def.display),
  });
}

/** Parses a stored `playlist.definition`, filling whatever is missing from a
 * fresh "Playlist order" definition with an empty display, as
 * `definitionFromStored` does for a query. A blank or unparseable string yields
 * that empty definition. */
export function playlistDefinitionFromStored(raw: string): PlaylistDefinition {
  let parsed: Partial<PlaylistDefinition> | null = null;
  try {
    parsed = JSON.parse(raw) as Partial<PlaylistDefinition> | null;
  } catch {
    // Falls through to the empty definition.
  }
  return {
    filter: {
      custom: parsed?.filter?.custom ?? "",
      presets: parsed?.filter?.presets ?? [],
    },
    sort: parsed?.sort ?? playlistOrderContent(),
    display: parsed?.display ?? { custom: "" },
  };
}

/** Whether two playlist definitions are structurally equal. */
export function playlistDefsEqual(
  a: PlaylistDefinition,
  b: PlaylistDefinition,
): boolean {
  return playlistDefinitionToStored(a) === playlistDefinitionToStored(b);
}

/** A playlist definition's sections resolved to Querydown fragments. */
export interface PlaylistParts {
  filter: string;
  sort: string;
  display: string;
}

/** Resolves a definition's sections, as `assemble` does for a sectioned query.
 * Throws on a dangling preset reference. */
export function assemblePlaylist(
  def: PlaylistDefinition,
  presets: readonly Preset[],
): PlaylistParts {
  return {
    filter: resolveFilter(def.filter, presets),
    sort: resolveSection(def.sort, presets),
    display: resolveSection(def.display, presets),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Querydown listing playlist `playlistId`'s entries, from the spec's
 * template: the user's filter scoped to each entry's track (left out entirely
 * when empty, since Querydown rejects an empty `{}`), the user's sort ahead of
 * the stored order (with the track's id breaking ties between equal
 * positions), the hidden `$id` and `$position` that identify each row's entry
 * (always output columns 0 and 1), and then the user's display. Without the
 * prelude, which the compiler's caller prepends.
 *
 * `withFilter: false` leaves the filter out, for committing a sort: every entry
 * is reordered, hidden or not. */
export function playlistQuerydown(
  playlistId: string,
  parts: PlaylistParts,
  options: { withFilter?: boolean } = {},
): string {
  // The id is spliced into a string literal, so it had better be one.
  if (!UUID.test(playlistId)) {
    throw new Error(`Not a playlist id: ${JSON.stringify(playlistId)}`);
  }
  const lines = ["#playlist_track", "", `playlist:="${playlistId}"`, ""];
  if (options.withFilter !== false && parts.filter.trim() !== "") {
    lines.push("track{", parts.filter.trim(), "}", "");
  }
  lines.push(
    "\\\\track.(",
    parts.sort.trim(),
    ")",
    "\\\\position",
    "\\\\track.id",
    "",
    "$id @{hide:yes}",
    "$position @{hide:yes}",
    "$track.(",
    parts.display.trim(),
    ")",
  );
  return lines.join("\n");
}
