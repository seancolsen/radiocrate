import { Icons } from "../icons";

/** A row in the "Queries" section: a saved query. Clicking it opens the query
 * as a tab. (The egui row's ⋮ options menu and inline rename are skipped this
 * phase.) */
export default function QueryRow(props: { name: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      class="hover:bg-hover flex h-[30px] w-full items-center pr-1 pl-2.5 text-left"
      onClick={() => props.onOpen()}
    >
      <Icons.Query class="text-ink-weak size-[14px] shrink-0" />
      <span class="text-ink ml-2 truncate text-sm">{props.name}</span>
    </button>
  );
}
