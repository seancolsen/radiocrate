import type { JSX } from "react";
import { Icons } from "../../icons";
import { DEFAULT_COMPUTED_COLUMN_NAME } from "../../query/computedColumns";
import { LabelNameInput, type RenameEnd } from "./FieldLabel";

/** A computed column being added — not a field yet, but what makes one: its
 * name, being typed where its label will be. Settling on the name (`onName`)
 * is what turns this into the column's field; Escape drops it, and so does
 * leaving it without having typed anything.
 *
 * Whoever shows it decides what a name makes: the record editor's form, among
 * a record's fields, and the Data structure page, among a table's. */
export default function ProvisionalComputedRow(props: {
  /** The name was settled on: the column can be made. */
  onName: (name: string, end: RenameEnd) => void;
  onDiscard: () => void;
}): JSX.Element {
  return (
    <div
      className="flex min-h-[30px] items-center gap-1 py-0.5"
      data-testid="provisional-computed"
    >
      <span className="size-4 shrink-0" aria-hidden="true" />
      <span className="text-ink bg-field-computed flex shrink-0 cursor-default items-center gap-1 rounded-md border-2 border-transparent px-1.5 py-px text-xs/5 select-none">
        <Icons.FieldComputed className="size-3.5 shrink-0 opacity-70" />
        <LabelNameInput
          label="Name of the new computed column"
          name={DEFAULT_COMPUTED_COLUMN_NAME}
          rename={{
            onCommit: (name, end) => {
              // Focus going elsewhere with the name as it was offered is the
              // user thinking better of it, not naming it that.
              if (end === "blur" && name === DEFAULT_COMPUTED_COLUMN_NAME) {
                props.onDiscard();
              } else {
                props.onName(name, end);
              }
            },
            onCancel: () => props.onDiscard(),
          }}
        />
      </span>
    </div>
  );
}
