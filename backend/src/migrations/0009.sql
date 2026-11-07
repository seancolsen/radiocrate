-- User-defined metadata about the database's own structure.
--
-- `metadata` is a schema of its own, apart from `meta` (which tracks migrations)
-- and `settings` (which holds app preferences). Introspection only reads `main`,
-- so nothing here reaches the Querydown compiler or the `dml` API.
--
-- A `column` row customizes one field of a table's record editor form, and only
-- what it customizes differs from the default: a table with no rows here behaves
-- as if this table didn't exist. Tables and columns can be user-defined, and are
-- named here as text rather than referenced, so a row left behind by a dropped
-- column is simply never read.
--
--   table   -> the table the field belongs to
--   column  -> the column the field stands for, or `#<table>` for the field
--              listing the records of <table> that reference this one
--   visible -> false hides the field from the form
--   order   -> the field's sort key in the form, a double so that moving a field
--              can land between two others without rewriting them; null until
--              the table's fields are first rearranged

create schema metadata;

create table metadata."column" (
  "table" text not null,
  "column" text not null,
  visible boolean not null default true,
  "order" double,
  unique ("table", "column")
);
