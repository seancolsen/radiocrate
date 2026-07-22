use std::sync::{Arc, Mutex};

use eframe::egui;
use polyglot_sql::ast_transforms::get_output_column_names;
use polyglot_sql::expressions::Expression;
use polyglot_sql::lineage::{LineageNode, lineage};
use polyglot_sql::{DialectType, parse_one};

use crate::QueryState;

/// Result columns located by tracing the compiled query's output columns back
/// through the SQL to their source table columns.
#[derive(Default, Clone, Copy)]
struct IdColumns {
    /// The output column that traces to `track.id`, for double-click-to-play.
    track: Option<usize>,
    /// The output column that traces to the query base table's primary key, so
    /// the record editor can identify which record a result row edits. Equal to
    /// `track` when the base table *is* `track`.
    record: Option<usize>,
}

/// Locates, by column lineage, the output columns carrying `track.id` (for
/// playback) and the base table's primary key `base_pk` (for record editing),
/// storing both on `state`. Runs off the UI thread — parsing and walking the SQL
/// AST can be deep — then requests a repaint. `base_pk` is `None` for a base
/// table with no single-column key, leaving `record_id_column` unset.
pub(crate) fn detect_id_columns(
    query: String,
    base_table: String,
    base_pk: Option<String>,
    state: Arc<Mutex<QueryState>>,
    ctx: egui::Context,
) {
    #[cfg(not(target_arch = "wasm32"))]
    {
        // `compute` parses the SQL and recursively walks the resulting AST, which can be
        // deep for nested expressions (e.g. the `contains(lower(strip_accents(...)))` a
        // `:` match compiles to). The default 2 MiB worker-thread stack overflows on such
        // input in debug builds, so we give it generous headroom and a name (an unnamed
        // thread reports as `<unknown>` if it ever does overflow).
        std::thread::Builder::new()
            .name("lineage".into())
            .stack_size(16 * 1024 * 1024)
            .spawn(move || {
                let result = compute(&query, &base_table, base_pk.as_deref());
                apply(result, &state, &ctx);
            })
            .expect("failed to spawn lineage thread");
    }
    #[cfg(target_arch = "wasm32")]
    {
        wasm_bindgen_futures::spawn_local(async move {
            let result = compute(&query, &base_table, base_pk.as_deref());
            apply(result, &state, &ctx);
        });
    }
}

fn compute(sql: &str, base_table: &str, base_pk: Option<&str>) -> IdColumns {
    inner(sql, base_table, base_pk).unwrap_or_default()
}

/// The fallible body of [`compute`]: any parse/lineage failure yields
/// [`IdColumns::default`] (both columns unknown), matching the "just don't offer
/// the affordance" degradation the callers already handle.
fn inner(sql: &str, base_table: &str, base_pk: Option<&str>) -> Option<IdColumns> {
    let expr = parse_one(sql, DialectType::DuckDB).ok()?;
    let names = get_output_column_names(&expr);
    let mut track = Unique::default();
    let mut record = Unique::default();
    for (idx, name) in names.iter().enumerate() {
        let node = lineage(name, &expr, Some(DialectType::DuckDB), false).ok()?;
        if traces_to(&node, "track", "id") {
            track.offer(idx);
        }
        if let Some(pk) = base_pk
            && traces_to(&node, base_table, pk)
        {
            record.offer(idx);
        }
    }
    Some(IdColumns {
        track: track.get(),
        record: record.get(),
    })
}

/// Tracks the unique column matching a target: a single match resolves to that
/// index, but two or more (an ambiguous mapping) resolve to `None` — we only
/// trust an unambiguous id column.
#[derive(Default)]
struct Unique {
    idx: Option<usize>,
    multiple: bool,
}

impl Unique {
    fn offer(&mut self, idx: usize) {
        if self.idx.is_some() {
            self.multiple = true;
        } else {
            self.idx = Some(idx);
        }
    }

    fn get(&self) -> Option<usize> {
        if self.multiple { None } else { self.idx }
    }
}

/// Whether `root`'s lineage bottoms out in `table`.`column` (case-insensitive) at
/// a leaf source (a node with no further downstream).
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
        if let Expression::Column(col) = &node.expression
            && col.name.name.eq_ignore_ascii_case(column)
        {
            return true;
        }
    }
    false
}

fn apply(cols: IdColumns, state: &Mutex<QueryState>, ctx: &egui::Context) {
    let mut s = state.lock().unwrap();
    s.track_id_column = cols.track;
    s.record_id_column = cols.record;
    s.lineage_done = true;
    drop(s);
    ctx.request_repaint();
}
