"""Rewrite a database's minted ids into reproducible ones.

The scanner and the migrations mint random UUIDs, so two builds of the same
collection agree on everything but their ids — and a sort whose keys tie falls
back to physical order or to an id, both of which then differ between builds.
This pass replaces every minted id with a UUIDv5 of its table and its rank
among the table's rows, ranked by their other column values, and lays every
table it touches out again in that order. Two builds of the same inputs then
come out identical, ids and physical order included.

Tables are walked parents-first along the links in `metadata.relationship`
(the only place links are declared), so a row's references are already
rewritten when it's ranked, and its rank is a function of content alone. A
self-link (a folder's parent) is walked level by level, roots first.

An id that a migration writes literally (0003's roles and ratings, 0020's
presets, queries and contextual queries, …) is already stable and may be
referred to by that literal elsewhere, so it is kept as it is.

Each table is rebuilt by copying its rows aside, deleting them and inserting
them back rewritten and in rank order, all in one transaction. That leaves the
table's definition — constraints, defaults, indexes — untouched, where a
CREATE TABLE … AS would lose it, and gives the table a reproducible physical
order, where an UPDATE would keep the scan's.

This is a plain module rather than a uv script, and so has no dependencies of
its own beyond the connection it's handed.
"""

import re
import sys
import uuid
from collections import defaultdict
from pathlib import Path

# Arbitrary, and fixed for good: changing it changes every rewritten id.
NAMESPACE = uuid.UUID("5c1e0a3e-7d2b-4f1a-9b8e-2f6c4d1a7e90")

UUID_PATTERN = re.compile(r"[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}")


def quote(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def table_ref(schema: str, table: str) -> str:
    return f"{quote(schema)}.{quote(table)}"


def fixed_ids(migrations_dir: Path) -> set[str]:
    """Every UUID a migration spells out literally."""
    return {
        match.lower()
        for path in sorted(migrations_dir.glob("*.sql"))
        for match in UUID_PATTERN.findall(path.read_text())
    }


def stabilize_ids(conn, migrations_dir: Path) -> None:
    """Rewrite the minted ids of every table with a UUID primary key."""
    tables = [
        tuple(row)
        for row in conn.execute("""
            select schema_name, table_name from duckdb_tables()
            where database_name = current_database() and not temporary and not internal
            order by schema_name, table_name
        """).fetchall()
    ]
    columns: dict[tuple, list[tuple[str, str]]] = defaultdict(list)
    for schema, table, column, data_type in conn.execute("""
        select schema_name, table_name, column_name, data_type from duckdb_columns()
        where database_name = current_database() and not internal
        order by schema_name, table_name, column_index
    """).fetchall():
        columns[(schema, table)].append((column, data_type))

    # Tables keyed by a single UUID column: the ones whose ids get rewritten.
    keys: dict[tuple, str] = {}
    for schema, table, names in conn.execute("""
        select schema_name, table_name, constraint_column_names from duckdb_constraints()
        where database_name = current_database() and constraint_type = 'PRIMARY KEY'
    """).fetchall():
        types = dict(columns[(schema, table)])
        if len(names) == 1 and types.get(names[0]) == "UUID":
            keys[(schema, table)] = names[0]

    # (schema, table) -> [(column, target)], for links into a keyed table.
    links: dict[tuple, list[tuple[str, tuple]]] = defaultdict(list)
    for schema, table, column, target_schema, target_table in conn.execute("""
        select schema_name, table_name, column_name, target_schema_name, target_table_name
        from metadata.relationship
        order by all
    """).fetchall():
        target = (target_schema, target_table)
        if (schema, table) in columns and target in keys:
            links[(schema, table)].append((column, target))

    conn.execute("begin transaction")
    conn.execute("create temp table stable_id (old uuid primary key, new uuid not null)")
    conn.execute("create temp table fixed_id (id uuid primary key)")
    conn.executemany("insert into fixed_id values (?)", [(i,) for i in fixed_ids(migrations_dir)])

    orphans_before = count_orphans(conn, links, keys)

    for key in parents_first(keys, links):
        assign_ids(conn, key, keys[key], columns[key], links[key])

    rewritten = conn.execute("select count(*) from stable_id").fetchone()[0]
    check_no_other_mentions(conn, tables, columns, keys, links)

    touched = 0
    for key in tables:
        if rewrite_table(conn, key, keys.get(key), columns[key], links[key]):
            touched += 1

    orphans_after = count_orphans(conn, links, keys)
    if orphans_after != orphans_before:
        conn.execute("rollback")
        sys.exit(
            "Error: rewriting ids changed which links resolve:\n"
            f"  before: {orphans_before}\n  after:  {orphans_after}"
        )

    conn.execute("drop table stable_id")
    conn.execute("drop table fixed_id")
    conn.execute("commit")
    # Reclaims the deleted copies, so the file holds only the rewritten rows.
    conn.execute("checkpoint")
    print(f"  Rewrote {rewritten} ids reproducibly, across {touched} tables")


def parents_first(keys: dict, links: dict) -> list[tuple]:
    """The keyed tables, each after every other keyed table it links to."""
    remaining = {key: {target for _, target in links[key] if target != key} for key in sorted(keys)}
    order = []
    while remaining:
        ready = sorted(key for key, deps in remaining.items() if not deps & remaining.keys())
        if not ready:
            sys.exit(f"Error: the links between {sorted(remaining)} form a cycle")
        order.extend(ready)
        for key in ready:
            del remaining[key]
    return order


def mapped(alias: str, column: str) -> str:
    """A link or key column as it reads once its target's ids are rewritten."""
    return f"coalesce({alias}.new, t.{quote(column)})"


def joins(link_columns: list[str]) -> str:
    return " ".join(
        f"left join stable_id m{i} on m{i}.old = t.{quote(column)}"
        for i, column in enumerate(link_columns)
    )


def assign_ids(conn, key: tuple, pk: str, cols: list, table_links: list) -> None:
    """Rank one table's minted ids and record a stable id for each.

    Rows are ranked by every column but the key, with links already rewritten.
    A self-linked table is ranked a level at a time, so that a row is ranked
    only once the row it hangs from has its stable id.
    """
    link_columns = [column for column, _ in table_links]
    self_links = [column for column, target in table_links if target == key]
    sort_keys = []
    for column, _ in cols:
        if column == pk:
            continue
        if column in link_columns:
            sort_keys.append(mapped(f"m{link_columns.index(column)}", column))
        else:
            sort_keys.append(f"t.{quote(column)}")
    order = ", ".join(sort_keys) or "1"
    name = table_ref(*key)
    id_col = f"t.{quote(pk)}"

    def pending(row_id: str) -> str:
        """Whether a row still waits for its stable id."""
        return f"""
            {row_id} not in (select id from fixed_id)
            and {row_id} not in (select old from stable_id)
        """

    # A row is ready once nothing it hangs from is still waiting for an id.
    ready = (
        " and ".join(
            f"""(t.{quote(column)} is null or t.{quote(column)} not in (
                select p.{quote(pk)} from {name} p
                where {pending(f"p.{quote(pk)}")}
            ))"""
            for column in self_links
        )
        or "true"
    )

    rank = 0
    while True:
        rows = conn.execute(f"""
            select {id_col}::text, count(*) over (partition by {order})
            from {name} t {joins(link_columns)}
            where {pending(id_col)} and {ready}
            order by {order}
        """).fetchall()
        if not rows:
            break
        tied = [row_id for row_id, count in rows if count > 1]
        if tied:
            conn.execute("rollback")
            sys.exit(
                f"Error: {len(tied)} rows of {key[0]}.{key[1]} are identical but for their "
                f"ids (e.g. {tied[0]}), so their ids can't be told apart reproducibly"
            )
        stable = []
        for row_id, _ in rows:
            rank += 1
            stable.append((row_id, str(uuid.uuid5(NAMESPACE, f"{key[0]}.{key[1]}#{rank}"))))
        conn.executemany("insert into stable_id values (?, ?)", stable)

    left = conn.execute(f"""
        select count(*) from {name} t where {pending(id_col)}
    """).fetchone()[0]
    if left:
        conn.execute("rollback")
        sys.exit(f"Error: {left} rows of {key[0]}.{key[1]} hang from each other in a cycle")


def check_no_other_mentions(conn, tables, columns, keys, links) -> None:
    """Refuse to go on if a rewritten id appears anywhere a link doesn't say.

    Only declared links are followed. A minted id copied into a text column (a
    saved query naming a record, say) would be left pointing at nothing.
    """
    for key in tables:
        followed = {keys.get(key)} | {column for column, _ in links[key]}
        for column, data_type in columns[key]:
            if column in followed or data_type in ("BLOB", "BOOLEAN"):
                continue
            (found,) = conn.execute(f"""
                select any_value(m.old::text) from {table_ref(*key)} t
                join stable_id m on contains(t.{quote(column)}::text, m.old::text)
            """).fetchone()
            if found:
                conn.execute("rollback")
                sys.exit(
                    f"Error: {key[0]}.{key[1]}.{column} mentions the minted id {found}, "
                    "which no declared link covers, so rewriting it would orphan it"
                )


def rewrite_table(conn, key: tuple, pk: str | None, cols: list, table_links: list) -> bool:
    """Write a table's rows back with stable ids, in a reproducible order.

    Returns whether the table had anything to rewrite.
    """
    link_columns = [column for column, _ in table_links]
    rewritable = ([pk] if pk else []) + [c for c in link_columns if c != pk]
    if not rewritable:
        return False
    name = table_ref(*key)
    (hits,) = conn.execute(f"""
        select count(*) from {name} t
        where {" or ".join(f"t.{quote(c)} in (select old from stable_id)" for c in rewritable)}
    """).fetchone()
    if not hits:
        return False

    aliases = {column: f"r{i}" for i, column in enumerate(rewritable)}
    select = ", ".join(
        f"{mapped(aliases[column], column)} as {quote(column)}"
        if column in aliases
        else f"t.{quote(column)}"
        for column, _ in cols
    )
    join = " ".join(
        f"left join stable_id {alias} on {alias}.old = t.{quote(column)}"
        for column, alias in aliases.items()
    )
    names = ", ".join(quote(column) for column, _ in cols)
    # The key last, so rows land in the order they were ranked in.
    order = ", ".join([quote(c) for c, _ in cols if c != pk] + ([quote(pk)] if pk else []))
    conn.execute(f"create temp table stable_rows as select {select} from {name} t {join}")
    conn.execute(f"delete from {name}")
    conn.execute(f"insert into {name} ({names}) select {names} from stable_rows order by {order}")
    conn.execute("drop table stable_rows")
    return True


def count_orphans(conn, links: dict, keys: dict) -> dict[str, int]:
    """How many non-null links point at no row, per declared link."""
    counts = {}
    for key, table_links in sorted(links.items()):
        for column, target in table_links:
            (count,) = conn.execute(f"""
                select count(*) from {table_ref(*key)} t
                where t.{quote(column)} is not null and t.{quote(column)} not in (
                    select {quote(keys[target])} from {table_ref(*target)}
                )
            """).fetchone()
            if count:
                counts[f"{key[0]}.{key[1]}.{column}"] = count
    return counts
