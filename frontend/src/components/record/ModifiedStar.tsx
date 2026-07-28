import { Icons } from "../../icons";

/** The red star marking something the user has changed but not yet saved. It
 * stands for everything underneath it too — a collapsed field wears the star
 * of an edit made deep inside it — so an unsaved change is never hidden by the
 * part of the tree it was made in being closed.
 *
 * Absolutely positioned over its parent's top-left corner (which must be
 * `relative`), so it never affects that parent's layout — a form row's fields
 * stay aligned whether or not any of them wears a star. */
export default function ModifiedStar(props: { label: string }) {
  return (
    <Icons.Unsaved
      class="text-danger absolute -top-1 -left-1.5 size-3.5 shrink-0"
      aria-label={`${props.label} modified`}
    />
  );
}
