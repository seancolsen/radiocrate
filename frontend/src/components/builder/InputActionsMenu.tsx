import type { JSX, ReactNode } from "react";
import { Icons } from "../../icons";
import { Menu } from "../ui/Menu";
import { useTooltip } from "../ui/Tooltip";
import { NESTED_FOCUS_CLASS, cx } from "../ui/cx";

/** The ⋮ set inside a Querydown editor, at its top right, opening a menu of
 * what can be done to the text: the builder's Clear and Save as preset, a
 * field query's Restore default. It sits over the editor, so whatever holds
 * the two is `relative`, and the editor leaves it room (`trailingSpace`). */
export default function InputActionsMenu(props: {
  children: ReactNode;
}): JSX.Element {
  const menuTip = useTooltip({ label: "Input options" });
  return (
    <div className="absolute top-0.5 right-0.5">
      <Menu
        align="end"
        width="190px"
        trigger={(api) => (
          <button
            type="button"
            {...menuTip.triggerProps}
            className={cx(
              "text-ink-weak hover:text-ink flex size-[22px] items-center justify-center rounded",
              NESTED_FOCUS_CLASS,
            )}
            onClick={() => api.toggle()}
          >
            <Icons.More className="size-4" />
          </button>
        )}
      >
        {props.children}
      </Menu>
      {menuTip.tooltip}
    </div>
  );
}
