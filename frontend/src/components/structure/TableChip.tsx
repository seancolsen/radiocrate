import type { JSX } from "react";
import { Icons } from "../../icons";

/** A table's name and icon, in a chip tinted as a field listing records is
 * (`bg-field-records`): what stands for the table on its row of the Data
 * structure page. */
export default function TableChip(props: { table: string }): JSX.Element {
  return (
    <span className="text-ink bg-field-records flex min-w-0 items-center gap-1 rounded-md border-2 border-transparent px-1.5 py-px text-xs/5">
      <Icons.Table className="size-3.5 shrink-0 opacity-70" />
      <span className="min-w-0 truncate">{props.table}</span>
    </span>
  );
}
