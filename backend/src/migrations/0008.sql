-- Drop the unused soft-delete machinery: the `deletion` table and `file.deletion`.
--
-- Nothing ever read them apart from the scanner, which stamped a file as deleted
-- when it vanished from disk. Any data in them is discarded.

alter table file drop column deletion;
drop table deletion;
