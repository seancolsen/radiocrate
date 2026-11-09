import type { JSX } from "react";
import { Icons } from "../icons";
import { useApp } from "../stores/react";

/** A confirmation, as the toast shows it: a check and a line of text. Kept
 * apart from {@link ToastHost} so the kitchen sink can show one without a
 * store. Styled as the drag chip is, since the one often follows the other
 * ("3 tracks" in hand, then "Added 3 tracks to …"). */
export function ToastCard(props: { text: string }): JSX.Element {
  return (
    <div className="control bg-accent text-panel flex max-w-full min-w-0 items-center gap-1.5 rounded-md px-3 shadow-md">
      <Icons.Check className="size-4 shrink-0" />
      <span className="truncate">{props.text}</span>
    </div>
  );
}

/** Where the store's confirmation toast shows (`AppState.toast`): floating,
 * centered, over the foot of the page, just above whatever bars sit below it.
 * The host has no height, so it takes no room from the page, and the toast
 * takes no pointer input, so it never covers a row the user is about to click.
 * The live region is always there, so a screen reader hears each toast as it
 * arrives; the store takes it away again after a few seconds. */
export default function ToastHost(): JSX.Element {
  const toast = useApp((s) => s.toast);
  return (
    <div role="status" className="pointer-events-none relative z-40 h-0">
      {toast && (
        <div
          key={toast.seq}
          data-testid="toast"
          className="absolute inset-x-4 bottom-3 flex justify-center"
        >
          <ToastCard text={toast.text} />
        </div>
      )}
    </div>
  );
}
