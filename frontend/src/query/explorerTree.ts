import type { Placement, Query, QueryFolder, TreeItemKind } from "api-client";

// The explorer's tree of saved queries: how the flat `query.list` /
// `folder.list` rows assemble into folders, how that tree flattens into the
// rows on screen (expanded folders and the filter applied), where a drag over
// those rows would drop, and what a drop — or deleting a folder — rewrites.
//
// Every item sits in a `parent` folder (null at the top level) at a `position`
// among its siblings; folders and queries share that one order. Positions only
// order siblings — a move renumbers the list it lands in from zero, and only
// the items whose place actually changed are written back.

/** Names one item of the tree. */
export interface TreeItemRef {
  kind: TreeItemKind;
  id: string;
}

export type TreeNode =
  | { kind: "folder"; id: string; name: string; children: TreeNode[] }
  | { kind: "query"; id: string; name: string; query: Query };

/** One row of the tree as drawn: a node, how deep it sits, and — for a folder
 * — whether its children are drawn beneath it. */
export interface TreeRow {
  node: TreeNode;
  depth: number;
  parent: string | null;
  expanded: boolean;
}

/** Where a drag over the rows would put the dragged item: *into* a folder (at
 * the end of its children), or *between* two rows at a given nesting `depth` —
 * into `parent`, just after its child `after` (null: first). `gap` is the index
 * of the row the line is drawn above (`rows.length`: below the last). */
export type DropTarget =
  | { kind: "into"; folder: string }
  | {
      kind: "between";
      parent: string | null;
      after: string | null;
      depth: number;
      gap: number;
    };

interface Positioned {
  id: string;
  name: string;
  parent: string | null;
  position: number;
}

function bySiblingOrder(a: Positioned, b: Positioned): number {
  return a.position - b.position || a.name.localeCompare(b.name);
}

/** Assembles the tree. An item whose parent names no folder — deleted, or never
 * there — sits at the top level, as does a folder caught in a parent cycle, so
 * nothing the lists hold ever goes missing from the tree. */
export function buildTree(
  queries: readonly Query[],
  folders: readonly QueryFolder[],
): TreeNode[] {
  const folderIds = new Set(folders.map((f) => f.id));
  const items: { node: Positioned; make: () => TreeNode }[] = [];
  const children = new Map<string | null, typeof items>();
  const add = (node: Positioned, make: () => TreeNode) => {
    const parent =
      node.parent !== null && folderIds.has(node.parent) ? node.parent : null;
    const entry = { node, make };
    items.push(entry);
    children.set(parent, [...(children.get(parent) ?? []), entry]);
  };

  const placed = new Set<string>();
  const assemble = (parent: string | null): TreeNode[] =>
    (children.get(parent) ?? [])
      .filter((e) => !placed.has(e.node.id))
      .sort((a, b) => bySiblingOrder(a.node, b.node))
      .map((e) => {
        placed.add(e.node.id);
        return e.make();
      });

  for (const f of folders) {
    add(f, () => ({
      kind: "folder",
      id: f.id,
      name: f.name,
      children: assemble(f.id),
    }));
  }
  for (const q of queries) {
    add(q, () => ({
      kind: "query",
      id: q.id,
      name: q.name,
      query: q,
    }));
  }

  const roots = assemble(null);
  // Whatever a walk from the top level never reached hangs off a folder cycle;
  // lift each such folder to the top level (its contents come along).
  for (const e of items) {
    if (!placed.has(e.node.id)) {
      placed.add(e.node.id);
      roots.push(e.make());
    }
  }
  return roots;
}

/** The rows on screen. With no filter, a folder's children show when it's in
 * `expanded`. A filter shows every item whose name contains it (case-folded),
 * the folders on the way down to each, and everything inside a folder whose own
 * name matches — with every folder expanded. */
export function visibleRows(
  tree: readonly TreeNode[],
  expanded: ReadonlySet<string>,
  filter: string,
): TreeRow[] {
  const needle = filter.trim().toLowerCase();
  const matches = (node: TreeNode) =>
    needle !== "" && node.name.toLowerCase().includes(needle);

  const walk = (
    nodes: readonly TreeNode[],
    depth: number,
    parent: string | null,
    shown: boolean,
  ): TreeRow[] =>
    nodes.flatMap((node) => {
      const self = shown || matches(node);
      if (node.kind === "query") {
        return self ? [{ node, depth, parent, expanded: false }] : [];
      }
      if (needle === "") {
        const open = expanded.has(node.id);
        const row = { node, depth, parent, expanded: open };
        return open
          ? [row, ...walk(node.children, depth + 1, node.id, true)]
          : [row];
      }
      const inner = walk(node.children, depth + 1, node.id, self);
      return self || inner.length > 0
        ? [{ node, depth, parent, expanded: true }, ...inner]
        : [];
    });

  return walk(tree, 0, null, needle === "");
}

/** The ids of `item` and — for a folder — everything inside it: the places a
 * dragged item can't be dropped into. */
export function subtreeIds(
  tree: readonly TreeNode[],
  item: TreeItemRef,
): Set<string> {
  const ids = new Set<string>();
  const collect = (node: TreeNode) => {
    ids.add(node.id);
    if (node.kind === "folder") node.children.forEach(collect);
  };
  const find = (nodes: readonly TreeNode[]): boolean =>
    nodes.some((n) => {
      if (same(n, item)) {
        collect(n);
        return true;
      }
      return n.kind === "folder" && find(n.children);
    });
  find(tree);
  return ids;
}

/** The nesting depths a line in gap `gap` (above `rows[gap]`) can stand for:
 * from the depth of the row below it, out to one level inside the row above it
 * when that's an expanded folder — which is what tells "last child of this
 * folder" from "the folder's next sibling". */
export function gapDepths(
  rows: readonly TreeRow[],
  gap: number,
): { min: number; max: number } {
  const prev = rows[gap - 1];
  const next = rows[gap];
  const max = prev
    ? prev.depth + (prev.node.kind === "folder" && prev.expanded ? 1 : 0)
    : 0;
  return { min: Math.min(next?.depth ?? 0, max), max };
}

/** The drop a line in gap `gap` stands for at (clamped) nesting `depth`, or
 * null when that would put the dragged item inside itself. `blocked` is the
 * dragged item's {@link subtreeIds}. */
export function dropBetween(
  rows: readonly TreeRow[],
  gap: number,
  depth: number,
  blocked: ReadonlySet<string>,
): DropTarget | null {
  const { min, max } = gapDepths(rows, gap);
  const d = Math.max(min, Math.min(depth, max));
  let parent: string | null = null;
  let after: string | null = null;
  let foundAfter = false;
  for (let i = gap - 1; i >= 0; i--) {
    const row = rows[i];
    if (!foundAfter && row.depth === d) {
      after = row.node.id;
      foundAfter = true;
    }
    if (row.depth === d - 1) {
      parent = row.node.id;
      break;
    }
    if (row.depth < d) break;
  }
  if (parent !== null && blocked.has(parent)) return null;
  return { kind: "between", parent, after, depth: d, gap };
}

/** A drop onto folder `folder`, or null when it's the dragged item or inside
 * it. */
export function dropInto(
  folder: string,
  blocked: ReadonlySet<string>,
): DropTarget | null {
  return blocked.has(folder) ? null : { kind: "into", folder };
}

function findFolder(
  nodes: readonly TreeNode[],
  id: string,
): Extract<TreeNode, { kind: "folder" }> | undefined {
  for (const n of nodes) {
    if (n.kind !== "folder") continue;
    if (n.id === id) return n;
    const found = findFolder(n.children, id);
    if (found) return found;
  }
  return undefined;
}

/** The children of `parent` (null: the top level). */
function childrenOf(
  tree: readonly TreeNode[],
  parent: string | null,
): readonly TreeNode[] {
  return parent === null ? tree : (findFolder(tree, parent)?.children ?? []);
}

/** The folder holding `item` (null: the top level), or undefined when the tree
 * doesn't hold it. */
function parentOf(
  tree: readonly TreeNode[],
  item: TreeItemRef,
  parent: string | null = null,
): string | null | undefined {
  for (const n of tree) {
    if (same(n, item)) return parent;
    if (n.kind === "folder") {
      const found = parentOf(n.children, item, n.id);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function same(n: TreeNode, item: TreeItemRef): boolean {
  return n.kind === item.kind && n.id === item.id;
}

const keyOf = (n: TreeItemRef) => `${n.kind}:${n.id}`;

/** Placements numbering `list` from zero under `parent`, for the entries whose
 * stored position that changes — and for each of `moved`, whose parent
 * changes too. `positions` is {@link storedPositions}. */
function renumber(
  list: readonly TreeNode[],
  parent: string | null,
  positions: ReadonlyMap<string, number>,
  moved: ReadonlySet<string> = new Set(),
): Placement[] {
  return list.flatMap((node, position) =>
    moved.has(keyOf(node)) || positions.get(keyOf(node)) !== position
      ? [{ kind: node.kind, id: node.id, parent, position }]
      : [],
  );
}

/** Every item's stored position, keyed `kind:id`. */
export function storedPositions(
  queries: readonly Query[],
  folders: readonly QueryFolder[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of folders)
    out.set(keyOf({ kind: "folder", id: f.id }), f.position);
  for (const q of queries)
    out.set(keyOf({ kind: "query", id: q.id }), q.position);
  return out;
}

/** What moving `item` to `target` rewrites: the placements for every item whose
 * parent or position changes. Empty when the drop leaves everything where it
 * was. `positions` is {@link storedPositions}. */
export function movePlacements(
  tree: readonly TreeNode[],
  positions: ReadonlyMap<string, number>,
  item: TreeItemRef,
  target: DropTarget,
): Placement[] {
  const from = parentOf(tree, item);
  if (from === undefined) return [];
  const node = childrenOf(tree, from).find((n) => same(n, item));
  if (!node) return [];
  const to = target.kind === "into" ? target.folder : target.parent;
  if (to !== null && subtreeIds(tree, item).has(to)) return [];

  const source = childrenOf(tree, from).filter((n) => !same(n, item));
  const dest = from === to ? source : [...childrenOf(tree, to)];
  let index: number;
  if (target.kind === "into") {
    index = dest.length;
  } else if (target.after === null) {
    index = 0;
  } else {
    const after = dest.findIndex((n) => n.id === target.after);
    // Dropped just after itself: nothing moves.
    if (after === -1) return [];
    index = after + 1;
  }
  const next = [...dest.slice(0, index), node, ...dest.slice(index)];

  if (from === to) {
    const before = childrenOf(tree, from);
    if (next.every((n, i) => before[i] === n)) return [];
    return renumber(next, to, positions);
  }
  // The list it left keeps its order without it, so only the one it joined is
  // renumbered.
  return renumber(next, to, positions, new Set([keyOf(item)]));
}

/** What deleting folder `folder` rewrites first: its children take its place in
 * its parent's list, in their order. */
export function dissolvePlacements(
  tree: readonly TreeNode[],
  positions: ReadonlyMap<string, number>,
  folder: string,
): Placement[] {
  const item: TreeItemRef = { kind: "folder", id: folder };
  const parent = parentOf(tree, item);
  if (parent === undefined) return [];
  const siblings = childrenOf(tree, parent);
  const node = siblings.find((n) => same(n, item));
  if (node?.kind !== "folder") return [];
  const next = siblings.flatMap((n) => (n === node ? node.children : [n]));
  return renumber(next, parent, positions, new Set(node.children.map(keyOf)));
}

/** The position that puts a new item first at the top level: one above the
 * current first item. */
export function topPosition(
  queries: readonly Query[],
  folders: readonly QueryFolder[],
): number {
  const folderIds = new Set(folders.map((f) => f.id));
  const atTop = (p: string | null) => p === null || !folderIds.has(p);
  const positions = [
    ...queries.filter((q) => atTop(q.parent)).map((q) => q.position),
    ...folders.filter((f) => atTop(f.parent)).map((f) => f.position),
  ];
  return positions.length === 0 ? 0 : Math.min(...positions) - 1;
}

/** Applies placements to the lists they came from, returning new lists (the
 * optimistic half of a move — the backend's copy is written alongside). */
export function applyPlacements(
  queries: readonly Query[],
  folders: readonly QueryFolder[],
  placements: readonly Placement[],
): { queries: Query[]; folders: QueryFolder[] } {
  const byKey = new Map(placements.map((p) => [keyOf(p), p]));
  const place = <
    T extends { id: string; parent: string | null; position: number },
  >(
    kind: TreeItemKind,
    x: T,
  ): T => {
    const p = byKey.get(keyOf({ kind, id: x.id }));
    return p ? { ...x, parent: p.parent, position: p.position } : x;
  };
  return {
    queries: queries.map((q) => place("query", q)),
    folders: folders.map((f) => place("folder", f)),
  };
}
