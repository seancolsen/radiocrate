import {
  createSignal,
  onCleanup,
  onMount,
  Show,
  type Component,
  type JSX,
} from "solid-js";

/** The interaction handle a {@link Menu} hands its trigger. */
export interface MenuApi {
  open: boolean;
  toggle: () => void;
  close: () => void;
}

/** A lightweight dropdown menu anchored under its trigger. Owns open/close
 * state, closes on outside pointerdown, on Escape, and on any click inside the
 * content (matching egui, where clicking any row dismisses the popup). Positions
 * with plain absolute layout relative to the trigger — adequate for the toolbar,
 * whose menus always drop downward.
 *
 * `trigger` renders the clickable anchor (given the {@link MenuApi}); `align`
 * pins the content to the trigger's left (`start`) or right (`end`) edge. */
export function Menu(props: {
  trigger: (api: MenuApi) => JSX.Element;
  children: JSX.Element;
  align?: "start" | "end";
  width?: string;
}): JSX.Element {
  const [open, setOpen] = createSignal(false);
  let wrapper: HTMLDivElement | undefined;
  const close = () => setOpen(false);

  onMount(() => {
    const onDown = (e: PointerEvent) => {
      if (!wrapper?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    });
  });

  return (
    <div ref={(el) => (wrapper = el)} class="relative inline-flex">
      {props.trigger({
        get open() {
          return open();
        },
        toggle: () => setOpen((o) => !o),
        close,
      })}
      <Show when={open()}>
        <div
          role="menu"
          class="bg-panel border-edge absolute top-full z-50 mt-1 flex flex-col gap-0.5 rounded-md border p-1 shadow-lg"
          classList={{
            "left-0": (props.align ?? "start") === "start",
            "right-0": props.align === "end",
          }}
          style={{ "min-width": props.width ?? "190px" }}
          onClick={() => close()}
        >
          {props.children}
        </div>
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
      class="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm"
      classList={{
        "text-ink hover:bg-hover": !props.disabled && !props.danger,
        "text-danger hover:bg-hover": !props.disabled && props.danger,
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
 * options-menu rows (`builder.rs:toggle_menu_item`). */
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
      class="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm"
      classList={{
        "text-ink hover:bg-hover": !props.disabled,
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

/** A small all-caps category heading inside an options menu. */
export function MenuHeading(props: { text: string }): JSX.Element {
  return (
    <div class="text-ink-weak px-2 pt-1.5 pb-0.5 text-[10px] font-semibold tracking-wide">
      {props.text}
    </div>
  );
}

/** A hairline separator between menu groups. */
export function MenuSeparator(): JSX.Element {
  return <div class="border-edge my-1 border-t" />;
}
