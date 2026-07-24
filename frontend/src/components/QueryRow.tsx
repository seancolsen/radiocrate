import { Icons } from "../icons";

/** A row in the "Queries" section: a saved query. Clicking opens it. Unlike the
 * Opened rows, saved-query rows never show the unsaved (✱) marker — that state
 * belongs to open tabs, not the saved catalog. */
export default function QueryRow(props: { name: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      class="hover:bg-hover flex w-full items-center px-2 py-1 text-left"
      onClick={() => props.onOpen()}
    >
      <Icons.Query class="text-ink-weak size-[14px] shrink-0" />
      <span class="text-ink ml-1 truncate text-sm">{props.name}</span>
    </button>
  );
}
