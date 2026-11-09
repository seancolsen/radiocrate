import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { chordToAria, type Chord } from "../../commands/chord";
import type { CommandId } from "../../commands/registry";
import { Icons, type IconComponent } from "../../icons";
import { selectBinding } from "../../stores/commands";
import { useCommands } from "../../stores/react";
import { CheckboxBox } from "./Checkbox";
import { Kbd } from "./Kbd";
import { placeDropdown, placeSubmenu } from "./menuGeometry";
import {
  MenuContext,
  useMenuLevel,
  useMenuRoot,
  usePlacement,
  type MenuController,
} from "./useMenu";
import { cx } from "./cx";

/** The interaction handle a {@link Menu} hands its trigger. */
export interface MenuApi {
  open: boolean;
  toggle: () => void;
  close: () => void;
}

/** A menu panel's surface — its fill, edge, shadow and stacking — with no
 * layout. `fixed`, placed by {@link usePlacement}; `overflow-y-auto` for when
 * the viewport caps its height. Shared with the one popup that looks like a
 * menu without being one (the record form's value suggestions). */
export const MENU_SURFACE_CLASS =
  "bg-panel border-edge fixed z-50 overflow-y-auto rounded-md border p-1 shadow-lg";

/** A menu's column layout. Every row lays its parts out in the same five
 * columns — the checkbox or radio, the icon, the label, the keyboard shortcut
 * and the submenu's chevron — so each kind of part lines up down the whole
 * panel, as in a desktop app's menus, whichever rows happen to have one. The
 * panel owns the columns; each row is a `subgrid` across all five and puts its
 * parts in theirs (see {@link MenuRowCells}).
 *
 * A column no row uses is 0 wide: the space between columns is a margin on the
 * part that's there, not a `column-gap`, which would hold the gaps open around
 * an empty column. The label's column takes whatever width is left over, which
 * is what pushes the shortcuts and chevrons to the right edge.
 *
 * Anything else in the panel (a heading, a separator, a note) spans every
 * column. */
export const MENU_COLUMNS_CLASS =
  "grid grid-cols-[auto_auto_minmax(0,1fr)_auto_auto] content-start gap-y-0.5 [&>*]:col-span-full";

/** Everything a menu panel wears, root or submenu. `w-max` sizes it to its
 * rows rather than to the room left beside its anchor — a panel squeezed
 * against the viewport's edge would otherwise just truncate its labels, and
 * never read as too wide for where it is (see `placeSubmenu`). */
export const MENU_PANEL_CLASS = `${MENU_SURFACE_CLASS} ${MENU_COLUMNS_CLASS} w-max max-w-[calc(100vw-16px)]`;

/** The classes every row shares, before its colors: one subgrid row of the
 * panel's columns (see {@link MENU_COLUMNS_CLASS}). */
const ROW_CLASS =
  "control col-span-full grid grid-cols-subgrid items-center rounded px-2 text-left outline-none";

/** Renders `children` with the keyboard shortcut `command` is bound to, as the
 * user has bound it — null for an unbound command, or for no command at all.
 * Only a row that names a command reads the commands store, so a menu of rows
 * that don't can be drawn without one (the kitchen sink does). */
function WithChord(props: {
  command: CommandId | undefined;
  children: (chord: Chord | null) => ReactNode;
}): ReactNode {
  return props.command ? (
    <BoundChord command={props.command}>{props.children}</BoundChord>
  ) : (
    props.children(null)
  );
}

function BoundChord(props: {
  command: CommandId;
  children: (chord: Chord | null) => ReactNode;
}): ReactNode {
  const chord = useCommands((s) => selectBinding(s, props.command));
  return props.children(chord);
}

/** A row's parts, each in its own column of the panel — see
 * {@link MENU_COLUMNS_CLASS}. All but the label are optional. */
function MenuRowCells(props: {
  /** A checkbox or radio indicator. */
  indicator?: ReactNode;
  icon?: IconComponent;
  label: string;
  chord?: Chord | null;
  submenu?: boolean;
}): JSX.Element {
  const Icon = props.icon;
  return (
    <>
      {props.indicator && (
        <span className="col-start-1 mr-2 flex size-4 items-center justify-center">
          {props.indicator}
        </span>
      )}
      {Icon && (
        <span className="text-ink-weak col-start-2 mr-2 flex size-4 items-center justify-center">
          <Icon className="size-4" />
        </span>
      )}
      <span className="col-start-3 min-w-0 truncate">{props.label}</span>
      {props.chord && (
        <Kbd
          chord={props.chord}
          className="text-ink-weak col-start-4 ml-6 justify-self-end"
        />
      )}
      {props.submenu && (
        <Icons.ExpandClosed className="text-ink-weak col-start-5 ml-2 size-4" />
      )}
    </>
  );
}

/** The dropdown content itself, mounted fresh each time the menu opens — which
 * is what gives it a focus trap and a freshly-highlighted first row every
 * time (see {@link useMenuRoot}). It hangs off its parent element, the
 * {@link Menu}'s wrapper around the trigger. */
function MenuPanel(props: {
  close: () => void;
  align: "start" | "end";
  side: "below" | "above";
  width?: string;
  children: ReactNode;
}): JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null);
  const menu = useMenuRoot(
    () => contentRef.current,
    () => props.close(),
  );
  usePlacement(
    contentRef,
    () => contentRef.current?.parentElement,
    (anchor, size, viewport) =>
      placeDropdown(
        anchor ?? { left: 0, top: 0, right: 0, bottom: 0 },
        size,
        viewport,
        props.side,
        props.align,
      ),
  );
  return (
    <MenuContext.Provider value={{ menu, depth: 0, closeRoot: props.close }}>
      <div
        ref={contentRef}
        role="menu"
        className={MENU_PANEL_CLASS}
        style={{ minWidth: props.width ?? "190px" }}
        onClick={() => props.close()}
        onPointerMove={(e) => menu.pointerMove(0, e)}
        onPointerLeave={() => menu.tree.pointerLeaveTree()}
      >
        {props.children}
      </div>
    </MenuContext.Provider>
  );
}

/** A lightweight dropdown menu anchored under its trigger. Owns open/close
 * state, closes on outside pointerdown and on any click inside the content
 * (any row dismisses the popup); while open, {@link useMenuRoot} owns Escape,
 * the focus trap, arrow-key navigation and submenus.
 *
 * `trigger` renders the clickable anchor (given the {@link MenuApi}); `align`
 * pins the content to the trigger's left (`start`) or right (`end`) edge, and
 * `side` drops it below the trigger (the default) or opens it upward — which is
 * what a control in the bottom bar needs. Either is a preference: the panel
 * flips to the other side, or slides along, rather than leave the viewport.
 * `className` extends the anchor wrapper, for a trigger that has to fill its
 * row rather than hug its content.
 *
 * `defaultOpen` starts the menu open, so a menu's own contents can be put on
 * screen without a trigger to click (the visual-test harness renders them that
 * way); it's read once, at creation. */
export function Menu(props: {
  trigger: (api: MenuApi) => ReactNode;
  children: ReactNode;
  align?: "start" | "end";
  side?: "below" | "above";
  width?: string;
  className?: string;
  defaultOpen?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [close]);

  const api: MenuApi = { open, toggle: () => setOpen((o) => !o), close };

  return (
    <div
      ref={wrapperRef}
      className={`relative inline-flex ${props.className ?? ""}`}
    >
      {props.trigger(api)}
      {open && (
        <MenuPanel
          close={close}
          align={props.align ?? "start"}
          side={props.side ?? "below"}
          width={props.width}
        >
          {props.children}
        </MenuPanel>
      )}
    </div>
  );
}

/** A plain, clickable menu row: optional leading icon + label. `danger` tints it
 * red; `disabled` dims it and swallows the click.
 *
 * `command` names the command whose keyboard shortcut does the same thing: its
 * chord, as the user has bound it, shows at the row's right and goes out as
 * `aria-keyshortcuts`. Only when the two really are the same — the row acts on
 * what the command acts on (the active tab, say), not on whatever the menu was
 * raised over.
 *
 * `keepOpen` leaves the menu up when the row is clicked — for a row whose action
 * happens *in* the menu (one that runs long enough to report on itself there)
 * rather than by dismissing it. Closing then belongs to the action: a row that
 * keeps the menu open has to be given the way to close it. */
export function MenuItem(props: {
  icon?: IconComponent;
  label: string;
  command?: CommandId;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  keepOpen?: boolean;
}): JSX.Element {
  return (
    <WithChord command={props.command}>
      {(chord) => (
        <button
          type="button"
          role="menuitem"
          disabled={props.disabled}
          aria-keyshortcuts={chord ? chordToAria(chord) : undefined}
          className={cx(ROW_CLASS, {
            "text-ink focus:bg-hover": !props.disabled && !props.danger,
            "text-danger focus:bg-hover": !props.disabled && props.danger,
            "text-ink-weak/40": props.disabled,
          })}
          onClick={(e) => {
            // The panel dismisses the menu on any click that reaches it.
            if (props.keepOpen) e.stopPropagation();
            props.onClick?.();
          }}
        >
          <MenuRowCells icon={props.icon} label={props.label} chord={chord} />
        </button>
      )}
    </WithChord>
  );
}

/** A menu row carrying a checkbox (independent toggle) or radio (exclusive)
 * indicator, then an optional icon and the label — the shared shape of a
 * section's options-menu rows. `command` is as {@link MenuItem}'s. */
export function MenuToggleItem(props: {
  kind: "checkbox" | "radio";
  icon?: IconComponent;
  label: string;
  command?: CommandId;
  checked: boolean;
  disabled?: boolean;
  onClick?: () => void;
}): JSX.Element {
  const indicator =
    props.kind === "checkbox" ? (
      <CheckboxBox checked={props.checked} />
    ) : (
      <span className="border-ink-weak flex size-4 shrink-0 items-center justify-center rounded-full border">
        {props.checked && <span className="bg-accent size-2 rounded-full" />}
      </span>
    );
  return (
    <WithChord command={props.command}>
      {(chord) => (
        <button
          type="button"
          role={
            props.kind === "checkbox" ? "menuitemcheckbox" : "menuitemradio"
          }
          aria-checked={props.checked}
          aria-keyshortcuts={chord ? chordToAria(chord) : undefined}
          disabled={props.disabled}
          className={cx(ROW_CLASS, {
            "text-ink focus:bg-hover": !props.disabled,
            "text-ink-weak/40": props.disabled,
          })}
          onClick={() => props.onClick?.()}
        >
          <MenuRowCells
            indicator={indicator}
            icon={props.icon}
            label={props.label}
            chord={chord}
          />
        </button>
      )}
    </WithChord>
  );
}

/** A menu row that opens a nested panel of its own rows beside it. Under a
 * pointer it opens on hover and closes when the pointer moves on, both on a
 * short delay (the timing rules are `MenuTree`'s); a click opens it at once,
 * and a tap toggles it, since touch has no hover. From the keyboard,
 * Right/Enter/Space open it with focus on its first row, and Left or Escape
 * close it again (see {@link useMenuRoot}).
 *
 * The panel opens to the row's right, or to its left when the viewport hasn't
 * room (the wrench menu is near the left edge on a phone, where a right-hand
 * flyout would run off-screen). It stays a DOM descendant of the menu that
 * holds it, so a click on one of its rows bubbles up and dismisses the whole
 * stack as any menu row does; the row swallows its own click, so opening the
 * submenu doesn't dismiss the menu that holds it. */
export function MenuSubmenu(props: {
  icon?: IconComponent;
  label: string;
  width?: string;
  children: ReactNode;
}): JSX.Element {
  const { menu, depth, closeRoot } = useMenuLevel();
  const [id] = useState(() => Symbol("submenu"));
  const open = useSyncExternalStore(menu.tree.subscribe, () =>
    menu.tree.isOpen(depth, id),
  );
  const rowRef = useRef<HTMLButtonElement>(null);
  // How the last press on the row was made, for the click it turns into.
  const pointerTypeRef = useRef("mouse");
  const panelId = useId();

  useLayoutEffect(() => {
    const row = rowRef.current;
    return row ? menu.registerRow(id, row) : undefined;
  }, [menu, id]);

  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    // A click with no pointer behind it is Space on the focused row.
    if (e.detail === 0) menu.enter(depth, id);
    // A pointer click only ever opens: it usually lands after the hover delay
    // already has, and closing it then would undo what the user reached for.
    else if (pointerTypeRef.current !== "touch" || !open)
      menu.tree.open(depth, id, false);
    else menu.tree.close(depth);
  };

  return (
    <>
      <button
        ref={rowRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className={cx(
          ROW_CLASS,
          "text-ink focus:bg-hover aria-expanded:bg-hover",
        )}
        onPointerDown={(e) => {
          pointerTypeRef.current = e.pointerType;
        }}
        onPointerLeave={(e) => {
          if (e.pointerType !== "touch")
            menu.tree.pointerLeaveSubmenuRow(depth, id, {
              x: e.clientX,
              y: e.clientY,
            });
        }}
        onClick={onClick}
      >
        <MenuRowCells icon={props.icon} label={props.label} submenu />
      </button>
      {open && (
        <SubmenuPanel
          id={panelId}
          menu={menu}
          depth={depth + 1}
          closeRoot={closeRoot}
          row={rowRef}
          width={props.width}
        >
          {props.children}
        </SubmenuPanel>
      )}
    </>
  );
}

/** An open submenu's panel: level `depth` of its tree. Mounted as it opens,
 * so its mount is where a keyboard open moves focus in. */
function SubmenuPanel(props: {
  id: string;
  menu: MenuController;
  depth: number;
  closeRoot: () => void;
  row: RefObject<HTMLElement | null>;
  width?: string;
  children: ReactNode;
}): JSX.Element {
  const { menu, depth } = props;
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    const unregister = menu.registerPanel(depth, panel);
    // A hover leaves focus on the row that opened the submenu; only a key
    // moves it in.
    if (menu.tree.path[depth - 1]?.focus) menu.rows(depth)[0]?.focus();
    return unregister;
  }, [menu, depth]);

  usePlacement(
    ref,
    () => props.row.current,
    (row, size, viewport) => {
      const p = placeSubmenu(
        row ?? { left: 0, top: 0, right: 0, bottom: 0 },
        size,
        viewport,
        menu.sideOf(depth - 1),
      );
      menu.setSide(depth, p.side);
      return p;
    },
  );

  return (
    <MenuContext.Provider value={{ menu, depth, closeRoot: props.closeRoot }}>
      <div
        ref={ref}
        id={props.id}
        role="menu"
        className={MENU_PANEL_CLASS}
        style={{ minWidth: props.width ?? "200px" }}
        onPointerMove={(e) => menu.pointerMove(depth, e)}
      >
        {props.children}
      </div>
    </MenuContext.Provider>
  );
}

/** A small all-caps category heading inside an options menu. */
export function MenuHeading(props: { text: string }): JSX.Element {
  return (
    <div className="text-ink-weak px-2 pt-1.5 pb-0.5 text-[10px] font-semibold tracking-wide">
      {props.text}
    </div>
  );
}

/** A non-interactive line of explanatory text inside a menu — what stands in for
 * rows that aren't there yet (an empty list, a schema still loading). Carries no
 * `menuitem` role, so the keyboard walks straight past it. */
export function MenuNote(props: { text: string }): JSX.Element {
  return (
    <div className="control text-ink-weak grid grid-cols-subgrid px-2">
      <span className="col-start-3 min-w-0 truncate">{props.text}</span>
    </div>
  );
}

/** A submenu's rows that arrive after it opens: a spinning note until
 * `loading` clears, then `children`. The panel moves to keep the rows on
 * screen as they arrive (see `usePlacement`).
 *
 * A keyboard open moves focus to a submenu's first row as its panel mounts —
 * which, while the rows are still loading, finds none and leaves focus on the
 * row that opened it. So once they arrive, focus moves on to the first of
 * them, unless something else has taken it in the meantime. */
export function MenuLoader(props: {
  loading: boolean;
  children: ReactNode;
}): JSX.Element {
  const { menu, depth } = useMenuLevel();
  const { loading } = props;
  useLayoutEffect(() => {
    if (loading || !menu.tree.path[depth - 1]?.focus) return;
    const active = document.activeElement;
    const at = active ? menu.depthOf(active) : undefined;
    if (at === undefined || at < depth) menu.rows(depth)[0]?.focus();
  }, [loading, menu, depth]);
  if (!loading) return <>{props.children}</>;
  return (
    <div className="control text-ink-weak grid grid-cols-subgrid items-center px-2">
      <span className="col-start-2 mr-2 flex size-4 items-center justify-center">
        <Icons.Spinner className="size-4" />
      </span>
      <span className="col-start-3">Loading…</span>
    </div>
  );
}

/** A hairline separator between menu groups. */
export function MenuSeparator(): JSX.Element {
  return <div className="border-edge my-1 border-t" />;
}
