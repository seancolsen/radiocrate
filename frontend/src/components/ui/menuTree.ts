import {
  gracePolygon,
  pointInPolygon,
  type Point,
  type Rect,
  type SubmenuSide,
} from "./menuGeometry";

// Which submenus of one menu tree are open, and the pointer rules that open
// and close them. Framework- and DOM-free (the DOM side is `useMenu.ts`), so
// the timing rules are testable with fake timers.
//
// A tree is a chain: the root panel is level 0, and each level has at most
// one open submenu, which is the next level down. So the whole open state is
// one `path` — the open submenus, outermost first — and "level `d` is open"
// means `path` is at least `d` long.
//
// The pointer rules, which are what make hover-driven submenus feel right:
//
// - Hovering a submenu's row opens it after `OPEN_DELAY_MS`, so a pointer
//   sweeping across the menu on its way somewhere else doesn't flash every
//   submenu it passes over.
// - Hovering a different row closes an open submenu only after
//   `CLOSE_DELAY_MS`, so an overshoot or a wobble on the way back doesn't cost
//   the user the submenu. Coming back to the submenu (or its row) inside that
//   window cancels the close.
// - Leaving a submenu's row towards the submenu grants a grace area: while the
//   pointer keeps moving towards the submenu inside the triangle between the
//   exit point and the submenu panel, the parent level ignores it, so cutting
//   diagonally across the parent's other rows neither highlights them, starts
//   closing the submenu, nor opens a sibling's — however slowly the pointer
//   makes the trip. Once it comes to rest inside the triangle for `GRACE_MS`,
//   the grace ends and the last move is handled for real: the user has stopped
//   on that row, not passed over it.
// - A delay never restarts because the pointer keeps moving towards the same
//   outcome, only when the outcome changes — a pointer drifting slowly within
//   one row still opens its submenu on time.
// - Leaving the menus altogether changes nothing: an open submenu stays open
//   (the user may be overshooting), as in native menus. A click outside is
//   what dismisses them.

/** How long the pointer must rest on a submenu's row before it opens. */
export const OPEN_DELAY_MS = 150;
/** How long an open submenu survives the pointer moving to another row. */
export const CLOSE_DELAY_MS = 300;
/** How long the pointer may pause on its way from a submenu's row into the
 * submenu before it counts as resting where it paused. */
export const GRACE_MS = 300;

/** One open submenu: which one (the `MenuSubmenu` instance's id), and whether
 * its panel takes focus when it mounts — a keyboard open does, a hover
 * doesn't. */
export interface OpenSubmenu {
  readonly id: symbol;
  readonly focus: boolean;
}

/** What the pointer is over within one level: a submenu's row, some other
 * row, or neither (padding, a heading, a separator). */
export type Hovered =
  { kind: "submenu"; id: symbol } | { kind: "item" } | { kind: "none" };

/** What a tree needs from its surroundings. */
export interface MenuTreeEnv {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(handle: number): void;
  /** The on-screen box of the panel at `depth`, if it's open. */
  panelRect(depth: number): Rect | undefined;
  /** Called just before `submenu` (and everything nested in it) closes, while
   * its panel is still in the DOM — so focus inside it can be handed back to
   * the row that opened it. */
  beforeClose(submenu: OpenSubmenu): void;
}

type Path = readonly OpenSubmenu[];

/** Whether `a` and `b` open the same submenus at each of their first `n`
 * levels (both must reach that deep). */
function samePrefix(a: Path, b: Path, n: number): boolean {
  if (a.length < n || b.length < n) return false;
  for (let i = 0; i < n; i++) if (a[i]!.id !== b[i]!.id) return false;
  return true;
}

function samePath(a: Path, b: Path): boolean {
  return a.length === b.length && samePrefix(a, b, a.length);
}

export class MenuTree {
  #path: Path = [];
  readonly #listeners = new Set<() => void>();
  /** A delayed change of `path`, waiting on its timer. */
  #pending: { path: Path; timer: number } | undefined;
  /** The grace area granted on leaving an open submenu's row: moves in level
   * `depth` inside `polygon` are ignored until the pointer pauses there for
   * `GRACE_MS`, and `replay` is the last such move, handled for real then. */
  #grace:
    | {
        depth: number;
        side: SubmenuSide;
        polygon: Point[];
        timer: number;
        replay?: () => void;
      }
    | undefined;
  /** The pointer's last x, to tell which way it's heading. */
  #lastX: number | undefined;
  readonly #env: MenuTreeEnv;

  constructor(env: MenuTreeEnv) {
    this.#env = env;
  }

  /** For `useSyncExternalStore`. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  get path(): Path {
    return this.#path;
  }

  /** Whether submenu `id`, a row of level `depth`, is open. */
  isOpen(depth: number, id: symbol): boolean {
    return this.#path[depth]?.id === id;
  }

  /** Opens submenu `id` (a row of level `depth`) now — a click or a key —
   * replacing any sibling that was open. `focus` says whether its panel takes
   * focus as it mounts. Already open, it stays (without a change of `focus`),
   * and only what's open inside it closes. */
  open(depth: number, id: symbol, focus: boolean): void {
    this.settle();
    this.#set(
      this.isOpen(depth, id)
        ? this.#path.slice(0, depth + 1)
        : [...this.#path.slice(0, depth), { id, focus }],
    );
  }

  /** Closes the submenu open in level `depth`, and everything inside it, now. */
  close(depth: number): void {
    this.settle();
    this.#set(this.#path.slice(0, depth));
  }

  /** The pointer moved to `point`, over `hovered` in level `depth`. `accept`
   * is called if the move counts — i.e. isn't swallowed by a grace area — and
   * is where the row under the pointer takes the highlight. */
  pointerMove(
    depth: number,
    hovered: Hovered,
    point: Point,
    accept?: () => void,
  ): void {
    const dx = this.#lastX === undefined ? 0 : point.x - this.#lastX;
    this.#lastX = point.x;

    const grace = this.#grace;
    if (grace) {
      const heading = grace.side === "right" ? dx >= 0 : dx <= 0;
      if (
        depth === grace.depth &&
        heading &&
        pointInPolygon(point, grace.polygon)
      ) {
        grace.replay = () => this.pointerMove(depth, hovered, point, accept);
        this.#env.clearTimeout(grace.timer);
        grace.timer = this.#env.setTimeout(() => this.#expireGrace(), GRACE_MS);
        return;
      }
      this.#clearGrace();
    }

    // The pointer is in level `depth`, so that level stays open: a pending
    // change that would close it (the pointer is back before the close delay
    // ran out) is called off.
    if (this.#pending && !samePrefix(this.#pending.path, this.#path, depth))
      this.#cancelPending();

    if (hovered.kind === "none") return;
    accept?.();
    if (hovered.kind === "item") {
      this.#schedule(this.#path.slice(0, depth), CLOSE_DELAY_MS);
    } else if (this.isOpen(depth, hovered.id)) {
      this.#cancelPending();
    } else {
      this.#schedule(
        [...this.#path.slice(0, depth), { id: hovered.id, focus: false }],
        OPEN_DELAY_MS,
      );
    }
  }

  /** The pointer left submenu `id`'s row (in level `depth`) at `point`. Open,
   * the submenu grants the grace area towards its panel; still waiting to
   * open, it no longer will. */
  pointerLeaveSubmenuRow(depth: number, id: symbol, point: Point): void {
    this.#lastX = point.x;
    if (this.isOpen(depth, id)) {
      const panel = this.#env.panelRect(depth + 1);
      if (!panel) return;
      const side = (panel.left + panel.right) / 2 >= point.x ? "right" : "left";
      this.#clearGrace();
      this.#grace = {
        depth,
        side,
        polygon: gracePolygon(point, panel, side),
        timer: this.#env.setTimeout(() => this.#expireGrace(), GRACE_MS),
      };
    } else if (this.#pending?.path[depth]?.id === id) {
      this.#cancelPending();
    }
  }

  /** The pointer left every panel of the tree. Nothing closes (see the rules
   * above), but a grace area has nothing left to protect. */
  pointerLeaveTree(): void {
    this.#clearGrace();
    this.#lastX = undefined;
  }

  /** Stops every timer — the tree is going away. */
  dispose(): void {
    this.settle();
  }

  /** Drops pointer intent (a pending change, a grace area) because something
   * decisive — a click, a key — just happened. */
  settle(): void {
    this.#cancelPending();
    this.#clearGrace();
  }

  #schedule(next: Path, delay: number): void {
    if (samePath(next, this.#path)) return this.#cancelPending();
    // Already heading there: let the running delay finish rather than
    // restarting it on every move.
    if (this.#pending && samePath(this.#pending.path, next)) return;
    this.#cancelPending();
    this.#pending = {
      path: next,
      timer: this.#env.setTimeout(() => {
        this.#pending = undefined;
        this.#set(next);
      }, delay),
    };
  }

  #cancelPending(): void {
    if (this.#pending) this.#env.clearTimeout(this.#pending.timer);
    this.#pending = undefined;
  }

  #clearGrace(): void {
    if (this.#grace) this.#env.clearTimeout(this.#grace.timer);
    this.#grace = undefined;
  }

  #expireGrace(): void {
    const replay = this.#grace?.replay;
    this.#grace = undefined;
    replay?.();
  }

  #set(next: Path): void {
    const prev = this.#path;
    if (samePath(prev, next)) return;
    let kept = 0;
    while (kept < prev.length && prev[kept]!.id === next[kept]?.id) kept++;
    if (kept < prev.length) this.#env.beforeClose(prev[kept]!);
    this.#path = next;
    for (const listener of this.#listeners) listener();
  }
}
