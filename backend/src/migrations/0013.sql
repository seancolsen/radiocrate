-- What the user has customized about each table as a whole, as `metadata.field` is
-- for each field of one. A table with no row here behaves as if this table didn't
-- exist, and only what a row customizes differs from the default. Tables are named
-- as text rather than referenced, so a row left behind by a dropped table is simply
-- never read.
--
--   table_name               -> the table the row is about
--   visible                  -> false hides the table from the app's lists of tables
--                               (the Data structure page, a query's base table)
--   order                    -> the table's sort key in those lists, a double so
--                               that moving a table can land between two others
--                               without rewriting them; null until the tables are
--                               first rearranged
--   default_text_search      -> Querydown: the condition a bare string searches the
--                               table's records with, `@x` standing for the string
--   linked_record_comparison -> Querydown: the condition a link to the table
--                               compares a linked record with, `@x` standing for
--                               the value compared
--   record_picker_sorting    -> Querydown: the sorting section of the record
--                               picker's query on the table
--   record_picker_display    -> Querydown: its display section
--
-- Every Querydown column holds the user's text as they wrote it, and is null while
-- the table goes by the app's default. The frontend builds the definitions of the
-- first two into the prelude (see `frontend/src/query/tableSettings.ts`), where an
-- empty string reads as null too.

create table metadata."table" (
  table_name text primary key,
  visible boolean not null default true,
  "order" double,
  default_text_search text,
  linked_record_comparison text,
  record_picker_sorting text,
  record_picker_display text
);
