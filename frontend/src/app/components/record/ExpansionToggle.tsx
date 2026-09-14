import type { JSX } from "react";
import { Icons } from "../../icons";

/** The chevron that expands or collapses a form item.
 *
 * An item that can't be expanded gets no toggle — but it still gets the toggle's
 * *space*, so every field label in the form lines up on the same left edge
 * whatever its neighbors can do.
 *
 * It is deliberately not focusable, and it doesn't take focus when clicked
 * either: it's a control *on* the item beside it, and clicking it should leave
 * the user's place in the form where it was. Ctrl+Click carries the same action
 * to every sibling item. */
export default function ExpansionToggle(props: {
  expandable: boolean;
  expanded: boolean;
  label: string;
  onToggle: (siblings: boolean) => void;
}): JSX.Element {
  if (!props.expandable) {
    return <span className="size-4 shrink-0" aria-hidden="true" />;
  }
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={`${props.expanded ? "Collapse" : "Expand"} ${props.label}`}
      aria-expanded={props.expanded}
      className="text-ink-weak hover:text-ink flex size-4 shrink-0 items-center justify-center"
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => props.onToggle(e.ctrlKey || e.metaKey)}
    >
      {props.expanded ? <Icons.ExpandOpen /> : <Icons.ExpandClosed />}
    </button>
  );
}
