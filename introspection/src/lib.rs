//! Shared database introspection for `RadioCrate`'s front end and back end.
//!
//! Both halves of the app need to understand the database's structure by introspecting it at
//! runtime, and both must agree on that structure. The front end feeds it to the Querydown compiler;
//! the back end's DML API uses it to validate and build writes. To keep the two from drifting, the
//! introspection SQL and the post-processing that enriches its output both live here.
//!
//! # The SQL
//!
//! [`introspection_sql`] returns a query that, run against a `DuckDB` database, yields a single JSON
//! document describing every table and column in the database (see `resources/duckdb.sql`). It
//! began as a copy of Querydown's own introspection query and was extended with the nullability and
//! unique-constraint metadata the DML API needs.
//!
//! # Schemas
//!
//! The document lists the tables of every schema, so Querydown can query them all. A table in the
//! current schema (`main`) has no `schema`, and Querydown writes it `#table`. Any other table carries
//! its schema as a path, outermost name first (`["metadata"]`, written `#/metadata/table`), and so does
//! each end of a link. The app itself works with the current schema's tables, which it names alone:
//! [`Schema::table`] and the link lookups find only those, so a table of the same name elsewhere is
//! never mistaken for one of them.
//!
//! # Inferred links
//!
//! `RadioCrate` declares no foreign keys — `DuckDB` can't update rows referenced by an `FK` constraint —
//! so the introspection SQL finds no links and always emits an empty `links` array. We recover links
//! by convention: any `UUID` column whose name matches another table's name is treated as a link to
//! that table's `id` column. The name is looked up as Querydown looks up `#name`, but from the
//! column's own schema first: a table of that name in the same schema, otherwise one in the current
//! schema. So a table in another schema can link to the app's tables (a `track` column links to the
//! app's `track`), while the app's tables only ever link among themselves. This inference is applied
//! two ways from one shared implementation:
//!
//! - [`add_inferred_links`] rewrites the `links` array of the raw JSON document, for the front end to
//!   hand to the Querydown compiler.
//! - [`Schema::parse`] parses the whole document into a structured [`Schema`] (with the inferred
//!   links) for the back end.

use serde::Deserialize;
use serde_json::{Value, json};

/// The SQL that introspects a `DuckDB` database into `RadioCrate`'s schema JSON.
///
/// The query returns a single row with a single JSON-text cell. Run it through the query API, read
/// the lone value, then either enrich it with [`add_inferred_links`] (front end) or parse it with
/// [`Schema::parse`] (back end).
#[must_use]
pub fn introspection_sql() -> &'static str {
    include_str!("../resources/duckdb.sql")
}

/// A convention-inferred foreign-key link: `from_table.from_column` references `to_table.to_column`.
/// Each end's table is in the schema at its path, which is empty for the current schema.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    pub from_schema: Vec<String>,
    pub from_table: String,
    pub from_column: String,
    pub to_schema: Vec<String>,
    pub to_table: String,
    pub to_column: String,
}

/// A single column and the metadata the DML API reasons about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Column {
    pub name: String,
    /// The column's `DuckDB` type name (e.g. `"UUID"`, `"VARCHAR"`), if the introspection provided one.
    pub type_name: Option<String>,
    /// Whether the column permits `NULL`.
    pub nullable: bool,
}

/// A single table: its columns and its UNIQUE / PRIMARY KEY constraints.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Table {
    pub name: String,
    /// The path of the schema the table is in, outermost name first: empty for the current schema,
    /// `["metadata"]` for another schema of the database, `[database, schema]` for one of another
    /// attached database.
    pub schema: Vec<String>,
    pub columns: Vec<Column>,
    /// Each entry is the set of columns covered by one UNIQUE or PRIMARY KEY constraint. Multi-column
    /// constraints (e.g. `credit (track, artist)`) appear as multi-element inner vectors.
    pub unique_constraints: Vec<Vec<String>>,
}

impl Table {
    /// Whether the table is in the current schema, where the app names it alone.
    #[must_use]
    pub fn is_current(&self) -> bool {
        self.schema.is_empty()
    }

    /// Looks up a column by name.
    #[must_use]
    pub fn column(&self, name: &str) -> Option<&Column> {
        self.columns.iter().find(|c| c.name == name)
    }
}

/// The introspected structure of the database: its tables and its inferred links, in every schema.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Schema {
    pub tables: Vec<Table>,
    pub links: Vec<Link>,
}

impl Schema {
    /// Parses an introspection JSON document (as produced by [`introspection_sql`]) into a [`Schema`],
    /// inferring links by convention. The document's own `links` array is ignored and recomputed.
    ///
    /// # Errors
    ///
    /// Returns an error string if the JSON does not match the expected introspection shape.
    pub fn parse(introspection_json: &str) -> Result<Self, String> {
        let raw: RawSchema = serde_json::from_str(introspection_json).map_err(|e| e.to_string())?;
        let links = infer_links(&raw.tables);
        let tables = raw
            .tables
            .into_iter()
            .map(|t| Table {
                name: t.name,
                schema: t.schema,
                columns: t
                    .columns
                    .into_iter()
                    .map(|c| Column {
                        name: c.name,
                        type_name: c.type_name,
                        nullable: c.nullable,
                    })
                    .collect(),
                unique_constraints: t.unique_constraints,
            })
            .collect();
        Ok(Schema { tables, links })
    }

    /// The tables of the current schema: the app's own, which it names alone.
    pub fn current_tables(&self) -> impl Iterator<Item = &Table> {
        self.tables.iter().filter(|t| t.is_current())
    }

    /// Looks up a table of the current schema by name.
    #[must_use]
    pub fn table(&self, name: &str) -> Option<&Table> {
        self.table_in(&[], name)
    }

    /// Looks up a table by the path of its schema (empty for the current one, `["app"]` for another
    /// schema of the database) and its name.
    #[must_use]
    pub fn table_in(&self, schema: &[String], name: &str) -> Option<&Table> {
        self.tables
            .iter()
            .find(|t| t.schema == schema && t.name == name)
    }

    /// The links whose target is the current schema's `table` — i.e. every `(from_table,
    /// from_column)` in the database, in any schema, that references this table. Used by the DML
    /// delete path to find dangling references.
    pub fn incoming_links<'a>(&'a self, table: &'a str) -> impl Iterator<Item = &'a Link> {
        self.incoming_links_in(&[], table)
    }

    /// The links whose target is `table` of the schema at path `schema`, from any schema.
    pub fn incoming_links_in<'a>(
        &'a self,
        schema: &'a [String],
        table: &'a str,
    ) -> impl Iterator<Item = &'a Link> {
        self.links
            .iter()
            .filter(move |l| l.to_schema == schema && l.to_table == table)
    }

    /// The link whose source is the current schema's `table.column`, if that column is an inferred
    /// foreign key.
    #[must_use]
    pub fn link(&self, table: &str, column: &str) -> Option<&Link> {
        self.link_in(&[], table, column)
    }

    /// The link whose source is `table.column` of the schema at path `schema`, if that column is an
    /// inferred foreign key.
    #[must_use]
    pub fn link_in(&self, schema: &[String], table: &str, column: &str) -> Option<&Link> {
        self.links
            .iter()
            .find(|l| l.from_schema == schema && l.from_table == table && l.from_column == column)
    }
}

/// Adds convention-inferred table links to a raw introspection JSON document.
///
/// Takes the JSON produced by running [`introspection_sql`] and returns it with its `links` array
/// replaced by the column-name/type convention described in the module docs. Every other part of the
/// document is preserved verbatim, so it stays compatible with whatever shape the Querydown compiler
/// expects. Each emitted link carries `"unique": false`, matching Querydown's `PrimitiveLink`, and
/// each of its ends carries the `schema` of its table, unless that's the current schema.
///
/// # Errors
///
/// Returns an error string if the JSON has no `tables` array or cannot be re-serialized.
pub fn add_inferred_links(introspection_json: &str) -> Result<String, String> {
    let mut root: Value = serde_json::from_str(introspection_json).map_err(|e| e.to_string())?;
    let raw: RawSchema = serde_json::from_value(root.clone())
        .map_err(|e| format!("Introspected schema JSON did not match the expected shape: {e}"))?;
    let links = infer_links(&raw.tables);
    let links_json: Vec<Value> = links
        .iter()
        .map(|l| {
            json!({
                "from": link_end(&l.from_schema, &l.from_table, &l.from_column),
                "to": link_end(&l.to_schema, &l.to_table, &l.to_column),
                "unique": false,
            })
        })
        .collect();
    root["links"] = Value::Array(links_json);
    serde_json::to_string(&root).map_err(|e| e.to_string())
}

/// One end of a link in Querydown's schema JSON, which leaves out the `schema` of a table in the
/// current schema.
fn link_end(schema: &[String], table: &str, column: &str) -> Value {
    if schema.is_empty() {
        json!({ "table": table, "column": column })
    } else {
        json!({ "table": table, "schema": schema, "column": column })
    }
}

/// The single source of truth for `RadioCrate`'s foreign-key convention: a `UUID` column whose name
/// matches a table's name links to that table's `id` column. The table is looked for in the column's
/// own schema first, then in the current schema.
fn infer_links(tables: &[RawTable]) -> Vec<Link> {
    let has_table =
        |schema: &[String], name: &str| tables.iter().any(|t| t.schema == schema && t.name == name);
    let mut links = Vec::new();
    for table in tables {
        for column in &table.columns {
            let is_uuid = column
                .type_name
                .as_deref()
                .is_some_and(|t| t.eq_ignore_ascii_case("UUID"));
            if !is_uuid {
                continue;
            }
            let to_schema = if has_table(&table.schema, &column.name) {
                &table.schema[..]
            } else if has_table(&[], &column.name) {
                &[]
            } else {
                continue;
            };
            links.push(Link {
                from_schema: table.schema.clone(),
                from_table: table.name.clone(),
                from_column: column.name.clone(),
                to_schema: to_schema.to_vec(),
                to_table: column.name.clone(),
                to_column: "id".to_string(),
            });
        }
    }
    links
}

#[derive(Deserialize)]
struct RawSchema {
    tables: Vec<RawTable>,
}

#[derive(Deserialize)]
struct RawTable {
    name: String,
    #[serde(default)]
    schema: Vec<String>,
    columns: Vec<RawColumn>,
    #[serde(default)]
    unique_constraints: Vec<Vec<String>>,
}

#[derive(Deserialize)]
struct RawColumn {
    name: String,
    #[serde(rename = "type", default)]
    type_name: Option<String>,
    #[serde(default)]
    nullable: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
        "tables": [
            { "name": "track", "unique_constraints": [["id"]], "columns": [
                { "name": "id", "type": "UUID", "nullable": false },
                { "name": "title", "type": "VARCHAR", "nullable": true },
                { "name": "album", "type": "UUID", "nullable": true }
            ] },
            { "name": "album", "unique_constraints": [["id"]], "columns": [
                { "name": "id", "type": "UUID", "nullable": false }
            ] },
            { "name": "credit", "unique_constraints": [["track", "artist"]], "columns": [
                { "name": "track", "type": "UUID", "nullable": false },
                { "name": "artist", "type": "UUID", "nullable": false },
                { "name": "order", "type": "FLOAT", "nullable": true }
            ] }
        ],
        "links": []
    }"#;

    #[test]
    fn infers_link_from_uuid_column_matching_table_name() {
        let out: Value = serde_json::from_str(&add_inferred_links(SAMPLE).unwrap()).unwrap();
        let links = out["links"].as_array().unwrap();
        // track.album -> album.id, credit.track -> track.id (credit.artist has no `artist` table here)
        assert_eq!(links.len(), 2);
        assert!(links.iter().any(|l| l["from"]["table"] == "track"
            && l["from"]["column"] == "album"
            && l["to"]["table"] == "album"
            && l["to"]["column"] == "id"
            && l["unique"] == false));
        assert!(links.iter().any(|l| l["from"]["table"] == "credit"
            && l["from"]["column"] == "track"
            && l["to"]["table"] == "track"));
    }

    #[test]
    fn ignores_non_uuid_and_non_matching_columns() {
        let input = r#"{ "tables": [
            { "name": "track", "columns": [
                { "name": "id", "type": "UUID" },
                { "name": "title", "type": "VARCHAR" },
                { "name": "track", "type": "VARCHAR" }
            ] }
        ], "links": [] }"#;
        let out: Value = serde_json::from_str(&add_inferred_links(input).unwrap()).unwrap();
        assert!(out["links"].as_array().unwrap().is_empty());
    }

    #[test]
    fn add_inferred_links_preserves_other_fields_and_overwrites_links() {
        let input = r#"{ "tables": [], "links": [{ "stale": true }], "extra": 1 }"#;
        let out: Value = serde_json::from_str(&add_inferred_links(input).unwrap()).unwrap();
        assert!(out["links"].as_array().unwrap().is_empty());
        assert_eq!(out["extra"], 1);
    }

    #[test]
    fn rejects_json_without_tables() {
        assert!(add_inferred_links(r#"{ "nope": 1 }"#).is_err());
        assert!(Schema::parse(r#"{ "nope": 1 }"#).is_err());
    }

    #[test]
    fn parse_builds_structured_schema_with_links() {
        let schema = Schema::parse(SAMPLE).unwrap();
        let track = schema.table("track").unwrap();
        assert!(!track.column("id").unwrap().nullable);
        assert!(track.column("title").unwrap().nullable);
        assert_eq!(track.unique_constraints, vec![vec!["id".to_string()]]);

        let credit = schema.table("credit").unwrap();
        assert_eq!(
            credit.unique_constraints,
            vec![vec!["track".to_string(), "artist".to_string()]]
        );

        // track.album -> album.id is a link; album is referenced by track.
        assert!(schema.link("track", "album").is_some());
        let incoming: Vec<_> = schema.incoming_links("album").collect();
        assert_eq!(incoming.len(), 1);
        assert_eq!(incoming[0].from_table, "track");
    }

    /// The app's `track` and `album`, a `metadata` table of the same name as one of them, and a
    /// table of another schema that refers to the app's `track` and to its own schema's `album`.
    const SCHEMAS: &str = r#"{
        "tables": [
            { "name": "track", "unique_constraints": [["id"]], "columns": [
                { "name": "id", "type": "UUID", "nullable": false },
                { "name": "album", "type": "UUID", "nullable": true }
            ] },
            { "name": "album", "unique_constraints": [["id"]], "columns": [
                { "name": "id", "type": "UUID", "nullable": false }
            ] },
            { "name": "track", "schema": ["metadata"], "columns": [
                { "name": "note", "type": "VARCHAR", "nullable": true }
            ] },
            { "name": "album", "schema": ["lastfm"], "columns": [
                { "name": "id", "type": "UUID", "nullable": false }
            ] },
            { "name": "scrobble", "schema": ["lastfm"], "columns": [
                { "name": "track", "type": "UUID", "nullable": false },
                { "name": "album", "type": "UUID", "nullable": true }
            ] }
        ],
        "links": []
    }"#;

    #[test]
    fn lookups_by_name_find_only_tables_of_the_current_schema() {
        let schema = Schema::parse(SCHEMAS).unwrap();
        assert_eq!(schema.tables.len(), 5);
        let track = schema.table("track").unwrap();
        assert!(track.is_current());
        assert!(track.column("album").is_some());
        assert!(schema.table("scrobble").is_none());
        assert_eq!(
            schema.current_tables().map(|t| &t.name).collect::<Vec<_>>(),
            ["track", "album"]
        );
        let scrobble = schema.tables.iter().find(|t| t.name == "scrobble").unwrap();
        assert_eq!(scrobble.schema, ["lastfm"]);
    }

    #[test]
    fn lookups_by_schema_find_the_tables_and_links_of_that_schema() {
        let schema = Schema::parse(SCHEMAS).unwrap();
        let lastfm = ["lastfm".to_string()];
        assert_eq!(schema.table_in(&lastfm, "scrobble").unwrap().schema, lastfm);
        // `album` is a table of both: each lookup finds its own.
        assert_eq!(schema.table_in(&lastfm, "album").unwrap().columns.len(), 1);
        assert!(schema.table_in(&[], "album").unwrap().is_current());
        assert!(schema.table_in(&lastfm, "track").is_none());
        assert!(schema.link_in(&lastfm, "scrobble", "track").is_some());
        // Only `lastfm`'s own scrobbles refer to its albums.
        let incoming: Vec<_> = schema.incoming_links_in(&lastfm, "album").collect();
        assert_eq!(incoming.len(), 1);
        assert_eq!(incoming[0].from_table, "scrobble");
    }

    #[test]
    fn a_link_column_finds_its_table_in_its_own_schema_then_the_current_one() {
        let schema = Schema::parse(SCHEMAS).unwrap();
        let from = |schema_path: &[&str], table: &str, column: &str| {
            schema
                .links
                .iter()
                .find(|l| {
                    l.from_schema == schema_path && l.from_table == table && l.from_column == column
                })
                .unwrap()
        };
        // The app's own link stays among the app's tables.
        assert!(from(&[], "track", "album").to_schema.is_empty());
        // `lastfm` has an `album` of its own, but no `track`.
        assert_eq!(from(&["lastfm"], "scrobble", "album").to_schema, ["lastfm"]);
        assert!(from(&["lastfm"], "scrobble", "track").to_schema.is_empty());
        assert_eq!(schema.links.len(), 3);

        // Deleting one of the app's tracks has to look at `lastfm.scrobble` too, but the lookups by
        // a source column only see the app's own.
        let incoming: Vec<_> = schema.incoming_links("track").collect();
        assert_eq!(incoming.len(), 1);
        assert_eq!(incoming[0].from_schema, ["lastfm"]);
        assert_eq!(schema.incoming_links("album").count(), 1);
        assert!(schema.link("scrobble", "track").is_none());
    }

    #[test]
    fn links_name_the_schema_of_a_table_outside_the_current_one() {
        let out: Value = serde_json::from_str(&add_inferred_links(SCHEMAS).unwrap()).unwrap();
        let links = out["links"].as_array().unwrap();
        assert_eq!(
            links[0],
            json!({
                "from": { "table": "track", "column": "album" },
                "to": { "table": "album", "column": "id" },
                "unique": false,
            })
        );
        assert_eq!(
            links[1],
            json!({
                "from": { "table": "scrobble", "schema": ["lastfm"], "column": "track" },
                "to": { "table": "track", "column": "id" },
                "unique": false,
            })
        );
        assert_eq!(links[2]["to"]["schema"], json!(["lastfm"]));
        // The tables keep their schemas, too.
        assert_eq!(out["tables"][4]["schema"], json!(["lastfm"]));
    }
}
