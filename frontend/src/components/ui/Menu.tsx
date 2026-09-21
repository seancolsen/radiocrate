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
import { Icons, type IconComponent } from "../../icons";
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

/** The classes every menu panel shares, root or submenu. `fixed`, placed by
 * {@link usePlacement}; `overflow-y-auto` for when the viewport caps its
 * height. */
export const MENU_PANEL_CLASS =
  "bg-panel border-edge fixed z-50 flex flex-col gap-0.5 overflow-y-auto rounded-md border p-1 shadow-lg";

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
 * `keepOpen` leaves the menu up when the row is clicked — for a row whose action
 * happens *in* the menu (one that runs long enough to report on itself there)
 * rather than by dismissing it. Closing then belongs to the action: a row that
 * keeps the menu open has to be given the way to close it. */
export function MenuItem(props: {
  icon?: IconComponent;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  keepOpen?: boolean;
}): JSX.Element {
  const Icon = props.icon;
  return (
    <button
      type="button"
      role="menuitem"
      disabled={props.disabled}
      className={cx(
        "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm outline-none",
        {
          "text-ink focus:bg-hover": !props.disabled && !props.danger,
          "text-danger focus:bg-hover": !props.disabled && props.danger,
          "text-ink-weak/40": props.disabled,
        },
      )}
      onClick={(e) => {
        // The panel dismisses the menu on any click that reaches it.
        if (props.keepOpen) e.stopPropagation();
        props.onClick?.();
      }}
    >
      {Icon && (
        <span className="text-ink-weak flex size-4 shrink-0 items-center justify-center">
          <Icon className="size-4" />
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
    </button>
  );
}

/** A menu row carrying a checkbox (independent toggle) or radio (exclusive)
 * indicator, then the section icon and label — the shared shape of a section's
 * options-menu rows. */
export function MenuToggleItem(props: {
  kind: "checkbox" | "radio";
  icon: IconComponent;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onClick?: () => void;
}): JSX.Element {
  const Icon = props.icon;
  return (
    <button
      type="button"
      role={props.kind === "checkbox" ? "menuitemcheckbox" : "menuitemradio"}
      aria-checked={props.checked}
      disabled={props.disabled}
      className={cx(
        "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm outline-none",
        {
          "text-ink focus:bg-hover": !props.disabled,
          "text-ink-weak/40": props.disabled,
        },
      )}
      onClick={() => props.onClick?.()}
    >
      <span
        className={cx(
          "border-ink-weak flex size-4 shrink-0 items-center justify-center border",
          {
            "rounded-sm": props.kind === "checkbox",
            "rounded-full": props.kind === "radio",
            "bg-accent border-accent": props.checked,
          },
        )}
      >
        {props.checked && (
          <span
            className={cx("bg-panel", {
              "size-2 rounded-full": props.kind === "radio",
              "size-1.5 rounded-[1px]": props.kind === "checkbox",
            })}
          />
        )}
      </span>
      <span className="text-ink-weak flex size-4 shrink-0 items-center justify-center">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
    </button>
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
  const Icon = props.icon;

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
        className="text-ink focus:bg-hover aria-expanded:bg-hover flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm outline-none"
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
        {Icon && (
          <span className="text-ink-weak flex size-4 shrink-0 items-center justify-center">
            <Icon className="size-4" />
          </span>
        )}
        <span className="min-w-0 flex-1 truncate">{props.label}</span>
        <Icons.ExpandClosed className="text-ink-weak size-4 shrink-0" />
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
  return <div className="text-ink-weak px-2 py-1 text-sm">{props.text}</div>;
}

/** A hairline separator between menu groups. */
export function MenuSeparator(): JSX.Element {
  return <div className="border-edge my-1 border-t" />;
}
