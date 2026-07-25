import { Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Icons } from "../icons";

/** One tab handle: the page kind's icon, the name (ellipsis when crowded), an
 * unsaved-changes ✱ marker, and a close ×. Only the top corners are rounded so it
 * sits flush with the content below.
 *  - Active: filled with the content-panel color + a 4px accent-blue top edge,
 *    name at full-strength text.
 *  - Inactive: bar-colored (darker on hover), icon + name dimmed.
 *
 * `renameable` is what a non-query page turns off: a settings tab's handle text
 * is fixed, so double-clicking it does nothing (the query-only affordances
 * stand down for a non-query `TabKind`). A query tab double-click starts an
 * inline rename, replacing the name with a text field. */
export default function TabHandle(props: {
  id: string;
  name: string;
  icon: Component<{ class?: string }>;
  active: boolean;
  unsaved: boolean;
  renameable: boolean;
  dragging: boolean;
  translate: number;
  renaming: boolean;
  renameBuffer: string;
  onSelect: () => void;
  onClose: () => void;
  onPointerDown: (e: PointerEvent) => void;
  onRenameStart: () => void;
  onRenameInput: (text: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
}) {
  return (
    <div
      data-tab-id={props.id}
      class="border-edge relative flex h-full max-w-[220px] min-w-0 shrink items-center gap-[5px] rounded-t border-r pr-1.5 pl-2 select-none"
      classList={{
        "bg-panel text-ink": props.active,
        "bg-bar text-ink-weak hover:bg-hover": !props.active,
        "z-10 shadow-sm": props.dragging,
      }}
      style={{
        transform: props.dragging
          ? `translateX(${props.translate}px)`
          : undefined,
        transition: props.dragging ? "none" : undefined,
      }}
      onPointerDown={(e) => props.onPointerDown(e)}
      onClick={() => props.onSelect()}
      onDblClick={() => props.renameable && props.onRenameStart()}
    >
      {/* 4px accent top edge on the active handle. */}
      <div
        class="bg-accent absolute top-0 right-0 left-0 h-1 rounded-t"
        classList={{ hidden: !props.active }}
      />
      {/* Active handle: icon stays the default gray while the name goes full-strength. */}
      <Dynamic
        component={props.icon}
        class={
          props.active ? "text-ink-weak size-4 shrink-0" : "size-4 shrink-0"
        }
      />
      <Show
        when={props.renaming}
        fallback={
          <>
            <span class="min-w-0 flex-1 truncate text-sm">{props.name}</span>
            <Show when={props.unsaved}>
              <Icons.Unsaved
                class="text-danger size-3 shrink-0"
                aria-label="Unsaved changes"
              />
            </Show>
          </>
        }
      >
        <input
          type="text"
          ref={(el) =>
            queueMicrotask(() => {
              el.focus();
              el.select();
            })
          }
          class="border-edge bg-panel text-ink focus:border-accent min-w-0 flex-1 rounded border px-1 py-0.5 text-sm outline-none"
          value={props.renameBuffer}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onDblClick={(e) => e.stopPropagation()}
          onInput={(e) => props.onRenameInput(e.currentTarget.value)}
          onBlur={() => props.onRenameCommit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              props.onRenameCommit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              props.onRenameCancel();
            }
          }}
        />
      </Show>
      <button
        type="button"
        aria-label={`Close ${props.name}`}
        class="hover:bg-hover flex size-[18px] shrink-0 items-center justify-center rounded"
        onClick={(e) => {
          e.stopPropagation();
          props.onClose();
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <Icons.Close class="size-[15px]" />
      </button>
    </div>
  );
}
