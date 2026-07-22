//! Dynamic Querydown display/sort generation for embedded-record previews.
//!
//! When the form loads a preview of a record — the single row behind a scalar
//! link, or each related row of a multi-record field — it needs a small,
//! *informative* set of result columns to show in the embedded-record widget.
//! Rather than lean on a user-configured display preset (which would demand a
//! preset for every table), this module derives that column set from the schema
//! alone, using a points-based heuristic that favours the columns most likely to
//! identify a record at a glance.
//!
//! # The heuristic
//!
//! [`generate`] assembles a candidate list of result-column *paths* for the
//! target table (its own non-foreign-key columns, plus a one-level recursion
//! through each foreign key that isn't the contextual filter), scores each on
//! four axes — proximity, requiredness, uniqueness, and type — and picks the (up
//! to two) columns tied for the top score. It also emits a sort section: an
//! `ord` column first when present, then the chosen display columns (dates
//! descending), then the record's key for a stable order across refreshes.
//!
//! # Contextual filtering
//!
//! When previewing records that all reference a common parent (e.g. the credits
//! of one track), the caller passes that referencing column as the *contextual
//! filter*. It's excluded from the display (its value is fixed and uninformative)
//! and it lets a column count as "unique" when it forms a two-column unique
//! constraint together with the contextual column (e.g. `credit (track, ord)`
//! makes `ord` unique *within* a track).

use introspection::{Column, Schema, Table};

/// The Querydown code for the display and sort sections of a preview query.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct GeneratedDisplay {
    /// The result-column section, e.g. ``$`artist`.`name` $`role` ``.
    pub(crate) display: String,
    /// The sorting section, e.g. ``\\`ord` ``. Empty when there is nothing to
    /// sort by.
    pub(crate) sort: String,
}

/// A single result-column path under consideration, with its computed score and
/// the metadata the sort section needs.
struct Candidate {
    /// The path from the target table to the column, e.g. `["role"]` or
    /// `["artist", "name"]`.
    path: Vec<String>,
    points: i32,
    /// Whether the column is a date/timestamp (sorted descending).
    temporal: bool,
}

/// Generates the display and sort sections for a preview of records from
/// `table_name`.
///
/// `contextual_column`, when given, names a column of `table_name` that the
/// query already constrains to a fixed value (the referencing column of a
/// multi-record field); it is omitted from the display and factors into
/// uniqueness scoring. Returns an all-columns glob (`$*`) with no sort when the
/// table is unknown or yields no candidate columns.
pub(crate) fn generate(
    schema: &Schema,
    table_name: &str,
    contextual_column: Option<&str>,
) -> GeneratedDisplay {
    let Some(table) = schema.table(table_name) else {
        return fallback();
    };

    let candidates = assemble_candidates(schema, table, table_name, contextual_column);
    let chosen = pick_display(&candidates);
    if chosen.is_empty() {
        return fallback();
    }

    let display = chosen
        .iter()
        .map(|c| format!("${}", qd_path(&c.path)))
        .collect::<Vec<_>>()
        .join(" ");
    let sort = build_sort(table, &chosen, contextual_column);
    GeneratedDisplay { display, sort }
}

/// The result when no informative columns can be derived: select everything, sort
/// by nothing.
fn fallback() -> GeneratedDisplay {
    GeneratedDisplay {
        display: "$*".to_owned(),
        sort: String::new(),
    }
}

/// Builds the scored candidate list for `table`: its own non-foreign-key columns
/// (skipping the contextual filter), plus a one-level recursion through each
/// foreign key that isn't the contextual filter.
fn assemble_candidates(
    schema: &Schema,
    table: &Table,
    table_name: &str,
    contextual_column: Option<&str>,
) -> Vec<Candidate> {
    let mut candidates = Vec::new();
    for col in &table.columns {
        if contextual_column == Some(col.name.as_str()) {
            continue;
        }
        if let Some(link) = schema.link(table_name, &col.name) {
            // A foreign key is never displayed directly; recurse one level into
            // the referenced table to consider its columns as transitive paths.
            if let Some(target) = schema.table(&link.to_table) {
                for sub in &target.columns {
                    candidates.push(Candidate {
                        path: vec![col.name.clone(), sub.name.clone()],
                        points: score(sub, target, false, None),
                        temporal: is_temporal(sub.type_name.as_deref()),
                    });
                }
            }
        } else {
            candidates.push(Candidate {
                path: vec![col.name.clone()],
                points: score(col, table, true, contextual_column),
                temporal: is_temporal(col.type_name.as_deref()),
            });
        }
    }
    candidates
}

/// Scores one column on the four axes.
///
/// `is_direct` is whether the column lives directly in the target table (vs.
/// reached through a foreign key). `contextual_column` participates in uniqueness
/// scoring and is only meaningful for direct columns (it names a column of the
/// column's own table).
fn score(column: &Column, table: &Table, is_direct: bool, contextual_column: Option<&str>) -> i32 {
    let hops = i32::from(is_direct);
    let nullability = i32::from(!column.nullable) * 2;
    let uniqueness = i32::from(is_unique(table, &column.name, contextual_column));
    hops + nullability + uniqueness + type_points(column.type_name.as_deref())
}

/// Whether `column` counts as unique within its query context: it has a
/// single-column unique constraint, or it shares a two-column unique constraint
/// with the contextual filter column.
fn is_unique(table: &Table, column: &str, contextual_column: Option<&str>) -> bool {
    table
        .unique_constraints
        .iter()
        .any(|constraint| match constraint.len() {
            1 => constraint[0] == column,
            2 => {
                constraint.iter().any(|c| c == column)
                    && contextual_column.is_some_and(|cc| constraint.iter().any(|c| c == cc))
            }
            _ => false,
        })
}

fn type_points(type_name: Option<&str>) -> i32 {
    match type_name {
        Some(t) if t.eq_ignore_ascii_case("UUID") => -3,
        Some(t) if is_text_like(t) => 1,
        _ => 0,
    }
}

/// Whether a `DuckDB` type name is text-like (`VARCHAR`, `CHAR`, `TEXT`, a text
/// `ENUM`, …), earning the type point.
fn is_text_like(type_name: &str) -> bool {
    const PREFIXES: &[&str] = &["VARCHAR", "STRING", "CHAR", "BPCHAR", "TEXT", "ENUM"];
    let t = type_name.to_ascii_uppercase();
    PREFIXES.iter().any(|p| t.starts_with(p))
}

/// Whether a `DuckDB` type name denotes a date or timestamp (sorted descending in
/// the sort section).
fn is_temporal(type_name: Option<&str>) -> bool {
    type_name.is_some_and(|t| {
        let t = t.to_ascii_uppercase();
        t.starts_with("DATE") || t.starts_with("TIMESTAMP")
    })
}

/// Picks the columns to display: those tied for the maximum score, capped at the
/// first two in assembly order. An empty candidate list yields an empty slice.
fn pick_display(candidates: &[Candidate]) -> Vec<&Candidate> {
    let Some(max) = candidates.iter().map(|c| c.points).max() else {
        return Vec::new();
    };
    candidates
        .iter()
        .filter(|c| c.points == max)
        .take(2)
        .collect()
}

/// Builds the sort section: `ord` first (ascending) when the table has such a
/// column, then the chosen display columns (dates descending, else ascending),
/// then the record's identifying key for a stable order. Duplicate paths and the
/// (constant) contextual column are skipped.
fn build_sort(table: &Table, chosen: &[&Candidate], contextual_column: Option<&str>) -> String {
    // Each term is (path, descending).
    let mut terms: Vec<(Vec<String>, bool)> = Vec::new();
    let mut push = |path: Vec<String>, descending: bool| {
        if path.len() == 1 && Some(path[0].as_str()) == contextual_column {
            return;
        }
        if terms.iter().any(|(p, _)| *p == path) {
            return;
        }
        terms.push((path, descending));
    };

    if table.column("ord").is_some() {
        push(vec!["ord".to_owned()], false);
    }
    for c in chosen {
        push(c.path.clone(), c.temporal);
    }
    for key_col in crate::form::identifying_columns(table) {
        push(vec![key_col], false);
    }

    terms
        .iter()
        .map(|(path, descending)| {
            let dir = if *descending { r" \d" } else { "" };
            format!(r"\\{}{}", qd_path(path), dir)
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Renders a path as dotted, backtick-quoted Querydown identifiers, e.g.
/// ``artist`.`name``.
fn qd_path(path: &[String]) -> String {
    path.iter()
        .map(|part| format!("`{}`", part.replace('`', "``")))
        .collect::<Vec<_>>()
        .join(".")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A schema modelled on the plan's running example: a `credit` table keyed by
    /// `(track, artist)` with an `ord` and a text `role`, linking to an `artist`
    /// whose `name` is unique and required.
    const SAMPLE: &str = r#"{
        "tables": [
            { "name": "track", "unique_constraints": [["id"]], "columns": [
                { "name": "id", "type": "UUID", "nullable": false },
                { "name": "title", "type": "VARCHAR", "nullable": true },
                { "name": "release_date", "type": "DATE", "nullable": true }
            ] },
            { "name": "artist", "unique_constraints": [["id"], ["name"]], "columns": [
                { "name": "id", "type": "UUID", "nullable": false },
                { "name": "name", "type": "VARCHAR", "nullable": false }
            ] },
            { "name": "credit", "unique_constraints": [["track", "artist"]], "columns": [
                { "name": "track", "type": "UUID", "nullable": false },
                { "name": "artist", "type": "UUID", "nullable": false },
                { "name": "ord", "type": "FLOAT", "nullable": true },
                { "name": "role", "type": "VARCHAR", "nullable": true }
            ] }
        ],
        "links": []
    }"#;

    fn schema() -> Schema {
        Schema::parse(SAMPLE).unwrap()
    }

    #[test]
    fn scores_match_the_plan_example() {
        let schema = schema();
        let credit = schema.table("credit").unwrap();
        let artist = schema.table("artist").unwrap();
        // Direct, nullable, non-unique, numeric -> 1.
        assert_eq!(
            score(credit.column("ord").unwrap(), credit, true, Some("track")),
            1
        );
        // Direct, nullable, non-unique, text -> 2.
        assert_eq!(
            score(credit.column("role").unwrap(), credit, true, Some("track")),
            2
        );
        // Transitive, required, unique, UUID -> 0.
        assert_eq!(score(artist.column("id").unwrap(), artist, false, None), 0);
        // Transitive, required, unique, text -> 4.
        assert_eq!(
            score(artist.column("name").unwrap(), artist, false, None),
            4
        );
    }

    #[test]
    fn picks_single_top_column_for_credit_of_a_track() {
        // artist.name (3) beats role (2); only it is at the max, so only it shows.
        let out = generate(&schema(), "credit", Some("track"));
        assert_eq!(out.display, "$`artist`.`name`");
    }

    #[test]
    fn sort_leads_with_ord_then_display_then_key() {
        let out = generate(&schema(), "credit", Some("track"));
        // `ord` first, then the display column, then the identifying key — with the
        // constant contextual `track` column dropped.
        assert_eq!(out.sort, r"\\`ord` \\`artist`.`name` \\`artist`");
    }

    #[test]
    fn two_columns_break_a_tie_in_assembly_order() {
        // A table of two equally-scored required text columns: both are shown, in
        // column order, capped at two even if a third would tie.
        let json = r#"{ "tables": [
            { "name": "t", "unique_constraints": [], "columns": [
                { "name": "a", "type": "VARCHAR", "nullable": false },
                { "name": "b", "type": "VARCHAR", "nullable": false },
                { "name": "c", "type": "VARCHAR", "nullable": false }
            ] }
        ], "links": [] }"#;
        let schema = Schema::parse(json).unwrap();
        let out = generate(&schema, "t", None);
        assert_eq!(out.display, "$`a` $`b`");
    }

    #[test]
    fn contextual_column_makes_a_paired_column_unique() {
        // Given `credit (track, ord)` unique, `ord` becomes unique within a track,
        // gaining the uniqueness point (2) and overtaking `role` (2) as a tie.
        let json = r#"{ "tables": [
            { "name": "credit", "unique_constraints": [["track", "ord"]], "columns": [
                { "name": "track", "type": "UUID", "nullable": false },
                { "name": "ord", "type": "VARCHAR", "nullable": false },
                { "name": "role", "type": "VARCHAR", "nullable": true }
            ] }
        ], "links": [] }"#;
        let schema = Schema::parse(json).unwrap();
        let credit = schema.table("credit").unwrap();
        // ord: direct(1) + required(2) + unique-with-track(1) + text(1) = 5.
        assert_eq!(
            score(credit.column("ord").unwrap(), credit, true, Some("track")),
            5
        );
        // Without the contextual column, the paired constraint grants no uniqueness.
        assert_eq!(score(credit.column("ord").unwrap(), credit, true, None), 4);
    }

    #[test]
    fn dates_sort_descending() {
        // With no key column and a single required date, it leads the sort descending.
        let json = r#"{ "tables": [
            { "name": "event", "unique_constraints": [], "columns": [
                { "name": "happened_at", "type": "TIMESTAMP", "nullable": false }
            ] }
        ], "links": [] }"#;
        let schema = Schema::parse(json).unwrap();
        let out = generate(&schema, "event", None);
        assert_eq!(out.display, "$`happened_at`");
        assert_eq!(out.sort, r"\\`happened_at` \d");
    }

    #[test]
    fn unknown_table_falls_back_to_glob() {
        assert_eq!(generate(&schema(), "nope", None), fallback());
    }

    #[test]
    fn scalar_link_preview_has_no_contextual_column() {
        // Previewing an artist on its own: name (3) wins, sorted by name then id.
        let out = generate(&schema(), "artist", None);
        assert_eq!(out.display, "$`name`");
        assert_eq!(out.sort, r"\\`name` \\`id`");
    }

    #[test]
    fn generated_multi_query_compiles_to_sql() {
        // The generated display (a foreign-key path) and sort must parse and
        // compile against the schema — including the transitive `artist.name`
        // path, which needs the convention-inferred links the app adds.
        use crate::compile;
        use crate::query_def::{CompileSource, QuerySections};

        let out = generate(&schema(), "credit", Some("track"));
        let source = CompileSource::Sections(QuerySections {
            base: "credit".to_owned(),
            filter: "`track`:=='abc'".to_owned(),
            sort: out.sort,
            display: out.display,
        });
        let enriched = introspection::add_inferred_links(SAMPLE).unwrap();
        let compiled = compile::querydown_to_duckdb(&source, &enriched)
            .expect("generated preview query should compile");
        assert!(compiled.sql.to_lowercase().contains("select"));
    }
}
