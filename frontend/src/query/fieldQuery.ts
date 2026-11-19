// The query behind a field, as its editor sees it: which sections of it the
// user can write, and where each is kept. A contextual query is a whole query
// of the user's; a related-records or linked-record field's query is the
// form's, and what the user writes for it is only its embedded records'
// sorting and display, kept in the field's metadata.
//
// Pure, like the rest of `query/`: the record editor and the Data structure
// page both open the one editor over these (`FieldQueryEditor`).

import { SECTIONS, type Section } from "./definition";
import type { EmbedSection } from "./fieldMetadata";
import type {
  ContextQueryField,
  FormField,
  MultiRecordField,
  ScalarLinkField,
} from "./recordForm";

/** A field with a query behind it to edit. */
export type QueryEditorField =
  ContextQueryField | MultiRecordField | ScalarLinkField;

/** The part of a field's metadata each section of its embedded records' query
 * is kept in. */
export const EMBED_PARTS: Record<"sort" | "display", EmbedSection> = {
  sort: "sorting",
  display: "display",
};

/** The sections of a field's query its editor offers, in the query builder's
 * order:
 *
 * - a contextual query: all three;
 * - a related-records field: its sorting and display — which records it lists
 *   is what the field is — but no sorting for records kept in an order of the
 *   user's own, and nothing at all for a table whose records can't be told
 *   apart (they're counted, not listed);
 * - a linked-record field: its one record's display. */
export function queryEditorSections(field: FormField): readonly Section[] {
  switch (field.kind) {
    case "contextQuery":
      return SECTIONS;
    case "multiRecord":
      if (field.keyColumns.length === 0) return [];
      return field.ordered ? DISPLAY_ONLY : SORT_AND_DISPLAY;
    case "scalarLink":
      return DISPLAY_ONLY;
    default:
      return [];
  }
}

const DISPLAY_ONLY: readonly Section[] = ["display"];
const SORT_AND_DISPLAY: readonly Section[] = ["sort", "display"];

/** Whether a field has a query behind it for the user to edit. */
export function hasQueryEditor(field: FormField): field is QueryEditorField {
  return queryEditorSections(field).length > 0;
}
