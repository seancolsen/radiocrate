-- Folders and a manual order for saved queries.
--
-- The explorer shows saved queries as a tree the user arranges by hand, so a
-- query no longer sorts by `created_at`: it sits in a folder (or at the top
-- level) at an explicit position among its siblings. Folders and queries share
-- one sibling order, so both carry the same pair of columns:
--
--   parent   -> the containing `query_folder`'s id, or null at the top level
--   position -> the sort key among everything with the same `parent`
--
-- Positions only need to order siblings: they may be negative (a new item goes
-- in above the current first one), and gaps mean nothing. The frontend authors
-- both columns, as it does the timestamps. A `parent` naming no folder reads as
-- the top level.
--
-- Following `0003`'s rule, the schema changes come before the backfill.

create table query_folder (
  id uuid primary key,
  name text not null,
  parent uuid,
  position integer not null default 0
);

alter table query add column parent uuid;
alter table query add column position integer default 0;

-- Keep the order the explorer showed until now: newest first.
update query
set position = ordered.position
from (
  select id, (row_number() over (order by created_at desc, id) - 1)::integer as position
  from query
) ordered
where query.id = ordered.id;
