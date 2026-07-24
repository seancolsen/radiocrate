//! Minimal WASM binding over `polyglot-sql` that locates, by column lineage, the
//! output column of a compiled query that traces back to `track.id`.
//!
//! This is a direct port of the egui frontend's `lineage.rs` (which used the
//! `polyglot-sql` Rust crate), rebuilt for the DOM frontend with `default-
//! features = false` so only the `semantic` analysis and the DuckDB dialect are
//! compiled in — a ~22 MB → ~2 MB win over the full `@polyglot-sql/sdk` npm
//! build, which bundles all 30+ dialects and every feature.
//!
//! Only the one thing the frontend needs is exposed: whether the query's rows
//! represent tracks (for double-click-to-play). The base-table primary key
//! (`record` in the egui code) isn't needed until the record editor lands.

use polyglot_sql::ast_transforms::get_output_column_names;
use polyglot_sql::expressions::Expression;
use polyglot_sql::lineage::{lineage, LineageNode};
use polyglot_sql::{parse_one, DialectType};
use wasm_bindgen::prelude::*;

/// The output-column index (0-based, in the query's projection order — which
/// matches the Arrow result columns *before* hidden columns are dropped) that
/// unambiguously traces back to `track.id`, or `-1` if none does, more than one
/// does, or the SQL can't be parsed. Callers treat `-1` as "not track-based".
#[wasm_bindgen]
pub fn detect_track_id_column(sql: &str) -> i32 {
    detect(sql, "track", "id").map_or(-1, |i| i as i32)
}

/// The fallible core: locates the sole output column tracing to `table`.`column`
/// (case-insensitive). Mirrors `lineage.rs`'s `Unique` handling — a single match
/// is trusted, an ambiguous mapping is not — and degrades any parse/lineage
/// failure to `None`.
fn detect(sql: &str, table: &str, column: &str) -> Option<usize> {
    let expr = parse_one(sql, DialectType::DuckDB).ok()?;
    let names = get_output_column_names(&expr);
    let mut found: Option<usize> = None;
    let mut multiple = false;
    for (idx, name) in names.iter().enumerate() {
        let node = lineage(name, &expr, Some(DialectType::DuckDB), false).ok()?;
        if traces_to(&node, table, column) {
            if found.is_some() {
                multiple = true;
            } else {
                found = Some(idx);
            }
        }
    }
    if multiple {
        None
    } else {
        found
    }
}

/// Whether `root`'s lineage bottoms out in `table`.`column` (case-insensitive) at
/// a leaf source (a node with no further downstream). Verbatim port of the egui
/// `traces_to`.
fn traces_to(root: &LineageNode, table: &str, column: &str) -> bool {
    for node in root.walk() {
        if !node.downstream.is_empty() {
            continue;
        }
        let Expression::Table(source_table) = &node.source else {
            continue;
        };
        if !source_table.name.name.eq_ignore_ascii_case(table) {
            continue;
        }
        if let Expression::Column(col) = &node.expression {
            if col.name.name.eq_ignore_ascii_case(column) {
                return true;
            }
        }
    }
    false
}
