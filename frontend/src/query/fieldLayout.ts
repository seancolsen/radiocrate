// The result-row field layout algorithm, ported verbatim from
// `frontend-old-egui/src/field_layout.rs`.
//
// Given the min/max width of each visible column and the available row width,
// this decides how wide each column is and which line it sits on. There is no
// horizontal scrolling: when columns can't all fit on one line at their minimum
// widths, they wrap onto additional lines, spread as evenly as possible. The
// function is pure (no DOM, no I/O) so it can be unit-tested and memoized by the
// caller.

/** The width bounds of one visible column. */
export interface ColSize {
  min: number;
  max: number;
}

/** Where one column lands: its line index and its horizontal extent within the
 * content area (x offset from the left padding, and width). */
export interface Placement {
  line: number;
  x: number;
  width: number;
}

/** The computed layout: one {@link Placement} per input column (same order), plus
 * the total number of lines used. */
export interface FieldLayout {
  placements: Placement[];
  lineCount: number;
}

/** Computes the field layout for `cols` (the visible columns, in order) given
 * `avail` content width and `gap` horizontal spacing between adjacent columns on
 * a line. */
export function computeFieldLayout(
  cols: readonly ColSize[],
  avail: number,
  gap: number,
): FieldLayout {
  if (cols.length === 0) {
    return { placements: [], lineCount: 0 };
  }

  const lineCount = minLineCount(cols, avail, gap);
  const bounds = balancedPartition(cols, gap, lineCount);

  const placements: Placement[] = cols.map(() => ({ line: 0, x: 0, width: 0 }));
  for (let lineIdx = 0; lineIdx < bounds.length; lineIdx++) {
    const [start, end] = bounds[lineIdx];
    const line = cols.slice(start, end);
    const widths = distributeWidths(line, avail, gap);
    let x = 0;
    for (let offset = 0; offset < widths.length; offset++) {
      const width = widths[offset];
      placements[start + offset] = { line: lineIdx, x, width };
      x += width + gap;
    }
  }

  return { placements, lineCount: bounds.length };
}

/** The cache key for a memoized {@link FieldLayout}: the visible columns' rounded
 * bounds and the rounded available width and gap. Layout only needs to be
 * recomputed when this changes, which is roughly once per frame while the window
 * is being resized. Mirrors `LayoutKey`. */
export function layoutKey(
  cols: readonly ColSize[],
  avail: number,
  gap: number,
): string {
  const parts = cols.map((c) => `${Math.round(c.min)},${Math.round(c.max)}`);
  return `${parts.join(";")}|${Math.max(0, Math.round(avail))}|${Math.max(
    0,
    Math.round(gap),
  )}`;
}

/** A closure-backed memoizer for {@link computeFieldLayout}: recomputes only when
 * the rounded {@link layoutKey} changes, so window resize and query refresh don't
 * thrash the layout (per the plan, resize must not recompute needlessly). */
export function createLayoutMemo(): (
  cols: readonly ColSize[],
  avail: number,
  gap: number,
) => FieldLayout {
  let cache: { key: string; layout: FieldLayout } | undefined;
  return (cols, avail, gap) => {
    const key = layoutKey(cols, avail, gap);
    if (cache && cache.key === key) return cache.layout;
    const layout = computeFieldLayout(cols, avail, gap);
    cache = { key, layout };
    return layout;
  };
}

/** The fewest lines needed to lay the columns out at their minimum widths, found
 * by greedy next-fit: keep adding columns to the current line until the next one
 * wouldn't fit, then wrap. A single column wider than `avail` takes its own line
 * and overflows. */
function minLineCount(
  cols: readonly ColSize[],
  avail: number,
  gap: number,
): number {
  let lines = 1;
  let used = 0;
  for (let i = 0; i < cols.length; i++) {
    const col = cols[i];
    const added = i === 0 || used === 0 ? col.min : used + gap + col.min;
    if (used > 0 && added > avail) {
      lines += 1;
      used = col.min;
    } else {
      used = added;
    }
  }
  return lines;
}

/** Partitions the columns into exactly `lineCount` contiguous groups, minimizing
 * the largest per-line load (sum of mins plus inter-column gaps). This spreads
 * the columns across the available lines rather than cramming the early ones.
 * Returns each line's `[start, end)` range over `cols`. */
function balancedPartition(
  cols: readonly ColSize[],
  gap: number,
  lineCount: number,
): [number, number][] {
  if (lineCount <= 1) {
    return [[0, cols.length]];
  }

  // Binary-search the smallest "max load" for which the columns fit in <=
  // lineCount contiguous groups, then materialize a partition at that threshold.
  const totalMin = cols.reduce((acc, c) => acc + c.min, 0);
  const totalGap = gap * Math.max(0, cols.length - 1);
  const singleMax = cols.reduce((acc, c) => Math.max(acc, c.min), 0);
  let lo = Math.max(singleMax, (totalMin + totalGap) / lineCount);
  let hi = totalMin + totalGap;
  // 30 iterations resolves px-scale widths far below sub-pixel precision.
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (linesNeeded(cols, gap, mid) <= lineCount) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return materializePartition(cols, gap, hi, lineCount);
}

/** Greedy count of how many contiguous lines are needed if no line's load (mins +
 * gaps) may exceed `limit`. */
function linesNeeded(
  cols: readonly ColSize[],
  gap: number,
  limit: number,
): number {
  let lines = 1;
  let used = 0;
  for (const col of cols) {
    const added = used === 0 ? col.min : used + gap + col.min;
    if (used > 0 && added > limit) {
      lines += 1;
      used = col.min;
    } else {
      used = added;
    }
  }
  return lines;
}

/** Builds the actual line ranges for a given load `limit`, greedily filling each
 * line. `lineCount` caps the number of lines: once on the last line, remaining
 * columns go there regardless of `limit`, so the partition always covers every
 * column. */
function materializePartition(
  cols: readonly ColSize[],
  gap: number,
  limit: number,
  lineCount: number,
): [number, number][] {
  const bounds: [number, number][] = [];
  let start = 0;
  let used = 0;
  for (let i = 0; i < cols.length; i++) {
    const col = cols[i];
    const onLastLine = bounds.length === lineCount - 1;
    const added = used === 0 ? col.min : used + gap + col.min;
    if (used > 0 && added > limit && !onLastLine) {
      bounds.push([start, i]);
      start = i;
      used = col.min;
    } else {
      used = added;
    }
  }
  bounds.push([start, cols.length]);
  return bounds;
}

/** Distributes `avail` width across one line's columns. With slack beyond the
 * columns' max widths, each gets its max plus a share of the surplus proportional
 * to its max. Between the sum of mins and sum of maxes, columns shrink from max
 * toward min proportional to their flex room. Below the sum of mins, each takes
 * its min (and the line overflows — text will clip). */
function distributeWidths(
  line: readonly ColSize[],
  avail: number,
  gap: number,
): number[] {
  const count = line.length;
  const content = avail - gap * Math.max(0, count - 1);
  const sumMin = line.reduce((acc, c) => acc + c.min, 0);
  const sumMax = line.reduce((acc, c) => acc + c.max, 0);

  if (content >= sumMax) {
    const surplus = content - sumMax;
    if (sumMax > 0) {
      return line.map((c) => c.max + surplus * (c.max / sumMax));
    }
    // All columns have zero max: split the whole width equally.
    return line.map(() => content / count);
  } else if (content >= sumMin) {
    const deficit = sumMax - content;
    const flex = sumMax - sumMin;
    if (flex > 0) {
      return line.map((c) => c.max - deficit * ((c.max - c.min) / flex));
    }
    // No flex room (every column is fixed); fall back to equal widths.
    return line.map(() => content / count);
  }
  return line.map((c) => c.min);
}
