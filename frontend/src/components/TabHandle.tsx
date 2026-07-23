import { Icons } from "../icons";

/** One tab handle: query icon, name (ellipsis when crowded), and a close ×.
 * Only the top corners are rounded so it sits flush with the content below.
 *  - Active: filled with the content-panel color + a 4px accent-blue top edge,
 *    name at full-strength text.
 *  - Inactive: bar-colored (darker on hover), icon + name dimmed. */
export default function TabHandle(props: {
  id: string;
  name: string;
  active: boolean;
  dragging: boolean;
  translate: number;
  onSelect: () => void;
  onClose: () => void;
  onPointerDown: (e: PointerEvent) => void;
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
    >
      {/* 4px accent top edge on the active handle. */}
      <div
        class="bg-accent absolute top-0 right-0 left-0 h-1 rounded-t"
        classList={{ hidden: !props.active }}
      />
      {/* Active handle: icon stays the default gray while the name goes full-strength. */}
      <Icons.Query
        class={
          props.active ? "text-ink-weak size-4 shrink-0" : "size-4 shrink-0"
        }
      />
      <span class="min-w-0 flex-1 truncate text-sm">{props.name}</span>
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
