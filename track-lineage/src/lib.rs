//! Minimal WASM binding over `polyglot-sql` that reports, per output column of a
//! compiled query, which base-table columns that output column traces back to.
//!
//! This grew out of an earlier version that used the `polyglot-sql` Rust crate
//! directly and asked two fixed questions (which column is `track.id`, which is
//! the base table's primary key). This binding answers neither: it returns the
//! raw column→sources mapping and leaves the interpretation to the frontend,
//! which knows the introspected schema and can therefore decide — for *any*
//! table, not just the query's base table — whether the result rows carry that
//! table's primary key. See `frontend/src/query/lineage.ts`.
//!
//! Built with `default-features = false` so only the `semantic` analysis and
//! the DuckDB dialect are compiled in — a ~22 MB → ~2 MB win over the full
//! `@polyglot-sql/sdk` npm build, which bundles all 30+ dialects and every
//! feature.

use polyglot_sql::expressions::{Alias, Expression, Identifier, Null, Select};
use polyglot_sql::lineage::{lineage, LineageNode};
use polyglot_sql::{parse_one, DialectType};
use wasm_bindgen::prelude::*;

/// The base-table columns each output column of `sql` traces back to, as a JSON
/// array of arrays of `[table, column]` string pairs — the outer index is the
/// output column's 0-based position in the query's projection order (which
/// matches the Arrow result columns *before* hidden columns are dropped).
///
/// Returns `undefined` if the SQL can't be parsed or analyzed, which callers
/// treat as "no lineage known" and degrade accordingly (no affordances offered).
/// A column with no traceable source — a literal, say — yields an empty array.
///
/// `polyglot_sql::lineage` looks an output column up by *name*, and a query can
/// select two columns with the same name (`"playlist_track"."id"` and
/// `"track"."id"`, say), which would both resolve to the first. So the outermost
/// projection list is first re-aliased positionally (see [`alias_positionally`])
/// and each column is analyzed by its unique alias.
#[wasm_bindgen]
pub fn column_sources(sql: &str) -> Option<String> {
    let mut expr = parse_one(sql, DialectType::DuckDB).ok()?;
    let names = alias_positionally(outermost_select(&mut expr)?);
    let mut json = String::from("[");
    for (idx, name) in names.iter().enumerate() {
        let node = lineage(name, &expr, Some(DialectType::DuckDB), false).ok()?;
        if idx > 0 {
            json.push(',');
        }
        write_sources(&mut json, &node);
    }
    json.push(']');
    Some(json)
}

/// The `SELECT` whose projection list names the query's output columns: the
/// statement itself, or the leftmost operand of a set operation (whose column
/// names the other operands follow), looking through parentheses.
fn outermost_select(expr: &mut Expression) -> Option<&mut Select> {
    match expr {
        Expression::Select(select) => Some(select),
        Expression::Union(union) => outermost_select(&mut union.left),
        Expression::Intersect(intersect) => outermost_select(&mut intersect.left),
        Expression::Except(except) => outermost_select(&mut except.left),
        Expression::Subquery(subquery) => outermost_select(&mut subquery.this),
        _ => None,
    }
}

/// Gives every projection in `select` a unique alias derived from its position
/// (replacing any alias it had, so that no two collide), and returns those
/// aliases in projection order. Aliasing every projection also names the ones
/// that had no name at all (an unaliased function call, say), which would
/// otherwise have been skipped and shifted every later index. A `*` is left
/// alone, since it can't be aliased.
fn alias_positionally(select: &mut Select) -> Vec<String> {
    let mut names = Vec::with_capacity(select.expressions.len());
    for (idx, projection) in select.expressions.iter_mut().enumerate() {
        if matches!(projection, Expression::Star(_)) {
            names.push("*".to_string());
            continue;
        }
        let name = format!("__lineage_{idx}");
        match projection {
            Expression::Alias(alias) => alias.alias = Identifier::new(&name),
            _ => {
                let this = std::mem::replace(projection, Expression::Null(Null));
                *projection = Expression::Alias(Box::new(Alias::new(this, Identifier::new(&name))));
            }
        }
        names.push(name);
    }
    names
}

/// Appends `root`'s leaf sources to `out` as a JSON array of `[table, column]`
/// pairs. A "leaf" is a lineage node with no further downstream.
fn write_sources(out: &mut String, root: &LineageNode) {
    out.push('[');
    let mut first = true;
    for node in root.walk() {
        if !node.downstream.is_empty() {
            continue;
        }
        let Expression::Table(source_table) = &node.source else {
            continue;
        };
        let Expression::Column(col) = &node.expression else {
            continue;
        };
        if !first {
            out.push(',');
        }
        first = false;
        out.push('[');
        write_json_string(out, &source_table.name.name);
        out.push(',');
        write_json_string(out, &col.name.name);
        out.push(']');
    }
    out.push(']');
}

/// Writes `s` as a JSON string literal. Identifiers are plain in practice, but a
/// quoted SQL identifier can hold anything, so escape rather than trust it.
fn write_json_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::column_sources;

    #[test]
    fn same_named_columns_trace_to_their_own_tables() {
        let sql = r#"SELECT "playlist_track"."id", "playlist_track"."position", "track"."id", "track"."title"
            FROM "playlist_track" LEFT JOIN "track" ON "playlist_track"."track" = "track"."id""#;
        assert_eq!(
            column_sources(sql).unwrap(),
            r#"[[["playlist_track","id"]],[["playlist_track","position"]],[["track","id"]],[["track","title"]]]"#
        );
    }

    #[test]
    fn colliding_aliases_and_unnamed_projections_keep_their_positions() {
        let sql = r#"WITH "cte0" AS (SELECT "credit"."track" AS "pk", count(*) AS "v1" FROM "credit" GROUP BY "credit"."track")
            SELECT "track"."id", "album"."id", lower("track"."title"), "cte0"."v1" AS "id"
            FROM "track" LEFT JOIN "album" ON "track"."album" = "album"."id"
            LEFT JOIN "cte0" ON "track"."id" = "cte0"."pk""#;
        let json = column_sources(sql).unwrap();
        assert!(
            json.starts_with(r#"[[["track","id"]],[["album","id"]],[["track","title"]],["#),
            "{json}"
        );
    }
}
