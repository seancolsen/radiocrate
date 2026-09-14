import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Icons, type IconComponent } from "../../icons";
import { useMenuKeyboard } from "./useMenuKeyboard";
import { cx } from "./cx";

/** The interaction handle a {@link Menu} hands its trigger. */
export interface MenuApi {
  open: boolean;
  toggle: () => void;
  close: () => void;
}

/** The dropdown content itself, mounted fresh each time the menu opens — which
 * is what gives it a focus trap and a freshly-highlighted first row every
 * time (see {@link useMenuKeyboard}). */
function MenuPanel(props: {
  close: () => void;
  align: "start" | "end";
  side: "below" | "above";
  width?: string;
  children: ReactNode;
}): JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null);
  useMenuKeyboard(
    () => contentRef.current,
    () => props.close(),
  );
  return (
    <div
      ref={contentRef}
      role="menu"
      className={cx(
        "bg-panel border-edge absolute z-50 flex flex-col gap-0.5 rounded-md border p-1 shadow-lg",
        {
          "left-0": props.align === "start",
          "right-0": props.align === "end",
          "top-full mt-1": props.side === "below",
          "bottom-full mb-1": props.side === "above",
        },
      )}
      style={{ minWidth: props.width ?? "190px" }}
      onClick={() => props.close()}
    >
      {props.children}
    </div>
  );
}

/** A lightweight dropdown menu anchored under its trigger. Owns open/close
 * state, closes on outside pointerdown and on any click inside the content
 * (any row dismisses the popup); while open, {@link useMenuKeyboard} owns
 * Escape, the focus trap, and Up/Down/Enter navigation. Positions with plain
 * absolute layout relative to the trigger — adequate for the toolbar, whose
 * menus always drop downward.
 *
 * `trigger` renders the clickable anchor (given the {@link MenuApi}); `align`
 * pins the content to the trigger's left (`start`) or right (`end`) edge, and
 * `side` drops it below the trigger (the default) or opens it upward — which is
 * what a control in the bottom bar needs. `className` extends the anchor
 * wrapper, for a trigger that has to fill its row rather than hug its content.
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
 * red; `disabled` dims it and swallows the click. */
export function MenuItem(props: {
  icon?: IconComponent;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
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
      onClick={() => props.onClick?.()}
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

/** Roughly how wide a submenu panel is, used to decide which side of its row it
 * opens on before it exists to be measured. */
const SUBMENU_WIDTH = 200;

/** A menu row that opens a nested panel of its own rows beside it — clicked, not
 * hovered, so it works the same under a finger as under a pointer. The panel
 * opens to the row's right, flipping to its left when the viewport hasn't room
 * (the wrench menu is near the left edge on a phone, where a right-hand flyout
 * would run off-screen).
 *
 * The nested panel deliberately doesn't wire up {@link useMenuKeyboard} of its
 * own: its rows are descendants of the parent menu's container, so the parent's
 * roving focus already walks into them in DOM order, and a second handler would
 * move the highlight twice per arrow press. The row swallows its own click so
 * opening the submenu doesn't dismiss the menu that holds it; clicks on the
 * nested rows still bubble, dismissing the whole stack as any menu row does. */
export function MenuSubmenu(props: {
  icon?: IconComponent;
  label: string;
  width?: string;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const rowRef = useRef<HTMLButtonElement>(null);
  const Icon = props.icon;

  const toggle = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const right = rowRef.current?.getBoundingClientRect().right ?? 0;
    setFlipped(right + SUBMENU_WIDTH > window.innerWidth);
    setOpen((o) => !o);
  };

  return (
    <div className="relative">
      <button
        ref={rowRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        className="text-ink focus:bg-hover flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm outline-none"
        onClick={toggle}
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
        <div
          role="menu"
          className={cx(
            "bg-panel border-edge absolute top-0 z-50 flex max-h-[60vh] flex-col gap-0.5 overflow-y-auto rounded-md border p-1 shadow-lg",
            { "left-full ml-1": !flipped, "right-full mr-1": flipped },
          )}
          style={{ minWidth: props.width ?? `${SUBMENU_WIDTH}px` }}
        >
          {props.children}
        </div>
      )}
    </div>
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
