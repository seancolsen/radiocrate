import { untrack } from "solid-js";
import { createRecordForm, ROOT_ID } from "./formModel";
import RecordNodeView from "./RecordFields";
import type { SchemaTable } from "../../query/schema";
import type { KeyPart } from "../../query/recordForm";

/** The record editor form for one record: the whole field tree, built from
 * introspection and filled in as its data arrives.
 *
 * One instance belongs to one record — the model it creates on mount starts the
 * load, and the expansion/edit state it accumulates is that record's. Pointing
 * the sidebar at a different record replaces the instance (the panel keys it),
 * rather than resetting this one. */
export default function RecordForm(props: {
  tables: readonly SchemaTable[];
  schemaJson: string;
  table: string;
  recordKey: readonly KeyPart[];
}) {
  // These props are this instance's subject, fixed for its life — a different
  // record means a different instance — so they're read once, untracked.
  const model = untrack(() =>
    createRecordForm({
      tables: props.tables,
      table: props.table,
      key: props.recordKey,
      schemaJson: props.schemaJson,
    }),
  );

  return <RecordNodeView model={model} recordId={ROOT_ID} />;
}
