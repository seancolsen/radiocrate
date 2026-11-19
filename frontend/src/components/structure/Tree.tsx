import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Icons } from "../../icons";
import { useApp, useAppActions } from "../../stores/react";
import { cx } from "../ui/cx";

// The Data structure page's tree: what every item of it shares, whatever it
// stands for — a row with a chevron, what's under it indented below a tree
// line, and the keyboard moving between rows.
//
// Which items are open is the app store's (`structure.expanded`, by item id),
// so it's remembered, and anything that sends the user to the page can open the
// way to what it's about.
//
// The keyboard works off the DOM, as the record editor form's does
// (`record/formNav.ts`): every row is a focusable `[data-tree-item]`, and their
// document order is the order they're read in, so "the row below" is a query and
// an index, and only ever lands on a row that's on screen.

/** How tall a row is, in px. Fixed, since a row that sticks does so right under
 * the rows above it in the tree, each of this height. */
const ROW_PX = 30;

/** A stuck row's layer, by depth: a row sits over what's under it in the tree,
 * and under what it's within. Spelled out, for Tailwind to find — and all of
 * them low, under everything the app lays over a page (the explorer as a
 * drawer, a toast). */
const STICKY_LAYERS = ["z-[6]", "z-[5]", "z-[4]", "z-[3]", "z-[2]", "z-[1]"];

/** How deep in the tree the rows being rendered are: 0 at the top. */
const TreeDepth = createContext(0);

/** The rows of the tree `el` is in, in the order they're read. */
function treeItems(el: HTMLElement): HTMLElement[] {
  const tree = el.closest<HTMLElement>('[role="tree"]');
  return tree
    ? [...tree.querySelectorAll<HTMLElement>("[data-tree-item]")]
    : [];
}

/** Focuses a row, bringing it out from under the rows stuck above it: its
 * scroll margin is the height of that stack. */
function focusRow(row: HTMLElement | undefined): void {
  if (!row) return;
  row.focus({ preventScroll: true });
  row.scrollIntoView({ block: "nearest" });
}

/** The row of the item the item at `row` is under, if it's under one. */
function parentRow(row: HTMLElement): HTMLElement | undefined {
  const parent = row
    .closest("[data-tree-node]")
    ?.parentElement?.closest("[data-tree-node]");
  return parent?.querySelector<HTMLElement>("[data-tree-item]") ?? undefined;
}

/** The keys of a row with focus, as a tree's are everywhere: Up and Down move
 * between the rows on screen, Home and End go to the first and last, Right
 * opens the row (or, open already, steps into it), Left closes it (or, closed
 * already, steps out to the row it's under), and Enter or Space opens and closes
 * it. `expanded` is undefined for a row with nothing under it.
 *
 * Only for a key pressed on the row itself: one pressed in a control within it,
 * or with a modifier held, is somebody else's. */
export function handleTreeKey(
  e: KeyboardEvent<HTMLElement>,
  item: { expanded: boolean | undefined; toggle: (open: boolean) => void },
): void {
  if (e.target !== e.currentTarget) return;
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const row = e.currentTarget;
  const rows = treeItems(row);
  const at = rows.indexOf(row);
  switch (e.key) {
    case "ArrowDown":
      focusRow(rows[at + 1]);
      break;
    case "ArrowUp":
      focusRow(rows[at - 1]);
      break;
    case "Home":
      focusRow(rows[0]);
      break;
    case "End":
      focusRow(rows[rows.length - 1]);
      break;
    case "ArrowRight": {
      if (item.expanded === undefined) return;
      if (!item.expanded) {
        item.toggle(true);
        break;
      }
      const next = rows[at + 1];
      if (next && row.closest("[data-tree-node]")?.contains(next)) {
        focusRow(next);
      }
      break;
    }
    case "ArrowLeft":
      if (item.expanded) item.toggle(false);
      else focusRow(parentRow(row));
      break;
    case "Enter":
    case " ":
      if (item.expanded === undefined) return;
      item.toggle(!item.expanded);
      break;
    default:
      return;
  }
  e.preventDefault();
}

/** The ids of the items beside the one at `row`, itself included, that can be
 * opened: what a Ctrl+Click on it opens or closes together. */
function siblingIds(row: HTMLElement): string[] {
  const group = row.closest("[data-tree-node]")?.parentElement;
  if (!group) return [];
  return [...group.children].flatMap((child) =>
    child instanceof HTMLElement &&
    child.dataset.expandable !== undefined &&
    child.dataset.itemId !== undefined
      ? [child.dataset.itemId]
      : [],
  );
}

/** Brings the item `id` into view when it's the one the page was asked to
 * reveal — below the rows stuck above it — and gives it the keyboard, unless
 * something inside it has taken that already (an editor the reveal was for).
 * Run once the page is showing, which an effect only is. */
function useReveal(id: string, rowRef: RefObject<HTMLElement | null>): void {
  const reveal = useApp((s) => s.structure.reveal === id);
  const { clearStructureReveal } = useAppActions();
  useEffect(() => {
    const row = rowRef.current;
    if (!reveal || !row) return;
    row.scrollIntoView({ block: "start" });
    const node = row.closest("[data-tree-node]");
    if (!node?.contains(document.activeElement)) {
      row.focus({ preventScroll: true });
    }
    clearStructureReveal();
  }, [reveal, rowRef, clearStructureReveal]);
}

/** Puts the caret in an editor under item `id` when that item is the one the
 * page was asked to reveal: the prelude, sent for from an error strip; a
 * contextual query just added. A layout effect, so the caret is there before
 * the item's own reveal looks for it (`useReveal`). */
export function useFocusOnReveal(
  id: string,
  editorRef: RefObject<HTMLElement | null>,
): void {
  const reveal = useApp((s) => s.structure.reveal === id);
  useLayoutEffect(() => {
    if (reveal) editorRef.current?.focus({ preventScroll: true });
  }, [reveal, editorRef]);
}

/** What makes an element a row of the tree when it isn't a `TreeNode`'s to
 * render — a preset's heading button, which is that preset's row: the marker the
 * keyboard finds rows by, the scroll margin that keeps it clear of the rows
 * stuck above it, and the tree's keys. Whatever holds the element needs a
 * `data-tree-node` around it, as a `TreeNode` has. */
export function useTreeRowProps(item: {
  expanded: boolean;
  toggle: (open: boolean) => void;
}): {
  "data-tree-item": string;
  style: { scrollMarginTop: number };
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
} {
  const depth = useContext(TreeDepth);
  return {
    "data-tree-item": "",
    style: { scrollMarginTop: depth * ROW_PX },
    onKeyDown: (e) => handleTreeKey(e, item),
  };
}

/** One item of the tree: its row, and, while it's open, what's under it.
 *
 * `label` is the row: what the item is. `actions` are its controls, at the
 * row's far end. A row with `children` to show (`expandable`) opens and closes
 * on a click anywhere but its controls — every item beside it too, on a
 * Ctrl+Click — and stays in view while what's under it is scrolled: it sticks to
 * the top of the page, under the rows of the items it's within.
 *
 * `dimmed` draws the row's label faded: something the user has hidden. */
export function TreeNode(props: {
  id: string;
  /** Whether the item has anything under it. */
  expandable: boolean;
  label: ReactNode;
  actions?: ReactNode;
  dimmed?: boolean;
  onContextMenu?: (e: MouseEvent<HTMLElement>) => void;
  children?: ReactNode;
}): JSX.Element {
  const { id, expandable } = props;
  const depth = useContext(TreeDepth);
  const open = useApp((s) => s.structure.expanded[id] === true);
  const expanded = expandable && open;
  const { setStructureExpanded } = useAppActions();
  const rowRef = useRef<HTMLDivElement>(null);
  const groupId = useId();
  useReveal(id, rowRef);

  const toggle = (next: boolean, siblings = false) => {
    const row = rowRef.current;
    setStructureExpanded(siblings && row ? siblingIds(row) : [id], next);
  };

  return (
    <div
      data-tree-node=""
      data-item-id={id}
      data-expandable={expandable ? "" : undefined}
    >
      <div
        ref={rowRef}
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={expandable ? expanded : undefined}
        aria-owns={expanded ? groupId : undefined}
        tabIndex={0}
        data-tree-item=""
        // The row is opaque, and square: what scrolls under it while it's stuck
        // mustn't show at its corners. The rounded hover and focus are drawn
        // within it. A menu open on the row lifts it over the rows after it,
        // which would otherwise be painted over the menu.
        className={cx(
          "group/row bg-panel outline-none select-none",
          expandable &&
            `sticky has-[[role=menu]]:z-10 ${STICKY_LAYERS[Math.min(depth, STICKY_LAYERS.length - 1)]}`,
        )}
        style={{
          top: expandable ? depth * ROW_PX : undefined,
          scrollMarginTop: depth * ROW_PX,
        }}
        onClick={(e) => {
          if (expandable) toggle(!expanded, e.ctrlKey || e.metaKey);
        }}
        onKeyDown={(e) =>
          handleTreeKey(e, {
            expanded: expandable ? expanded : undefined,
            toggle,
          })
        }
        onContextMenu={props.onContextMenu}
      >
        <div
          className={cx(
            "group-focus-visible/row:outline-accent flex items-center gap-1 rounded pr-1 group-focus-visible/row:outline-2 group-focus-visible/row:-outline-offset-2",
            { "group-hover/row:bg-hover cursor-pointer": expandable },
          )}
          style={{ height: ROW_PX }}
        >
          <span
            className="text-ink-weak flex size-4 shrink-0 items-center justify-center"
            aria-hidden="true"
          >
            {expandable &&
              (expanded ? <Icons.ExpandOpen /> : <Icons.ExpandClosed />)}
          </span>
          <div
            className={cx("flex min-w-0 flex-1 items-center gap-1.5", {
              "opacity-60": props.dimmed,
            })}
          >
            {props.label}
          </div>
          {props.actions && (
            // A control on the row acts for itself: its click isn't the row's.
            <div
              className="flex shrink-0 cursor-default items-center gap-0.5"
              onClick={(e) => e.stopPropagation()}
            >
              {props.actions}
            </div>
          )}
        </div>
      </div>
      {expanded && (
        <TreeDepth.Provider value={depth + 1}>
          <div
            id={groupId}
            role="group"
            className="border-edge ml-2 border-l pl-2"
          >
            {props.children}
          </div>
        </TreeDepth.Provider>
      )}
    </div>
  );
}

/** A row's name: what the item is called. */
export function TreeName(props: { children: ReactNode }): JSX.Element {
  return (
    <span className="text-ink min-w-0 truncate text-sm">{props.children}</span>
  );
}

/** What a row says about its item beside the name, quietly: a table's size, a
 * column's statistics. On a row too narrow for everything, it's what gives way:
 * all of it, before anything else on the row loses a letter. */
export function TreeNote(props: { children: ReactNode }): JSX.Element {
  return (
    <span className="text-ink-weak min-w-0 shrink-[1000] truncate text-xs">
      {props.children}
    </span>
  );
}

/** A line under an item that has nothing else to show there. */
export function TreeEmpty(props: { children: ReactNode }): JSX.Element {
  return (
    <div className="text-ink-weak py-1 pl-5 text-xs">{props.children}</div>
  );
}
