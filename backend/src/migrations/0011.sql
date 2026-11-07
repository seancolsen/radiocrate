-- Let the user customize the embedded records a field of the record editor shows.
-- Both columns hold raw Querydown, as the user wrote it, and are null while the
-- field goes by what the form generates from the schema (see
-- `frontend/src/query/embeddedRecord.ts`):
--
--   display -> the display section of the query behind the field's embedded records
--   sorting -> the sorting section of it, which only a `multi_link` field has any
--              use for: a `column_name` field's embedded record is a single record
--
-- The expression index on this table doesn't stop it gaining columns.

alter table metadata.field add column display text;
alter table metadata.field add column sorting text;
