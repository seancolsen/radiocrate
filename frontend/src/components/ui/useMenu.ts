import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useStores } from "../../stores/react";
import type { Placement, Rect, Size, SubmenuSide } from "./menuGeometry";
import { MenuTree, type Hovered } from "./menuTree";

// The behavior every dropdown/context menu shares, and the submenus nested in
// them. A root menu (`Menu`'s panel, `ContextMenu`) calls `useMenuRoot`, which
// builds one `MenuController` for the whole tree and hands it down through
// `MenuContext`; each `MenuSubmenu` reads it from there.
//
// The keyboard contract: a focus trap (Tab cycles within the menu instead of
// escaping it), Up/Down/Home/End roving real DOM focus among the rows of the
// level that holds focus — a submenu's own rows only, wrapping within them —
// and Enter activating the focused row. On a submenu's row, Right/Enter/Space
// open it and move focus to its first row. Left closes the innermost open
// submenu, and Escape does too, closing the root menu only once no submenu is
// left open. Focus inside a submenu that closes goes back to the row that
// opened it.
//
// The pointer contract is `MenuTree`'s: submenus open and close on hover, on a
// delay, with a grace area for reaching them diagonally. The highlighted row
// follows whichever input moved last — hovering a row focuses it.
//
// Opening a root menu also registers it as open in the `menus` store, which the
// global shortcut pass (`stores/commands.ts`'s `suppressed`) checks — otherwise
// a bare Up/Down/Delete bound to a page command (e.g. row selection) would fire
// *underneath* the menu at the same time it moves the menu's own highlight.
//
// Open menus are tracked in the `menus` store as a `Set<symbol>`: each root
// keeps one `symbol` (created once, via a `useState` initializer) for its whole
// lifetime, so StrictMode's mount → cleanup → mount replay opens and closes the
// *same* id and nets out to one open entry, where a bare `++`/`--` counter
// would double it.

/** A menu's rows: `MenuItem` (`menuitem`), `MenuToggleItem`
 * (`menuitemcheckbox` / `menuitemradio`) and `MenuSubmenu` rows — any role
 * starting with "menuitem". */
const ROW_SELECTOR = '[role^="menuitem"]';

/** The level (panel) an element belongs to — its nearest menu. */
function panelOf(el: Element): Element | null {
  return el.closest('[role="menu"]');
}

/** The pointer event fields `MenuController.pointerMove` reads — a React or a
 * native `PointerEvent` both fit. */
interface PointerLike {
  pointerType: string;
  clientX: number;
  clientY: number;
  target: EventTarget;
  currentTarget: EventTarget;
}

/** The DOM side of one menu tree: which panel is open at each level and which
 * row opens each submenu, plus the focus and key handling built on them. The
 * open state itself (and the pointer timing) is its `tree`. */
export class MenuController {
  readonly tree: MenuTree;
  /** Each open level's panel, by depth — 0 is the root menu. */
  readonly #panels = new Map<number, HTMLElement>();
  /** Each submenu's row, by the submenu's id. */
  readonly #rows = new Map<symbol, HTMLElement>();
  /** The side each level's panel opened on, so the next one down keeps going
   * the same way. */
  readonly #sides = new Map<number, SubmenuSide>();

  constructor() {
    this.tree = new MenuTree({
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (handle) => window.clearTimeout(handle),
      panelRect: (depth) => this.#panels.get(depth)?.getBoundingClientRect(),
      beforeClose: (submenu) => {
        // Focus inside the closing panels — or dropped on <body> — goes back
        // to the row that opened them, rather than falling to <body> as they
        // unmount. Focus elsewhere (the pointer's already on another row)
        // stays put.
        const row = this.#rows.get(submenu.id);
        const depth = row && this.depthOf(row);
        if (row === undefined || depth === undefined) return;
        const active = document.activeElement;
        if (
          active === null ||
          active === document.body ||
          (this.depthOf(active) ?? -1) > depth
        )
          row.focus();
      },
    });
  }

  /** Records `panel` as level `depth`'s; returns the matching cleanup. */
  registerPanel(depth: number, panel: HTMLElement): () => void {
    this.#panels.set(depth, panel);
    return () => {
      if (this.#panels.get(depth) === panel) this.#panels.delete(depth);
    };
  }

  /** Records `row` as the row that opens submenu `id`; returns the cleanup. */
  registerRow(id: symbol, row: HTMLElement): () => void {
    this.#rows.set(id, row);
    return () => {
      if (this.#rows.get(id) === row) this.#rows.delete(id);
    };
  }

  sideOf(depth: number): SubmenuSide {
    return this.#sides.get(depth) ?? "right";
  }

  setSide(depth: number, side: SubmenuSide): void {
    this.#sides.set(depth, side);
  }

  /** The level `el` sits in, if it's one of this tree's. */
  depthOf(el: Element): number | undefined {
    const panel = panelOf(el);
    for (const [depth, p] of this.#panels) if (p === panel) return depth;
    return undefined;
  }

  /** Level `depth`'s enabled rows, in order — its own, not those of the
   * submenus nested inside it. */
  rows(depth: number): HTMLElement[] {
    const panel = this.#panels.get(depth);
    if (!panel) return [];
    return Array.from(
      panel.querySelectorAll<HTMLElement>(`${ROW_SELECTOR}:not(:disabled)`),
    ).filter((row) => panelOf(row) === panel);
  }

  /** The submenu `row` opens, if it's a submenu's row. */
  submenuOf(row: Element): symbol | undefined {
    for (const [id, r] of this.#rows) if (r === row) return id;
    return undefined;
  }

  /** Opens submenu `id` (a row of level `depth`) from the keyboard, moving
   * focus to its first row — including when the pointer had already opened
   * it, leaving focus on its row. */
  enter(depth: number, id: symbol): void {
    const wasOpen = this.tree.isOpen(depth, id);
    this.tree.open(depth, id, true);
    if (wasOpen) this.rows(depth + 1)[0]?.focus();
  }

  /** A pointer move over level `depth`'s panel (the event's `currentTarget`).
   * Moves over a nested submenu's panel bubble through here too, and are left
   * to that level's own handler. Touch has no hover, so it's ignored. */
  pointerMove(depth: number, e: PointerLike): void {
    if (e.pointerType === "touch") return;
    const target = e.target as Element;
    if (panelOf(target) !== e.currentTarget) return;
    const row = target.closest<HTMLElement>(ROW_SELECTOR);
    const id = row ? this.submenuOf(row) : undefined;
    const hovered: Hovered =
      row === null
        ? { kind: "none" }
        : id
          ? { kind: "submenu", id }
          : { kind: "item" };
    const takeFocus =
      row && !row.matches(":disabled")
        ? () => {
            if (document.activeElement !== row) row.focus();
          }
        : undefined;
    this.tree.pointerMove(
      depth,
      hovered,
      { x: e.clientX, y: e.clientY },
      takeFocus,
    );
  }

  /** The document-level keydown handler for the whole tree. Keys act on the
   * level holding focus (or, with focus nowhere in the menus, the innermost
   * open one). */
  keyDown(e: KeyboardEvent, closeRoot: () => void): void {
    const path = this.tree.path;
    const active = document.activeElement;
    const focusDepth = active ? this.depthOf(active) : undefined;
    const depth = focusDepth ?? path.length;
    const submenu =
      active && focusDepth !== undefined ? this.submenuOf(active) : undefined;

    switch (e.key) {
      case "Escape":
        e.preventDefault();
        if (path.length > 0) this.tree.close(path.length - 1);
        else closeRoot();
        break;
      case "ArrowLeft":
        if (path.length > 0) {
          e.preventDefault();
          this.tree.close(path.length - 1);
        }
        break;
      case "ArrowRight":
        if (submenu) {
          e.preventDefault();
          this.enter(depth, submenu);
        }
        break;
      case "ArrowDown":
      case "ArrowUp":
      case "Home":
      case "End":
      case "Tab":
        // Tab/Shift+Tab are the focus trap: they cycle within the menu's own
        // rows rather than leaving it for the rest of the page.
        e.preventDefault();
        this.#move(
          depth,
          e.key === "Home"
            ? "first"
            : e.key === "End"
              ? "last"
              : e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)
                ? -1
                : 1,
        );
        break;
      case "Enter":
        if (submenu) {
          e.preventDefault();
          this.enter(depth, submenu);
        } else if (
          active instanceof HTMLElement &&
          this.#panels.get(0)?.contains(active)
        ) {
          e.preventDefault();
          active.click();
        }
        break;
    }
  }

  /** Moves focus among level `depth`'s rows, wrapping at either end. Moving
   * off an open submenu's row closes that submenu. */
  #move(depth: number, to: 1 | -1 | "first" | "last"): void {
    const rows = this.rows(depth);
    if (rows.length === 0) return;
    const current = rows.indexOf(document.activeElement as HTMLElement);
    const index =
      to === "first"
        ? 0
        : to === "last"
          ? rows.length - 1
          : current === -1
            ? to > 0
              ? 0
              : rows.length - 1
            : current + to;
    rows[(index + rows.length) % rows.length]?.focus();
    const open = this.tree.path[depth];
    if (open && this.#rows.get(open.id) !== document.activeElement)
      this.tree.close(depth);
    else this.tree.settle();
  }
}

/** One level of a menu tree, as seen from inside it. */
export interface MenuLevel {
  menu: MenuController;
  /** 0 for the root menu, 1 for a submenu of it, and so on. */
  depth: number;
}

export const MenuContext = createContext<MenuLevel | null>(null);

/** The level the calling menu row sits in. */
export function useMenuLevel(): MenuLevel {
  const level = useContext(MenuContext);
  if (!level) throw new Error("A submenu must sit inside a menu.");
  return level;
}

/** Wires the shared menu behavior onto a root menu's panel, returning the
 * controller its `MenuContext` should carry. Call once per mount of the menu's
 * content (i.e. from inside the component that renders it while open) — it
 * focuses the first row immediately and restores focus to whatever held it
 * before, once the menu closes. */
export function useMenuRoot(
  getContainer: () => HTMLElement | undefined | null,
  onClose: () => void,
): MenuController {
  const { menus } = useStores();
  const [id] = useState(() => Symbol("menu"));
  const [menu] = useState(() => new MenuController());

  // Refs so the layout effect below can stay a mount-only effect (an empty
  // dependency array) while still calling whatever `getContainer`/`onClose`
  // the *latest* render closed over. Synced from effects, never from the
  // render body: a ref write during render is unsafe (React may discard or
  // replay a render without it ever having "happened"), even though the ref's
  // *initial* value is already right for the first render via `useRef`'s own
  // argument.
  const getContainerRef = useRef(getContainer);
  useEffect(() => {
    getContainerRef.current = getContainer;
  }, [getContainer]);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // What held focus before the menu opened, captured by the first setup only.
  // StrictMode's replay runs setup a second time *after* the first has focused
  // the menu's own first row, so a second capture would record that row and
  // closing would "restore" focus to a detached button.
  const previouslyFocusedRef = useRef<HTMLElement | null | undefined>(
    undefined,
  );

  useLayoutEffect(() => {
    if (previouslyFocusedRef.current === undefined)
      previouslyFocusedRef.current =
        document.activeElement as HTMLElement | null;
    const previouslyFocused = previouslyFocusedRef.current;
    menus.actions.openMenu(id);

    const container = getContainerRef.current();
    const unregister = container ? menu.registerPanel(0, container) : undefined;
    menu.rows(0)[0]?.focus();

    const onKeyDown = (e: KeyboardEvent): void =>
      menu.keyDown(e, () => onCloseRef.current());
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      unregister?.();
      menu.tree.dispose();
      menus.actions.closeMenu(id);
      // Deferred, and only once nothing else has claimed focus: several menu
      // rows (Edit, "Enter a new record", "Pick a record", ...) deliberately
      // focus something of their own as part of what they do, queued to run
      // once the click that chose them finishes — same tick as this cleanup,
      // but after it. Restoring unconditionally here would win that race and
      // steal focus back before the row's own effect lands (worse, refocusing
      // the old target can itself cancel what the row just started, e.g. an
      // edit-in-progress that a field's blur handler treats as abandoned).
      // Once this menu's content is gone, focus reverts to <body> until
      // something else claims it — that's the signal nothing did.
      queueMicrotask(() => {
        if (document.activeElement === document.body)
          previouslyFocused?.focus();
      });
    };
    // `id`, `menu` and `menus` are all stable for the component's life
    // (`useState` initializers and the store bundle from context), and every
    // other input is read through a ref — so despite the dependency array,
    // this never actually re-runs mid-life: it sets up as the menu opens and
    // tears down as it closes.
  }, [id, menu, menus]);

  return menu;
}

/** Where a panel goes, given its anchor's on-screen box (when it has one), its
 * own full size, and the viewport's. */
type Place = (
  anchor: Rect | undefined,
  size: Size,
  viewport: Size,
) => Placement;

/** Keeps a `position: fixed` panel where `place` says, measured against the
 * element `getAnchor` returns (read at placement time, so an anchor whose ref
 * React attaches after this panel's effects run — a parent's — still counts):
 * before its first paint, after every render (its rows may have changed its
 * size), and whenever the window resizes or anything scrolls (which moves the
 * anchor out from under it). */
export function usePlacement(
  panelRef: RefObject<HTMLElement | null>,
  getAnchor: (() => Element | null | undefined) | null,
  place: Place,
): void {
  const inputsRef = useRef({ getAnchor, place });
  useLayoutEffect(() => {
    inputsRef.current = { getAnchor, place };
    applyPlacement(panelRef.current, getAnchor?.(), place);
  });
  useEffect(() => {
    const update = () => {
      const { getAnchor, place } = inputsRef.current;
      applyPlacement(panelRef.current, getAnchor?.(), place);
    };
    window.addEventListener("resize", update);
    document.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", update, true);
    };
  }, [panelRef]);
}

function applyPlacement(
  panel: HTMLElement | null,
  anchor: Element | null | undefined,
  place: Place,
): void {
  if (!panel) return;
  const root = document.documentElement;
  const viewport = { width: root.clientWidth, height: root.clientHeight };
  // The panel's full height, even while an earlier placement caps it and it
  // scrolls — measured without lifting the cap, which would reset its scroll.
  const size = {
    width: panel.getBoundingClientRect().width,
    height: panel.scrollHeight + panel.offsetHeight - panel.clientHeight,
  };
  const p = place(anchor?.getBoundingClientRect(), size, viewport);
  panel.style.maxHeight = `${p.maxHeight}px`;
  panel.style.left = `${p.left}px`;
  panel.style.top = `${p.top}px`;
  // `fixed` is relative to the viewport — unless an ancestor is transformed
  // (the phone-width sidebar drawer is), which offsets the panel by wherever
  // that ancestor sits. Measure where it landed and take the offset back out.
  const at = panel.getBoundingClientRect();
  if (Math.abs(at.left - p.left) > 0.5 || Math.abs(at.top - p.top) > 0.5) {
    panel.style.left = `${2 * p.left - at.left}px`;
    panel.style.top = `${2 * p.top - at.top}px`;
  }
}
