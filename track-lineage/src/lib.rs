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

use polyglot_sql::ast_transforms::get_output_column_names;
use polyglot_sql::expressions::Expression;
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
#[wasm_bindgen]
pub fn column_sources(sql: &str) -> Option<String> {
    let expr = parse_one(sql, DialectType::DuckDB).ok()?;
    let names = get_output_column_names(&expr);
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
