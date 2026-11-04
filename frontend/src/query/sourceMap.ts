// Querydown text that remembers where each stretch of it came from.
//
// The text the compiler sees is stitched together from several places — the
// prelude, a custom filter, each of the filter's presets, the scaffolding a
// playlist wraps around its sections — so a position the compiler reports is a
// position in the stitched text, not in anything the user typed. A `Mapped`
// carries, beside the text, which of its stretches came from which editor, so
// such a position can be traced back to the editor and the offset within its
// text. Text the app generates itself (a playlist's scaffolding, a built-in
// preset) is left unmapped.

import type { Section } from "./definition";

/** An editor Querydown text comes from. */
export type SourceOrigin =
  /** A builder section's own hand-written text. */
  | { kind: "custom"; section: Section }
  /** A preset's definition, as used in `section`. */
  | { kind: "preset"; id: string; section: Section }
  /** The `querydown_prelude` setting. */
  | { kind: "prelude" }
  /** A full-Querydown query's text. */
  | { kind: "full" };

/** One stretch of a {@link Mapped}'s text, copied out of `source`, the whole
 * text of the editor `origin` names: `text.slice(start, end)` is
 * `source.slice(sourceStart, sourceStart + (end - start))`. */
export interface Segment {
  start: number;
  end: number;
  origin: SourceOrigin;
  source: string;
  sourceStart: number;
}

/** Querydown text, with the stretches of it that came from an editor. Segments
 * are in text order and never overlap. */
export interface Mapped {
  text: string;
  segments: readonly Segment[];
}

/** Text the app generated, traced to no editor. */
export function unmapped(text: string): Mapped {
  return { text, segments: [] };
}

/** The whole of an editor's text, as typed. */
export function fromSource(source: string, origin: SourceOrigin): Mapped {
  return {
    text: source,
    segments:
      source === ""
        ? []
        : [{ start: 0, end: source.length, origin, source, sourceStart: 0 }],
  };
}

/** `m` with its surrounding whitespace trimmed, as `String.prototype.trim`
 * does, its segments following the text they cover. */
export function trimMapped(m: Mapped): Mapped {
  const text = m.text.trim();
  if (text === m.text) return m;
  const lead = m.text.length - m.text.trimStart().length;
  const end = lead + text.length;
  const segments: Segment[] = [];
  for (const seg of m.segments) {
    const from = Math.max(seg.start, lead);
    const to = Math.min(seg.end, end);
    if (from >= to) continue;
    segments.push({
      ...seg,
      start: from - lead,
      end: to - lead,
      sourceStart: seg.sourceStart + (from - seg.start),
    });
  }
  return { text, segments };
}

/** `parts` joined with `separator` between them, as `Array.prototype.join`
 * does. A plain string is generated text. */
export function joinMapped(
  parts: readonly (Mapped | string)[],
  separator: string,
): Mapped {
  let text = "";
  const segments: Segment[] = [];
  parts.forEach((part, i) => {
    if (i > 0) text += separator;
    const m = typeof part === "string" ? unmapped(part) : part;
    for (const seg of m.segments) {
      segments.push({
        ...seg,
        start: seg.start + text.length,
        end: seg.end + text.length,
      });
    }
    text += m.text;
  });
  return { text, segments };
}

/** A position in an editor's text. */
export interface SourcePoint {
  segment: Segment;
  /** Within `segment.source`. */
  offset: number;
}

/** Where position `offset` of `m.text` came from.
 *
 * A position inside a segment maps into it, and so does the position just
 * past one's end (where "unexpected end of input" points). A position in
 * generated text between segments is put down to the end of the segment
 * before it: the parser complaining about scaffolding the app wrote (a
 * playlist's closing `}`) is complaining about something left open in the
 * text that came before. A position before every segment came from nowhere
 * the user can edit. */
export function locate(m: Mapped, offset: number): SourcePoint | undefined {
  const at = (segment: Segment, pos: number): SourcePoint => ({
    segment,
    offset: segment.sourceStart + (pos - segment.start),
  });
  const inside = m.segments.find((s) => s.start <= offset && offset < s.end);
  if (inside) return at(inside, offset);
  let before: Segment | undefined;
  for (const seg of m.segments) {
    if (seg.end <= offset) before = seg;
  }
  return before ? at(before, before.end) : undefined;
}

/** The position `offset` of `m.text` maps to within `segment`, clamped to the
 * segment — for the far end of a span that starts there. */
export function locateWithin(segment: Segment, offset: number): number {
  const pos = Math.min(Math.max(offset, segment.start), segment.end);
  return segment.sourceStart + (pos - segment.start);
}

/** Whether two origins name the same editor. */
export function sameOrigin(
  a: SourceOrigin | null,
  b: SourceOrigin | null,
): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "custom" && b.kind === "custom")
    return a.section === b.section;
  if (a.kind === "preset" && b.kind === "preset") {
    return a.id === b.id && a.section === b.section;
  }
  return true;
}
