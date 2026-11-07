-- Replace `metadata.column` with `metadata.field`, which says what kind of field a
-- row is about rather than packing it into one string. Not every field of a record
-- editor form is a column, and `#credit` left a column's name and a link's sharing
-- one namespace, with no room for the column the link goes through. Rows in the old
-- table are discarded: it never shipped.
--
-- A row customizes one field of a table's record editor form, and only what it
-- customizes differs from the default: a table with no rows here behaves as if this
-- table didn't exist. Tables and columns can be user-defined, and are named here as
-- text rather than referenced, so a row left behind by a dropped column is simply
-- never read.
--
--   table_name -> the table whose form the field belongs to
--   field      -> which field it is: `column_name`, the column it stands for, or
--                 `multi_link`, for the field listing the records of
--                 `related_table_name` that reference this one through their
--                 `fk_column_name`
--   visible    -> false hides the field from the form
--   order      -> the field's sort key in the form, a double so that moving a field
--                 can land between two others without rewriting them; null until
--                 the table's fields are first rearranged
--
-- DuckDB can't index a UNION or a STRUCT, which rules out a UNIQUE constraint on
-- (table_name, field), so the unique index below keys on the field's text instead.
-- The tag keeps a column from colliding with a link whose text matches its name. An
-- upsert can't name these expressions as its conflict target, so upserts here say
-- `on conflict do update` without one, which relies on this being the table's only
-- unique index.

drop table metadata."column";

create table metadata.field (
  table_name text not null,
  field union(
    column_name text,
    multi_link struct(
      related_table_name text,
      fk_column_name text
    )
  ) not null,
  visible boolean not null default true,
  "order" double
);

create unique index field_key on metadata.field (
  table_name,
  (union_tag(field)::text),
  (field::text)
);
