import {
  createSignal,
  onCleanup,
  onMount,
  Show,
  type Component,
  type JSX,
} from "solid-js";
import { Icons } from "../../icons";
import { useMenuKeyboard } from "./menuKeyboard";

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
  children: JSX.Element;
}): JSX.Element {
  let content: HTMLDivElement | undefined;
  useMenuKeyboard(
    () => content,
    () => props.close(),
  );
  return (
    <div
      ref={(el) => (content = el)}
      role="menu"
      class="bg-panel border-edge absolute z-50 flex flex-col gap-0.5 rounded-md border p-1 shadow-lg"
      classList={{
        "left-0": props.align === "start",
        "right-0": props.align === "end",
        "top-full mt-1": props.side === "below",
        "bottom-full mb-1": props.side === "above",
      }}
      style={{ "min-width": props.width ?? "190px" }}
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
 * what a control in the bottom bar needs. `class` extends the anchor wrapper, for
 * a trigger that has to fill its row rather than hug its content. */
export function Menu(props: {
  trigger: (api: MenuApi) => JSX.Element;
  children: JSX.Element;
  align?: "start" | "end";
  side?: "below" | "above";
  width?: string;
  class?: string;
}): JSX.Element {
  const [open, setOpen] = createSignal(false);
  let wrapper: HTMLDivElement | undefined;
  const close = () => setOpen(false);

  onMount(() => {
    const onDown = (e: PointerEvent) => {
      if (!wrapper?.contains(e.target as Node)) close();
    };
    document.addEventListener("pointerdown", onDown);
    onCleanup(() => document.removeEventListener("pointerdown", onDown));
  });

  return (
    <div
      ref={(el) => (wrapper = el)}
      class={`relative inline-flex ${props.class ?? ""}`}
    >
      {props.trigger({
        get open() {
          return open();
        },
        toggle: () => setOpen((o) => !o),
        close,
      })}
      <Show when={open()}>
        <MenuPanel
          close={close}
          align={props.align ?? "start"}
          side={props.side ?? "below"}
          width={props.width}
        >
          {props.children}
        </MenuPanel>
      </Show>
    </div>
  );
}

/** A plain, clickable menu row: optional leading icon + label. `danger` tints it
 * red; `disabled` dims it and swallows the click. */
export function MenuItem(props: {
  icon?: Component<{ class?: string }>;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={props.disabled}
      class="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm outline-none"
      classList={{
        "text-ink focus:bg-hover": !props.disabled && !props.danger,
        "text-danger focus:bg-hover": !props.disabled && props.danger,
        "text-ink-weak/40": props.disabled,
      }}
      onClick={() => props.onClick?.()}
    >
      <Show when={props.icon}>
        {(icon) => (
          <span class="text-ink-weak flex size-4 shrink-0 items-center justify-center">
            {icon()({ class: "size-4" })}
          </span>
        )}
      </Show>
      <span class="min-w-0 flex-1 truncate">{props.label}</span>
    </button>
  );
}

/** A menu row carrying a checkbox (independent toggle) or radio (exclusive)
 * indicator, then the section icon and label — the shared shape of a section's
 * options-menu rows. */
export function MenuToggleItem(props: {
  kind: "checkbox" | "radio";
  icon: Component<{ class?: string }>;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onClick?: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role={props.kind === "checkbox" ? "menuitemcheckbox" : "menuitemradio"}
      aria-checked={props.checked}
      disabled={props.disabled}
      class="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm outline-none"
      classList={{
        "text-ink focus:bg-hover": !props.disabled,
        "text-ink-weak/40": props.disabled,
      }}
      onClick={() => props.onClick?.()}
    >
      <span
        class="border-ink-weak flex size-4 shrink-0 items-center justify-center border"
        classList={{
          "rounded-sm": props.kind === "checkbox",
          "rounded-full": props.kind === "radio",
          "bg-accent border-accent": props.checked,
        }}
      >
        <Show when={props.checked}>
          <span
            class="bg-panel"
            classList={{
              "size-2 rounded-full": props.kind === "radio",
              "size-1.5 rounded-[1px]": props.kind === "checkbox",
            }}
          />
        </Show>
      </span>
      <span class="text-ink-weak flex size-4 shrink-0 items-center justify-center">
        {props.icon({ class: "size-4" })}
      </span>
      <span class="min-w-0 flex-1 truncate">{props.label}</span>
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
  icon?: Component<{ class?: string }>;
  label: string;
  width?: string;
  children: JSX.Element;
}): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [flipped, setFlipped] = createSignal(false);
  let row: HTMLButtonElement | undefined;

  const toggle = (e: MouseEvent) => {
    e.stopPropagation();
    const right = row?.getBoundingClientRect().right ?? 0;
    setFlipped(right + SUBMENU_WIDTH > window.innerWidth);
    setOpen((o) => !o);
  };

  return (
    <div class="relative">
      <button
        ref={(el) => (row = el)}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open()}
        class="text-ink focus:bg-hover flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm outline-none"
        onClick={toggle}
      >
        <Show when={props.icon}>
          {(icon) => (
            <span class="text-ink-weak flex size-4 shrink-0 items-center justify-center">
              {icon()({ class: "size-4" })}
            </span>
          )}
        </Show>
        <span class="min-w-0 flex-1 truncate">{props.label}</span>
        <Icons.ExpandClosed class="text-ink-weak size-4 shrink-0" />
      </button>
      <Show when={open()}>
        <div
          role="menu"
          class="bg-panel border-edge absolute top-0 z-50 flex max-h-[60vh] flex-col gap-0.5 overflow-y-auto rounded-md border p-1 shadow-lg"
          classList={{
            "left-full ml-1": !flipped(),
            "right-full mr-1": flipped(),
          }}
          style={{ "min-width": props.width ?? `${SUBMENU_WIDTH}px` }}
        >
          {props.children}
        </div>
      </Show>
    </div>
  );
}

/** A small all-caps category heading inside an options menu. */
export function MenuHeading(props: { text: string }): JSX.Element {
  return (
    <div class="text-ink-weak px-2 pt-1.5 pb-0.5 text-[10px] font-semibold tracking-wide">
      {props.text}
    </div>
  );
}

/** A non-interactive line of explanatory text inside a menu — what stands in for
 * rows that aren't there yet (an empty list, a schema still loading). Carries no
 * `menuitem` role, so the keyboard walks straight past it. */
export function MenuNote(props: { text: string }): JSX.Element {
  return <div class="text-ink-weak px-2 py-1 text-sm">{props.text}</div>;
}

/** A hairline separator between menu groups. */
export function MenuSeparator(): JSX.Element {
  return <div class="border-edge my-1 border-t" />;
}
