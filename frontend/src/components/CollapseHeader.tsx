import type { JSX, ReactNode } from "react";
import { Icons } from "../icons";

/** A collapsible section heading (chevron + title) spanning the sidebar width,
 * toggling the section when clicked. `children` are controls set at the right
 * edge (the Queries section's filter, "+" and refresh buttons); clicking one
 * doesn't toggle the section. */
export default function CollapseHeader(props: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className="hover:bg-hover flex h-7 items-center pr-0.5">
      <button
        type="button"
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-2.5 text-left"
        onClick={() => props.onToggle()}
      >
        <span className="text-ink-weak flex size-[18px] items-center justify-center">
          {props.collapsed ? <Icons.ExpandClosed /> : <Icons.ExpandOpen />}
        </span>
        <span className="text-ink text-base">{props.title}</span>
      </button>
      {props.children}
    </div>
  );
}
