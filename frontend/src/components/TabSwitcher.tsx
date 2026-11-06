import { createElement, type JSX } from "react";
import { createPortal } from "react-dom";
import { Icons } from "../icons";
import { selectIsUnsaved, selectTab } from "../stores/app";
import { useApp, useAppActions } from "../stores/react";
import { cx } from "./ui/cx";
import { tabIcon } from "./tabKind";

// The tab switcher — an overlay, like the command palette, listing the open
// tabs most recently used first while Ctrl+Tab is held. The shortcut pass
// (`stores/commands.ts`) steps its highlight and commits it when the modifier is
// released, so the overlay itself only has to draw the list and take clicks.

/** Distance from the top of the viewport to the switcher. */
const TOP_OFFSET = 72;

/** One row: the tab's icon, name and unsaved marker. Its own component, so it
 * subscribes to its own tab alone. */
function SwitcherRow(props: {
  tabId: string;
  selected: boolean;
  onChoose: () => void;
  onHover: () => void;
}): JSX.Element | null {
  const tab = useApp((s) => selectTab(s, props.tabId));
  const unsaved = useApp((s) => selectIsUnsaved(s, props.tabId));
  if (!tab) return null;
  return (
    <div
      role="option"
      aria-selected={props.selected}
      className={cx(
        "flex h-[30px] cursor-pointer items-center gap-2 rounded px-2.5",
        {
          "bg-hover": props.selected,
          "hover:bg-hover/50": !props.selected,
        },
      )}
      // Pointer *movement* re-homes the highlight, so a mouse resting over a
      // row can't fight the keys.
      onMouseMove={() => props.onHover()}
      onClick={() => props.onChoose()}
    >
      {createElement(tabIcon(tab.kind), {
        className: "text-ink-weak size-4 shrink-0",
      })}
      <span
        className={cx("min-w-0 flex-1 truncate text-[13px]", {
          "text-ink": tab.name !== "",
          "text-ink-weak italic": tab.name === "",
        })}
      >
        {tab.name || "new"}
      </span>
      {unsaved && (
        <Icons.Unsaved
          className="text-danger size-3 shrink-0"
          aria-label="Unsaved changes"
        />
      )}
    </div>
  );
}

function SwitcherDialog(props: {
  order: readonly string[];
  index: number;
}): JSX.Element {
  const actions = useAppActions();
  return (
    <div
      className="fixed inset-0 z-[110] flex items-start justify-center px-6"
      style={{ paddingTop: `${TOP_OFFSET}px` }}
    >
      <div
        className="absolute inset-0 bg-black/40"
        aria-hidden="true"
        onClick={() => actions.cancelTabSwitcher()}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Switch tab"
        data-testid="tab-switcher"
        className="bg-panel border-edge relative z-10 flex w-[360px] max-w-full flex-col rounded-lg border p-2 shadow-2xl"
      >
        <div
          role="listbox"
          aria-label="Open tabs"
          className="max-h-[320px] overflow-x-hidden overflow-y-auto"
        >
          {props.order.map((id, i) => (
            <SwitcherRow
              key={id}
              tabId={id}
              selected={i === props.index}
              onChoose={() => actions.commitTabSwitcher(i)}
              onHover={() => {
                if (i !== props.index) actions.setTabSwitcherIndex(i);
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Mounts the tab switcher overlay while it's open. */
export default function TabSwitcher(): JSX.Element | null {
  const order = useApp((s) => s.tabSwitcher?.order);
  const index = useApp((s) => s.tabSwitcher?.index ?? 0);
  if (!order) return null;
  return createPortal(
    <SwitcherDialog order={order} index={index} />,
    document.body,
  );
}
