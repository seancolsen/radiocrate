-- Custom comparisons: Querydown conditions the user names on a table, so that
-- comparing a record of `table_name` by `name` (`artist:prince`, in a filter on
-- tracks) tests the condition, with `@x` standing for the value compared. The
-- frontend builds their definitions into the prelude
-- (`#track.artist:@x = ++#artist{name:@x}`; see
-- `frontend/src/query/customComparisons.ts`).
--
--   table_name -> the table whose records are compared
--   name       -> what a filter compares them by
--   expression -> Querydown: the condition, as the user wrote it
--
-- The app defines some custom comparisons of its own, in code. A row here naming
-- one of those holds the user's condition for it, in place of the app's, and is
-- null once the user goes back to the app's. Tables are named here as text, as
-- in `metadata.computed_column`, so a comparison left behind by a dropped table
-- is simply never defined.

create table metadata.custom_comparison (
  table_name text not null,
  name text not null,
  expression text,
  primary key (table_name, name)
);
