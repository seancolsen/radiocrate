import { useId, useRef, type JSX } from "react";
import { Icons } from "../../icons";
import { listableTables } from "../../query/contextualQuery";
import { useApp } from "../../stores/react";
import IconButton from "../ui/IconButton";
import { cx } from "../ui/cx";
import { LabelNameInput } from "./FieldLabel";

/** The classes of a `<select>`, as every one in the app has them. */
const SELECT =
  "control bg-panel border-edge text-ink focus:border-accent h-[26px] rounded-md py-0 outline-none";

/** A contextual query being added — not a field yet, but what makes one: a name,
 * being typed as it appears, and the table the query is to list, chosen from the
 * Base selector beside it (`onChoose`), which is what turns this into the query's
 * field. Escape while it's being named, or the ×, drops it.
 *
 * Whoever shows it holds its name and whether that's being typed: the record
 * editor's form, among a record's fields, and the Data structure page, among a
 * table's. */
export default function ProvisionalQueryRow(props: {
  name: string;
  /** Whether the name is being typed. */
  naming: boolean;
  onName: (name: string) => void;
  onNaming: (naming: boolean) => void;
  /** The table to list was chosen: the query can be made. */
  onChoose: (base: string) => void;
  onDiscard: () => void;
}): JSX.Element {
  const { name } = props;
  const tables = useApp((s) => s.schema.tables);
  const selectRef = useRef<HTMLSelectElement>(null);
  const selectId = useId();

  return (
    <div
      className="flex min-h-[30px] items-center gap-1 py-0.5"
      data-testid="provisional-query"
    >
      <span className="size-4 shrink-0" aria-hidden="true" />
      <span
        className="text-ink bg-field-query flex shrink-0 cursor-default items-center gap-1 rounded-md border-2 border-transparent px-1.5 py-px text-xs/5 select-none"
        onDoubleClick={() => props.onNaming(true)}
      >
        <Icons.FieldQuery className="size-3.5 shrink-0 opacity-70" />
        {props.naming ? (
          <LabelNameInput
            label="Name of the new query"
            name={name}
            rename={{
              onCommit: (next, end) => {
                props.onName(next.trim() || name);
                props.onNaming(false);
                // Named, it wants a table to list next.
                if (end === "enter" || end === "tab") {
                  queueMicrotask(() => selectRef.current?.focus());
                }
              },
              onCancel: () => props.onDiscard(),
            }}
          />
        ) : (
          <span className="max-w-40 truncate">{name}</span>
        )}
      </span>
      <label
        htmlFor={selectId}
        className="text-ink-weak flex shrink-0 items-center gap-0.5 pl-1 text-xs"
      >
        <Icons.Base className="size-4" />
        Base
      </label>
      <select
        ref={selectRef}
        id={selectId}
        className={cx(SELECT, "min-w-0 flex-1")}
        value=""
        onChange={(e) => {
          if (e.currentTarget.value !== "")
            props.onChoose(e.currentTarget.value);
        }}
      >
        <option value="" disabled>
          Choose a table…
        </option>
        {listableTables(tables).map((table) => (
          <option key={table.name} value={table.name}>
            {table.name}
          </option>
        ))}
      </select>
      <IconButton
        icon={Icons.Close}
        label="Discard new query"
        size="sm"
        onClick={() => props.onDiscard()}
      />
    </div>
  );
}
