import { Icons } from "../icons";

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
