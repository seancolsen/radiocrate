//! Minimal JSON-RPC 2.0 endpoint for managing saved sources (queries and
//! playlists) and settings.
//!
//! The surface is tiny (a handful of methods over a single HTTP route), so the
//! envelope is hand-rolled with serde rather than pulling in a full RPC crate.
//! Each method runs on a blocking thread and talks to `DuckDB` through the
//! shared `Mutex<Connection>`, mirroring the other handlers in [`crate::server`].

use std::sync::Arc;

use api_schema::{
    AppVersion, CLIENT_ID_HEADER, ColumnSummary, ComputedColumnRow, CustomComparisonRow,
    FieldMetadataRow, FieldOrder, FieldRef, FilterStrategy, FolderDeleteParams, FolderRenameParams,
    Keybinding, KeybindingDeleteParams, MetadataComputedColumnDeleteParams,
    MetadataComputedColumnRenameParams, MetadataCustomComparisonDeleteParams,
    MetadataCustomComparisonRenameParams, MetadataFieldSetDisplayParams,
    MetadataFieldSetOrderParams, MetadataFieldSetSortingParams, MetadataFieldSetVisibleParams,
    MetadataTableSetOrderParams, MetadataTableSetQuerydownParams, MetadataTableSetVisibleParams,
    MultiLink, Placement, Preset, PresetDeleteParams, PresetUpdateParams, QueryDeleteParams,
    Setting, SettingDeleteParams, Source, SourceArrangeParams, SourceFolder, SourceKind,
    SourceRecordPlayParams, SourceRenameParams, SourceUpdateDefinitionParams, TableMetadataRow,
    TableOrder, TableQuerydownSetting, TableSummary, Topic, TreeItemKind,
};
use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use duckdb::{Connection, OptionalExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::{error, warn};

use crate::server::AppState;

// The wire types (`Source`, `Preset`, `Keybinding`) and every method's params
// struct live in the shared `api-schema` crate, so the generated TypeScript
// client is derived from these exact definitions and can't drift. See that crate.

#[derive(Deserialize)]
pub(crate) struct RpcRequest {
    method: String,
    #[serde(default)]
    params: Value,
    id: Value,
}

#[derive(Serialize)]
pub(crate) struct RpcResponse {
    jsonrpc: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<RpcError>,
    id: Value,
}

#[derive(Serialize)]
struct RpcError {
    code: i32,
    message: String,
    /// Optional structured payload. Present (possibly `null`) for handlers that opt into structured
    /// errors — e.g. the `dml` handler reports which operation failed here; absent otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
}

/// A handler error rich enough for the JSON-RPC `error` object: a numeric `code`, a `message`, and
/// an optional structured `data` payload.
///
/// Most handlers just produce a `String`; `From<String>` maps that to a generic server error with no
/// `data`. The `dml` handler builds these directly to attach an error `code` and a `data` object
/// naming the failing operation (see [`crate::dml`]).
#[derive(Debug)]
pub(crate) struct RpcErr {
    pub(crate) code: i32,
    pub(crate) message: String,
    pub(crate) data: Option<Value>,
}

impl From<String> for RpcErr {
    fn from(message: String) -> Self {
        RpcErr {
            code: -32000,
            message,
            data: None,
        }
    }
}

pub(crate) async fn rpc(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<RpcRequest>,
) -> Json<RpcResponse> {
    let id = req.id.clone();
    // Kept for the logging below; `req` itself moves into the blocking task.
    let method = req.method.clone();
    let origin = headers
        .get(CLIENT_ID_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let outcome = tokio::task::spawn_blocking(move || {
        dispatch(&state, origin.as_deref(), &req.method, req.params)
    })
    .await;

    match outcome {
        Ok(Ok(result)) => Json(RpcResponse {
            jsonrpc: "2.0",
            result: Some(result),
            error: None,
            id,
        }),
        Ok(Err(err)) => {
            // The client is told, but only over the wire — without this the
            // server side of a failed save leaves no trace at all. `WARN`
            // because the common causes (an unknown method, params that don't
            // deserialize, a constraint violation) are the client's problem.
            warn!(
                method,
                code = err.code,
                error = %err.message,
                "rpc method failed"
            );
            Json(RpcResponse {
                jsonrpc: "2.0",
                result: None,
                error: Some(RpcError {
                    code: err.code,
                    message: err.message,
                    data: err.data,
                }),
                id,
            })
        }
        Err(_) => {
            error!(method, "rpc task panicked");
            Json(RpcResponse {
                jsonrpc: "2.0",
                result: None,
                error: Some(RpcError {
                    code: -32603,
                    message: "rpc task panicked".to_string(),
                    data: None,
                }),
                id,
            })
        }
    }
}

// Routes a method to its handler. The `dml` handler opts into the structured [`RpcErr`] error shape;
// every other method uses a plain `String` error, which `From<String>` widens.
//
// `origin` is the client that sent the request (its `x-radiocrate-client`
// header), which every write hands on to the change it announces. Each write
// names the topics it changes right where it writes (see `AppState::write`);
// `dispatch_announces_exactly_its_topics` below holds the list to the spec's.
pub(crate) fn dispatch(
    state: &AppState,
    origin: Option<&str>,
    method: &str,
    params: Value,
) -> Result<Value, RpcErr> {
    match method {
        "dml" => crate::dml::handle(state, origin, params),
        _ => dispatch_legacy(state, origin, method, params).map_err(RpcErr::from),
    }
}

// A flat match over the CRUD RPC methods; splitting it up would just scatter the
// per-method param structs and handlers.
#[allow(clippy::too_many_lines)]
fn dispatch_legacy(
    state: &AppState,
    origin: Option<&str>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    match method {
        // The one method here that touches no database: it answers from the
        // strings `app_state` was built with.
        "app.version" => serde_json::to_value(AppVersion {
            build_id: state.build_id.clone(),
            server_version: state.server_version.clone(),
        })
        .map_err(|e| e.to_string()),
        "source.list" => state.read(|conn| -> Result<Value, String> {
            let sources = list_sources(conn)?;
            serde_json::to_value(sources).map_err(|e| e.to_string())
        }),
        "source.record_play" => {
            let p: SourceRecordPlayParams = from_params(params)?;
            state.write(origin, &[], |conn| {
                record_play(conn, &p.id, p.last_play)?;
                Ok(Value::Null)
            })
        }
        "source.rename" => {
            let p: SourceRenameParams = from_params(params)?;
            state.write(origin, &[Topic::Sources], |conn| {
                rename_source(conn, &p.id, &p.name)?;
                Ok(Value::Null)
            })
        }
        "source.update_definition" => {
            let p: SourceUpdateDefinitionParams = from_params(params)?;
            state.write_mut(origin, &[Topic::Sources], |conn| {
                update_definition(conn, &p.id, &p.definition, p.modified_at).map(|()| Value::Null)
            })
        }
        "source.arrange" => {
            let p: SourceArrangeParams = from_params(params)?;
            state.write_mut(origin, &[Topic::Sources], |conn| {
                arrange(conn, &p.placements).map(|()| Value::Null)
            })
        }
        // Playlists have no counterpart to these two: they are created and
        // deleted through `dml`, since their writes also span `playlist_track`.
        "query.add" => {
            let source: Source = from_params(params)?;
            state.write_mut(origin, &[Topic::Sources], |conn| {
                add_query(conn, &source).map(|()| Value::Null)
            })
        }
        "query.delete" => {
            let p: QueryDeleteParams = from_params(params)?;
            state.write_mut(origin, &[Topic::Sources], |conn| {
                delete_query(conn, &p.id).map(|()| Value::Null)
            })
        }
        "folder.list" => state.read(|conn| -> Result<Value, String> {
            let folders = list_folders(conn)?;
            serde_json::to_value(folders).map_err(|e| e.to_string())
        }),
        "folder.add" => {
            let folder: SourceFolder = from_params(params)?;
            state.write(origin, &[Topic::Sources], |conn| {
                add_folder(conn, &folder)?;
                Ok(Value::Null)
            })
        }
        "folder.rename" => {
            let p: FolderRenameParams = from_params(params)?;
            state.write(origin, &[Topic::Sources], |conn| {
                rename_folder(conn, &p.id, &p.name)?;
                Ok(Value::Null)
            })
        }
        "folder.delete" => {
            let p: FolderDeleteParams = from_params(params)?;
            state.write(origin, &[Topic::Sources], |conn| {
                delete_folder(conn, &p.id)?;
                Ok(Value::Null)
            })
        }
        "preset.list" => state.read(|conn| -> Result<Value, String> {
            let presets = list_presets(conn)?;
            serde_json::to_value(presets).map_err(|e| e.to_string())
        }),
        "preset.add" => {
            let preset: Preset = from_params(params)?;
            state.write_mut(origin, &[Topic::Presets], |conn| {
                add_preset(conn, &preset).map(|()| Value::Null)
            })
        }
        "preset.update" => {
            let p: PresetUpdateParams = from_params(params)?;
            state.write_mut(origin, &[Topic::Presets], |conn| {
                update_preset(
                    conn,
                    &p.id,
                    &p.name,
                    &p.definition,
                    p.filter_strategy,
                    p.is_default,
                    p.modified_at,
                )
                .map(|()| Value::Null)
            })
        }
        "preset.delete" => {
            let p: PresetDeleteParams = from_params(params)?;
            state.write(origin, &[Topic::Presets], |conn| {
                delete_preset(conn, &p.id)?;
                Ok(Value::Null)
            })
        }
        "metadata.field.list" => state.read(|conn| -> Result<Value, String> {
            let rows = list_field_metadata(conn)?;
            serde_json::to_value(rows).map_err(|e| e.to_string())
        }),
        "metadata.field.set_visible" => {
            let p: MetadataFieldSetVisibleParams = from_params(params)?;
            state.write(origin, &[Topic::FieldMetadata], |conn| {
                set_field_visible(conn, &p.schema_name, &p.table_name, &p.field, p.visible)?;
                Ok(Value::Null)
            })
        }
        "metadata.field.set_order" => {
            let p: MetadataFieldSetOrderParams = from_params(params)?;
            state.write_mut(origin, &[Topic::FieldMetadata], |conn| {
                set_field_order(conn, &p.schema_name, &p.table_name, &p.orders)
                    .map(|()| Value::Null)
            })
        }
        "metadata.field.set_display" => {
            let p: MetadataFieldSetDisplayParams = from_params(params)?;
            state.write(origin, &[Topic::FieldMetadata], |conn| {
                upsert_field_metadata(
                    conn,
                    &p.schema_name,
                    &p.table_name,
                    &p.field,
                    "display",
                    &p.display,
                )?;
                Ok(Value::Null)
            })
        }
        "metadata.field.set_sorting" => {
            let p: MetadataFieldSetSortingParams = from_params(params)?;
            state.write(origin, &[Topic::FieldMetadata], |conn| {
                upsert_field_metadata(
                    conn,
                    &p.schema_name,
                    &p.table_name,
                    &p.field,
                    "sorting",
                    &p.sorting,
                )?;
                Ok(Value::Null)
            })
        }
        "metadata.table.list" => state.read(|conn| -> Result<Value, String> {
            let rows = list_table_metadata(conn)?;
            serde_json::to_value(rows).map_err(|e| e.to_string())
        }),
        "metadata.table.set_visible" => {
            let p: MetadataTableSetVisibleParams = from_params(params)?;
            state.write(origin, &[Topic::TableSettings], |conn| {
                upsert_table_metadata(conn, &p.schema_name, &p.table_name, "visible", &p.visible)?;
                Ok(Value::Null)
            })
        }
        "metadata.table.set_order" => {
            let p: MetadataTableSetOrderParams = from_params(params)?;
            state.write_mut(origin, &[Topic::TableSettings], |conn| {
                set_table_order(conn, &p.orders).map(|()| Value::Null)
            })
        }
        "metadata.table.set_querydown" => {
            let p: MetadataTableSetQuerydownParams = from_params(params)?;
            state.write(origin, &[Topic::TableSettings], |conn| {
                let column = table_querydown_column(p.setting);
                upsert_table_metadata(conn, &p.schema_name, &p.table_name, column, &p.text)?;
                Ok(Value::Null)
            })
        }
        "metadata.computed_column.list" => state.read(|conn| -> Result<Value, String> {
            let rows = list_computed_columns(conn)?;
            serde_json::to_value(rows).map_err(|e| e.to_string())
        }),
        "metadata.computed_column.set" => {
            let p: ComputedColumnRow = from_params(params)?;
            state.write(origin, &[Topic::ComputedColumns], |conn| {
                set_computed_column(conn, &p)?;
                Ok(Value::Null)
            })
        }
        "metadata.computed_column.rename" => {
            let p: MetadataComputedColumnRenameParams = from_params(params)?;
            state.write_mut(
                origin,
                &[Topic::ComputedColumns, Topic::FieldMetadata],
                |conn| {
                    rename_computed_column(
                        conn,
                        &p.schema_name,
                        &p.table_name,
                        &p.name,
                        &p.new_name,
                    )
                    .map(|()| Value::Null)
                },
            )
        }
        "metadata.computed_column.delete" => {
            let p: MetadataComputedColumnDeleteParams = from_params(params)?;
            state.write_mut(
                origin,
                &[Topic::ComputedColumns, Topic::FieldMetadata],
                |conn| {
                    delete_computed_column(conn, &p.schema_name, &p.table_name, &p.name)
                        .map(|()| Value::Null)
                },
            )
        }
        "metadata.custom_comparison.list" => state.read(|conn| -> Result<Value, String> {
            let rows = list_custom_comparisons(conn)?;
            serde_json::to_value(rows).map_err(|e| e.to_string())
        }),
        "metadata.custom_comparison.set" => {
            let p: CustomComparisonRow = from_params(params)?;
            state.write(origin, &[Topic::CustomComparisons], |conn| {
                set_custom_comparison(conn, &p)?;
                Ok(Value::Null)
            })
        }
        "metadata.custom_comparison.rename" => {
            let p: MetadataCustomComparisonRenameParams = from_params(params)?;
            state.write(origin, &[Topic::CustomComparisons], |conn| {
                rename_custom_comparison(conn, &p.schema_name, &p.table_name, &p.name, &p.new_name)
                    .map(|()| Value::Null)
            })
        }
        "metadata.custom_comparison.delete" => {
            let p: MetadataCustomComparisonDeleteParams = from_params(params)?;
            state.write(origin, &[Topic::CustomComparisons], |conn| {
                delete_custom_comparison(conn, &p.schema_name, &p.table_name, &p.name)
                    .map(|()| Value::Null)
            })
        }
        "keybinding.list" => state.read(|conn| -> Result<Value, String> {
            let bindings = list_keybindings(conn)?;
            serde_json::to_value(bindings).map_err(|e| e.to_string())
        }),
        "keybinding.set" => {
            let binding: Keybinding = from_params(params)?;
            state.write(origin, &[Topic::Keybindings], |conn| {
                set_keybinding(conn, &binding.command_id, binding.chord.as_deref())?;
                Ok(Value::Null)
            })
        }
        "keybinding.delete" => {
            let p: KeybindingDeleteParams = from_params(params)?;
            state.write(origin, &[Topic::Keybindings], |conn| {
                delete_keybinding(conn, &p.command_id)?;
                Ok(Value::Null)
            })
        }
        // The settings key/value store. A row exists only for a setting the user
        // has customized, so `setting.delete` is how the frontend resets one to
        // the default it holds in code — see `api_schema::Setting`.
        "setting.list" => state.read(|conn| -> Result<Value, String> {
            let settings = list_settings(conn)?;
            serde_json::to_value(settings).map_err(|e| e.to_string())
        }),
        "setting.set" => {
            let setting: Setting = from_params(params)?;
            state.write(origin, &[Topic::Settings], |conn| {
                set_setting(conn, &setting.key, &setting.value)?;
                Ok(Value::Null)
            })
        }
        "setting.delete" => {
            let p: SettingDeleteParams = from_params(params)?;
            state.write(origin, &[Topic::Settings], |conn| {
                delete_setting(conn, &p.key)?;
                Ok(Value::Null)
            })
        }
        // Statistics for every table at once, for the Data structure page. It
        // reads every row of every table under the connection lock, so on a
        // large collection it holds the other API methods up for as long as that
        // takes — which is why it's asked for by that page alone, and not at
        // boot alongside the introspection the compiler needs.
        "table.summarize" => state.read(|conn| -> Result<Value, String> {
            let tables = summarize_tables(conn)?;
            serde_json::to_value(tables).map_err(|e| e.to_string())
        }),
        // Re-scans the collection the server was started against — the same
        // pass `radiocrate-server scan` runs, and the one `serve` runs at boot
        // unless `--no-scan` is given. It takes no params: which directory to
        // scan is the server's to know, not the client's.
        //
        // The scan runs under the connection lock (like every other write), so
        // a large collection blocks the other API methods for as long as it
        // takes. Acceptable while this is a deliberate, one-at-a-time action a
        // person takes from the Settings menu and waits on.
        "collection.rescan" => state.write(origin, &[], |conn| {
            crate::scanner::scan(&state.collection_path, conn).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }),
        other => Err(format!("method not found: {other}")),
    }
}

fn from_params<T: serde::de::DeserializeOwned>(params: Value) -> Result<T, String> {
    serde_json::from_value(params).map_err(|e| e.to_string())
}

/// Every source with the definition of the row it wraps, in tree order.
fn list_sources(conn: &Connection) -> Result<Vec<Source>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT s.id::text, s.name, epoch(s.created_at)::bigint, \
             epoch(s.modified_at)::bigint, epoch(s.last_play)::bigint, \
             coalesce(q.definition, p.definition), s.source_folder::text, s.position, \
             s.query::text, s.playlist::text \
             FROM app.source s \
             LEFT JOIN app.query q ON q.id = s.query \
             LEFT JOIN app.playlist p ON p.id = s.playlist \
             ORDER BY s.position, s.created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let query_id: Option<String> = row.get(8)?;
            Ok(Source {
                id: row.get(0)?,
                // The schema's `check` guarantees exactly one of the two is set.
                kind: if query_id.is_some() {
                    SourceKind::Query
                } else {
                    SourceKind::Playlist
                },
                name: row.get(1)?,
                created_at: row.get(2)?,
                modified_at: row.get(3)?,
                last_play: row.get(4)?,
                definition: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                parent: row.get(6)?,
                position: row.get(7)?,
                query_id,
                playlist_id: row.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// Inserts a new query and the source that wraps it, in one transaction. The
/// `source`'s `query_id` names the new query row, and must differ from no id in
/// particular: callers may not assume it equals the source's `id`.
fn add_query(conn: &mut Connection, source: &Source) -> Result<(), String> {
    let Some(query_id) = source.query_id.as_deref() else {
        return Err("query.add: the source has no queryId".to_string());
    };
    if source.kind != SourceKind::Query || source.playlist_id.is_some() {
        return Err("query.add: the source must be a query".to_string());
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO app.query (id, definition) VALUES (TRY_CAST(? AS UUID), ?)",
        duckdb::params![query_id, source.definition],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO app.source (id, name, created_at, modified_at, last_play, source_folder, position, query) \
         VALUES (TRY_CAST(? AS UUID), ?, make_timestamp(? * 1000000)::timestamp_s, \
         make_timestamp(? * 1000000)::timestamp_s, make_timestamp(? * 1000000)::timestamp_s, \
         TRY_CAST(? AS UUID), ?, TRY_CAST(? AS UUID))",
        duckdb::params![
            source.id,
            source.name,
            source.created_at,
            source.modified_at,
            source.last_play,
            source.parent,
            source.position,
            query_id,
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// Deletes a query's source, then the query itself, in one transaction. `id` is
/// the source's id.
fn delete_query(conn: &mut Connection, id: &str) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let query_id: Option<String> = tx
        .query_row(
            "SELECT query::text FROM app.source WHERE id = TRY_CAST(? AS UUID)",
            duckdb::params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    let Some(query_id) = query_id else {
        // Already gone, or a playlist: neither is this method's to delete.
        return Ok(());
    };
    tx.execute(
        "DELETE FROM app.source WHERE id = TRY_CAST(? AS UUID)",
        duckdb::params![id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM app.query WHERE id = TRY_CAST(? AS UUID)",
        duckdb::params![query_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

fn record_play(conn: &Connection, id: &str, last_play: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE app.source SET last_play = make_timestamp(? * 1000000)::timestamp_s WHERE id = TRY_CAST(? AS UUID)",
        duckdb::params![last_play, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn rename_source(conn: &Connection, id: &str, name: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE app.source SET name = ? WHERE id = TRY_CAST(? AS UUID)",
        duckdb::params![name, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Writes every placement in one transaction, so a move that renumbers two
/// folders' worth of siblings lands whole or not at all.
fn arrange(conn: &mut Connection, placements: &[Placement]) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for p in placements {
        let sql = match p.kind {
            TreeItemKind::Source => {
                "UPDATE app.source SET source_folder = TRY_CAST(? AS UUID), position = ? \
                 WHERE id = TRY_CAST(? AS UUID)"
            }
            TreeItemKind::Folder => {
                "UPDATE app.source_folder SET parent = TRY_CAST(? AS UUID), position = ? \
                 WHERE id = TRY_CAST(? AS UUID)"
            }
        };
        tx.execute(sql, duckdb::params![p.parent, p.position, p.id])
            .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

fn list_folders(conn: &Connection) -> Result<Vec<SourceFolder>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id::text, name, parent::text, position \
             FROM app.source_folder ORDER BY position, name",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(SourceFolder {
                id: row.get(0)?,
                name: row.get(1)?,
                parent: row.get(2)?,
                position: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

fn add_folder(conn: &Connection, folder: &SourceFolder) -> Result<(), String> {
    conn.execute(
        "INSERT INTO app.source_folder (id, name, parent, position) \
         VALUES (TRY_CAST(? AS UUID), ?, TRY_CAST(? AS UUID), ?)",
        duckdb::params![folder.id, folder.name, folder.parent, folder.position],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn rename_folder(conn: &Connection, id: &str, name: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE app.source_folder SET name = ? WHERE id = TRY_CAST(? AS UUID)",
        duckdb::params![name, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn delete_folder(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM app.source_folder WHERE id = TRY_CAST(? AS UUID)",
        duckdb::params![id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn list_presets(conn: &Connection) -> Result<Vec<Preset>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id::text, name, base_table, section, definition, filter_strategy, \
             is_default, epoch(created_at)::bigint, epoch(modified_at)::bigint \
             FROM app.preset ORDER BY name",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Preset {
                id: row.get(0)?,
                name: row.get(1)?,
                base_table: row.get(2)?,
                section: row.get(3)?,
                definition: row.get(4)?,
                filter_strategy: FilterStrategy::from_stored(&row.get::<_, String>(5)?),
                is_default: row.get(6)?,
                created_at: row.get(7)?,
                modified_at: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// Clears `is_default` on whichever other preset is the table's default for
/// `section`, so that the preset `id` can take its place. A table has at most one
/// default sort and one default display (see migration 0007). Filter defaults
/// combine, so they never displace one another.
fn displace_default(
    conn: &Connection,
    id: &str,
    base_table: &str,
    section: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE app.preset SET is_default = false \
         WHERE is_default AND section IN ('sort', 'display') \
         AND base_table = ? AND section = ? AND id <> TRY_CAST(? AS UUID)",
        duckdb::params![base_table, section, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Inserts a preset, in one transaction with displacing the default it replaces
/// when it's a default itself.
fn add_preset(conn: &mut Connection, preset: &Preset) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    if preset.is_default {
        displace_default(&tx, &preset.id, &preset.base_table, &preset.section)?;
    }
    tx.execute(
        "INSERT INTO app.preset (id, name, base_table, section, definition, filter_strategy, \
         is_default, created_at, modified_at) \
         VALUES (TRY_CAST(? AS UUID), ?, ?, ?, ?, ?, ?, make_timestamp(? * 1000000)::timestamp_s, \
         make_timestamp(? * 1000000)::timestamp_s)",
        duckdb::params![
            preset.id,
            preset.name,
            preset.base_table,
            preset.section,
            preset.definition,
            preset.filter_strategy.as_str(),
            preset.is_default,
            preset.created_at,
            preset.modified_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// Rewrites a preset's editable fields, in one transaction with displacing the
/// default it replaces when it's now a default.
fn update_preset(
    conn: &mut Connection,
    id: &str,
    name: &str,
    definition: &str,
    filter_strategy: FilterStrategy,
    is_default: bool,
    modified_at: i64,
) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    if is_default {
        let slot: Option<(String, String)> = tx
            .query_row(
                "SELECT base_table, section FROM app.preset WHERE id = TRY_CAST(? AS UUID)",
                duckdb::params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some((base_table, section)) = slot {
            displace_default(&tx, id, &base_table, &section)?;
        }
    }
    tx.execute(
        "UPDATE app.preset SET name = ?, definition = ?, filter_strategy = ?, is_default = ?, \
         modified_at = make_timestamp(? * 1000000)::timestamp_s \
         WHERE id = TRY_CAST(? AS UUID)",
        duckdb::params![
            name,
            definition,
            filter_strategy.as_str(),
            is_default,
            modified_at,
            id
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

fn delete_preset(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM app.preset WHERE id = TRY_CAST(? AS UUID)",
        duckdb::params![id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn list_field_metadata(conn: &Connection) -> Result<Vec<FieldMetadataRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT schema_name, table_name, union_extract(field, 'column_name'), \
             union_extract(field, 'multi_link').related_table_name, \
             union_extract(field, 'multi_link').fk_column_name, visible, \"order\", display, \
             sorting, union_extract(field, 'contextual_query')::text, \
             union_extract(field, 'computed_column') \
             FROM metadata.field \
             ORDER BY schema_name, table_name, union_tag(field)::text, field::text",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let column_name: Option<String> = row.get(2)?;
            let contextual_query: Option<String> = row.get(9)?;
            let computed_column: Option<String> = row.get(10)?;
            let field = match (column_name, contextual_query, computed_column) {
                (Some(name), _, _) => FieldRef::ColumnName(name),
                (None, Some(id), _) => FieldRef::ContextualQuery(id),
                (None, None, Some(name)) => FieldRef::ComputedColumn(name),
                (None, None, None) => FieldRef::MultiLink(MultiLink {
                    related_table_name: row.get(3)?,
                    fk_column_name: row.get(4)?,
                }),
            };
            Ok(FieldMetadataRow {
                schema_name: row.get(0)?,
                table_name: row.get(1)?,
                field,
                visible: row.get(5)?,
                order: row.get(6)?,
                display: row.get(7)?,
                sorting: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// The SQL building `field` as a value of the `metadata.field.field` union, and the
/// parameters it binds.
fn field_ref_sql(field: &FieldRef) -> (&'static str, Vec<&str>) {
    match field {
        FieldRef::ColumnName(name) => ("union_value(column_name := ?)", vec![name]),
        FieldRef::MultiLink(link) => (
            "union_value(multi_link := {'related_table_name': ?, 'fk_column_name': ?})",
            vec![&link.related_table_name, &link.fk_column_name],
        ),
        FieldRef::ContextualQuery(id) => {
            ("union_value(contextual_query := CAST(? AS UUID))", vec![id])
        }
        FieldRef::ComputedColumn(name) => ("union_value(computed_column := ?)", vec![name]),
    }
}

/// Creates the row of one field if it has none, or sets `column` on the one it has,
/// leaving the rest of that row as it is. See migration 0010 on why the conflict has
/// no target.
fn upsert_field_metadata(
    conn: &Connection,
    schema_name: &str,
    table_name: &str,
    field: &FieldRef,
    column: &'static str,
    value: &dyn duckdb::ToSql,
) -> Result<(), String> {
    let (field_sql, field_params) = field_ref_sql(field);
    let sql = format!(
        "INSERT INTO metadata.field (schema_name, table_name, field, {column}) \
         VALUES (?, ?, {field_sql}, ?) \
         ON CONFLICT DO UPDATE SET {column} = excluded.{column}"
    );
    let mut params: Vec<&dyn duckdb::ToSql> = vec![&schema_name, &table_name];
    params.extend(field_params.iter().map(|p| p as &dyn duckdb::ToSql));
    params.push(value);
    conn.execute(&sql, duckdb::params_from_iter(params))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Sets one field's visibility, creating its row if this is the first thing
/// customized about it. Leaves its `order` as it is.
fn set_field_visible(
    conn: &Connection,
    schema_name: &str,
    table_name: &str,
    field: &FieldRef,
    visible: bool,
) -> Result<(), String> {
    upsert_field_metadata(conn, schema_name, table_name, field, "visible", &visible)
}

/// Sets the sort keys of a table's fields in one transaction, creating the rows of
/// any field not customized yet. Leaves their `visible` as it is.
fn set_field_order(
    conn: &mut Connection,
    schema_name: &str,
    table_name: &str,
    orders: &[FieldOrder],
) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for entry in orders {
        upsert_field_metadata(
            &tx,
            schema_name,
            table_name,
            &entry.field,
            "\"order\"",
            &entry.order,
        )?;
    }
    tx.commit().map_err(|e| e.to_string())
}

fn list_table_metadata(conn: &Connection) -> Result<Vec<TableMetadataRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT schema_name, table_name, visible, \"order\", default_text_search, \
             linked_record_comparison, record_picker_sorting, record_picker_display \
             FROM metadata.\"table\" ORDER BY schema_name, table_name",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(TableMetadataRow {
                schema_name: row.get(0)?,
                table_name: row.get(1)?,
                visible: row.get(2)?,
                order: row.get(3)?,
                default_text_search: row.get(4)?,
                linked_record_comparison: row.get(5)?,
                record_picker_sorting: row.get(6)?,
                record_picker_display: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// The column of `metadata.table` that holds `setting`.
fn table_querydown_column(setting: TableQuerydownSetting) -> &'static str {
    match setting {
        TableQuerydownSetting::DefaultTextSearch => "default_text_search",
        TableQuerydownSetting::LinkedRecordComparison => "linked_record_comparison",
        TableQuerydownSetting::RecordPickerSorting => "record_picker_sorting",
        TableQuerydownSetting::RecordPickerDisplay => "record_picker_display",
    }
}

/// Creates the row of one table if it has none, or sets `column` on the one it has,
/// leaving the rest of that row as it is.
fn upsert_table_metadata(
    conn: &Connection,
    schema_name: &str,
    table_name: &str,
    column: &'static str,
    value: &dyn duckdb::ToSql,
) -> Result<(), String> {
    let sql = format!(
        "INSERT INTO metadata.\"table\" (schema_name, table_name, {column}) VALUES (?, ?, ?) \
         ON CONFLICT (schema_name, table_name) DO UPDATE SET {column} = excluded.{column}"
    );
    conn.execute(&sql, duckdb::params![schema_name, table_name, value])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Sets the sort keys of tables in one transaction, creating the rows of any table
/// not customized yet. Leaves the rest of their rows as they are.
fn set_table_order(conn: &mut Connection, orders: &[TableOrder]) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for entry in orders {
        upsert_table_metadata(
            &tx,
            &entry.schema_name,
            &entry.table_name,
            "\"order\"",
            &entry.order,
        )?;
    }
    tx.commit().map_err(|e| e.to_string())
}

fn list_computed_columns(conn: &Connection) -> Result<Vec<ComputedColumnRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT schema_name, table_name, name, expression FROM metadata.computed_column \
             ORDER BY schema_name, table_name, name",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ComputedColumnRow {
                schema_name: row.get(0)?,
                table_name: row.get(1)?,
                name: row.get(2)?,
                expression: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Creates a computed column, or sets the expression of the one of that name.
fn set_computed_column(conn: &Connection, column: &ComputedColumnRow) -> Result<(), String> {
    conn.execute(
        "INSERT INTO metadata.computed_column (schema_name, table_name, name, expression) \
         VALUES (?, ?, ?, ?) \
         ON CONFLICT (schema_name, table_name, name) DO UPDATE SET expression = excluded.expression",
        duckdb::params![
            column.schema_name,
            column.table_name,
            column.name,
            column.expression
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The condition picking out a computed column's row of `metadata.field`, binding
/// the table's schema, then its name, and then the column's.
const COMPUTED_COLUMN_FIELD: &str = "schema_name = ? AND table_name = ? \
     AND union_tag(field) = 'computed_column' \
     AND union_extract(field, 'computed_column') = ?";

/// Renames a computed column, and with it the row of `metadata.field` keyed by its
/// name, so what's customized about its field stays with it. One transaction: a
/// name another of the table's computed columns has fails, and changes nothing.
fn rename_computed_column(
    conn: &mut Connection,
    schema_name: &str,
    table_name: &str,
    name: &str,
    new_name: &str,
) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE metadata.computed_column SET name = ? \
         WHERE schema_name = ? AND table_name = ? AND name = ?",
        duckdb::params![new_name, schema_name, table_name, name],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        &format!(
            "UPDATE metadata.field SET field = union_value(computed_column := ?) \
             WHERE {COMPUTED_COLUMN_FIELD}"
        ),
        duckdb::params![new_name, schema_name, table_name, name],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// Deletes a computed column, and with it the row of `metadata.field` keyed by its
/// name: a later column given the same name starts afresh.
fn delete_computed_column(
    conn: &mut Connection,
    schema_name: &str,
    table_name: &str,
    name: &str,
) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM metadata.computed_column \
         WHERE schema_name = ? AND table_name = ? AND name = ?",
        duckdb::params![schema_name, table_name, name],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        &format!("DELETE FROM metadata.field WHERE {COMPUTED_COLUMN_FIELD}"),
        duckdb::params![schema_name, table_name, name],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

fn list_custom_comparisons(conn: &Connection) -> Result<Vec<CustomComparisonRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT schema_name, table_name, name, expression \
             FROM metadata.custom_comparison \
             ORDER BY schema_name, table_name, name",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(CustomComparisonRow {
                schema_name: row.get(0)?,
                table_name: row.get(1)?,
                name: row.get(2)?,
                expression: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Creates a custom comparison, or sets the condition of the one of that name.
fn set_custom_comparison(conn: &Connection, row: &CustomComparisonRow) -> Result<(), String> {
    conn.execute(
        "INSERT INTO metadata.custom_comparison (schema_name, table_name, name, expression) \
         VALUES (?, ?, ?, ?) \
         ON CONFLICT (schema_name, table_name, name) DO UPDATE SET expression = excluded.expression",
        duckdb::params![row.schema_name, row.table_name, row.name, row.expression],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Renames a custom comparison. A name another of the table's comparisons has
/// fails, and changes nothing.
fn rename_custom_comparison(
    conn: &Connection,
    schema_name: &str,
    table_name: &str,
    name: &str,
    new_name: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE metadata.custom_comparison SET name = ? \
         WHERE schema_name = ? AND table_name = ? AND name = ?",
        duckdb::params![new_name, schema_name, table_name, name],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn delete_custom_comparison(
    conn: &Connection,
    schema_name: &str,
    table_name: &str,
    name: &str,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM metadata.custom_comparison \
         WHERE schema_name = ? AND table_name = ? AND name = ?",
        duckdb::params![schema_name, table_name, name],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn list_keybindings(conn: &Connection) -> Result<Vec<Keybinding>, String> {
    let mut stmt = conn
        .prepare("SELECT command_id, chord FROM settings.keybinding ORDER BY command_id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Keybinding {
                command_id: row.get(0)?,
                chord: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

fn set_keybinding(conn: &Connection, command_id: &str, chord: Option<&str>) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO settings.keybinding (command_id, chord) VALUES (?, ?)",
        duckdb::params![command_id, chord],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn delete_keybinding(conn: &Connection, command_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM settings.keybinding WHERE command_id = ?",
        duckdb::params![command_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn list_settings(conn: &Connection) -> Result<Vec<Setting>, String> {
    let mut stmt = conn
        .prepare("SELECT \"key\", \"value\" FROM settings.settings ORDER BY \"key\"")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Setting {
                key: row.get(0)?,
                value: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO settings.settings (\"key\", \"value\") VALUES (?, ?)",
        duckdb::params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn delete_setting(conn: &Connection, key: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM settings.settings WHERE \"key\" = ?",
        duckdb::params![key],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// What `SUMMARIZE` reports for every table (and view) of the database itself,
/// in every schema: the app's own in `main`, and those of `metadata`, `settings`
/// and any schema the user has made, which the Data structure page lists too. That
/// leaves out attached databases and any session's temp tables. In schema then
/// table name order.
fn summarize_tables(conn: &Connection) -> Result<Vec<TableSummary>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT table_catalog, table_schema, table_name FROM information_schema.tables \
             WHERE table_catalog = current_database() \
             AND table_schema NOT IN ('information_schema', 'pg_catalog') \
             ORDER BY table_schema, table_name",
        )
        .map_err(|e| e.to_string())?;
    let names: Vec<(String, String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    names
        .into_iter()
        .map(|(catalog, schema, name)| summarize_table(conn, &catalog, schema, name))
        .collect()
}

/// One table's `SUMMARIZE`. The table is named in full, catalog and all: a temp
/// table of the same name sits in a `main` schema of its own.
fn summarize_table(
    conn: &Connection,
    catalog: &str,
    schema: String,
    name: String,
) -> Result<TableSummary, String> {
    let sql = format!(
        "SELECT column_name, approx_unique, null_percentage::DOUBLE, \"count\" \
         FROM (SUMMARIZE {}.{}.{})",
        crate::dml::quote_ident(catalog),
        crate::dml::quote_ident(&schema),
        crate::dml::quote_ident(&name),
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    // Every column's row reports the table's row count; a table has at least one.
    let mut row_count = 0;
    let columns = stmt
        .query_map([], |row| {
            row_count = row.get(3)?;
            Ok(ColumnSummary {
                name: row.get(0)?,
                approx_unique: row.get(1)?,
                null_percentage: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(TableSummary {
        schema,
        name,
        row_count,
        columns,
    })
}

/// Writes `definition` to whichever row (query or playlist) the source wraps,
/// and bumps the source's `modified_at`, in one transaction.
fn update_definition(
    conn: &mut Connection,
    id: &str,
    definition: &str,
    modified_at: i64,
) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    // At most one of these matches a row: the source wraps exactly one of the two.
    for table in ["query", "playlist"] {
        tx.execute(
            &format!(
                "UPDATE app.{table} SET definition = ? \
                 WHERE id = (SELECT {table} FROM app.source WHERE id = TRY_CAST(? AS UUID))"
            ),
            duckdb::params![definition, id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.execute(
        "UPDATE app.source SET modified_at = make_timestamp(? * 1000000)::timestamp_s \
         WHERE id = TRY_CAST(? AS UUID)",
        duckdb::params![modified_at, id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    const S1: &str = "00000000-0000-0000-0000-000000000001";
    const S2: &str = "00000000-0000-0000-0000-000000000002";
    const Q1: &str = "00000000-0000-0000-0000-0000000000e1";
    const Q2: &str = "00000000-0000-0000-0000-0000000000e2";
    const P1: &str = "00000000-0000-0000-0000-0000000000a1";
    const F1: &str = "00000000-0000-0000-0000-0000000000f1";

    /// A fresh in-memory database with the real migration schema applied, less
    /// the app's default customizations (migration 0020), so that each test
    /// starts from only what it puts there itself.
    fn setup() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_through(&mut conn, u32::MAX);
        conn.execute_batch(
            "DELETE FROM metadata.\"table\";
             DELETE FROM metadata.field;
             DELETE FROM metadata.contextual_query;
             DELETE FROM app.preset;
             DELETE FROM app.source;
             DELETE FROM app.query;",
        )
        .unwrap();
        conn
    }

    /// A query source whose query id differs from its own, as new ones do.
    fn query(id: &str, query_id: &str, name: &str, position: i32) -> Source {
        Source {
            id: id.to_string(),
            kind: SourceKind::Query,
            name: name.to_string(),
            created_at: 1_700_000_000,
            modified_at: 1_700_000_000,
            last_play: 1_700_000_000,
            definition: "{}".to_string(),
            parent: None,
            position,
            query_id: Some(query_id.to_string()),
            playlist_id: None,
        }
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    #[test]
    fn migration_0006_moves_queries_into_sources() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_through(&mut conn, 5);
        conn.execute_batch(&format!(
            "INSERT INTO query_folder (id, name, parent, position) VALUES ('{F1}', 'folder', NULL, 3);
             INSERT INTO query (id, name, created_at, modified_at, last_play, definition, parent, position)
             VALUES ('{Q1}', 'filed', '2024-01-02 03:04:05', '2024-02-03 04:05:06', '2024-03-04 05:06:07', 'def1', '{F1}', 7),
                    ('{Q2}', 'unpositioned', '2024-01-01 00:00:00', '2024-01-01 00:00:00', '2024-01-01 00:00:00', 'def2', NULL, NULL);"
        ))
        .unwrap();

        // Read through the RPCs, which find the tables where migration 0018 puts
        // them. Not through 0020, whose saved queries a library has as well.
        crate::db::migrate_through(&mut conn, 19);

        let sources = list_sources(&conn).unwrap();
        assert_eq!(sources.len(), 2);
        let filed = sources.iter().find(|s| s.name == "filed").unwrap();
        // The source reuses its query's id, so persisted tabs survive.
        assert_eq!(filed.id, Q1);
        assert_eq!(filed.query_id.as_deref(), Some(Q1));
        assert_eq!(filed.kind, SourceKind::Query);
        assert_eq!(filed.definition, "def1");
        assert_eq!(filed.parent.as_deref(), Some(F1));
        assert_eq!(filed.position, 7);
        assert_eq!(
            (filed.created_at, filed.modified_at, filed.last_play),
            (1_704_164_645, 1_706_933_106, 1_709_528_767)
        );
        let unpositioned = sources.iter().find(|s| s.id == Q2).unwrap();
        assert_eq!(
            (unpositioned.parent.as_deref(), unpositioned.position),
            (None, 0)
        );

        // The folder table is renamed, with its rows intact.
        assert_eq!(list_folders(&conn).unwrap()[0].id, F1);
        // `query` keeps only what is specific to a query.
        let columns: Vec<String> = conn
            .prepare(
                "SELECT column_name FROM information_schema.columns \
                 WHERE table_name = 'query' ORDER BY ordinal_position",
            )
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(columns, ["id", "definition"]);
    }

    fn preset(id: &str, name: &str, base_table: &str, section: &str, is_default: bool) -> Preset {
        Preset {
            id: id.to_string(),
            name: name.to_string(),
            base_table: base_table.to_string(),
            section: section.to_string(),
            definition: String::new(),
            filter_strategy: FilterStrategy::Querydown,
            is_default,
            created_at: 1_700_000_000,
            modified_at: 1_700_000_000,
        }
    }

    /// Every preset's name, with whether it's a default, in name order. Read
    /// directly rather than through `list_presets`, so that a test of an earlier
    /// migration can read them without the columns a later one adds.
    fn preset_defaults(conn: &Connection) -> Vec<(String, bool)> {
        conn.prepare("SELECT name, is_default FROM app.preset ORDER BY name")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    #[test]
    fn migration_0007_keeps_one_default_sort_and_display_per_table() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_through(&mut conn, 6);
        conn.execute_batch(&format!(
            "INSERT INTO preset (id, name, base_table, section, definition, is_default, created_at, modified_at)
             VALUES ('{S1}', 'filter b', 'track', 'filter', '', true, now(), now()),
                    ('{S2}', 'filter a', 'track', 'filter', '', true, now(), now()),
                    ('{Q1}', 'sort z', 'track', 'sort', '', true, now(), now()),
                    ('{Q2}', 'sort m', 'track', 'sort', '', true, now(), now()),
                    ('{P1}', 'album sort', 'album', 'sort', '', true, now(), now()),
                    ('{F1}', 'display', 'track', 'display', '', false, now(), now());"
        ))
        .unwrap();

        // Read through the RPCs, which find the tables where migration 0018 puts them.
        // Not through 0020, whose default presets a library with presets of its own
        // goes without.
        crate::db::migrate_through(&mut conn, 19);

        // The first default sort by name keeps it; filter defaults all keep theirs,
        // and so does another table's sort.
        assert_eq!(
            preset_defaults(&conn),
            [
                ("album sort".to_string(), true),
                ("display".to_string(), false),
                ("filter a".to_string(), true),
                ("filter b".to_string(), true),
                ("sort m".to_string(), true),
                ("sort z".to_string(), false),
            ]
        );
    }

    #[test]
    fn migration_0018_moves_the_apps_records_into_their_own_schema() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_through(&mut conn, 17);
        conn.execute_batch(&format!(
            "INSERT INTO source_folder (id, name, parent, position) VALUES ('{F1}', 'folder', NULL, 2);
             INSERT INTO query (id, definition) VALUES ('{Q1}', 'def');
             INSERT INTO playlist (id, definition) VALUES ('{P1}', '{{}}');
             INSERT INTO source (id, name, created_at, modified_at, last_play, source_folder, position, query, playlist)
             VALUES ('{S1}', 'q', '2024-01-01', '2024-01-01', '2024-01-01', '{F1}', 3, '{Q1}', NULL),
                    ('{S2}', 'p', '2024-01-01', '2024-01-01', '2024-01-01', NULL, 4, NULL, '{P1}');
             INSERT INTO playlist_track (id, playlist, track, position)
             VALUES (uuid(), '{P1}', uuid(), 1.5);
             INSERT INTO preset (id, name, base_table, section, definition, is_default, created_at, modified_at)
             VALUES ('{Q2}', 'by year', 'track', 'sort', 'x', true, now(), now());
             INSERT INTO contextual_query (id, table_name, name, query)
             VALUES (uuid(), 'track', 'Same album', NULL);"
        ))
        .unwrap();

        crate::db::migrate_through(&mut conn, 18);

        let sources = list_sources(&conn).unwrap();
        assert_eq!(sources.len(), 2);
        let q = sources.iter().find(|s| s.id == S1).unwrap();
        assert_eq!(
            (q.definition.as_str(), q.parent.as_deref(), q.position),
            ("def", Some(F1), 3)
        );
        assert_eq!(list_folders(&conn).unwrap()[0].id, F1);
        assert_eq!(preset_defaults(&conn), [("by year".to_string(), true)]);
        assert_eq!(
            count(
                &conn,
                "SELECT count(*) FROM app.playlist_track WHERE position = 1.5"
            ),
            1
        );
        assert_eq!(count(&conn, "SELECT count(*) FROM app.contextual_query"), 1);
        // Nothing of them is left in `main`.
        assert_eq!(
            count(
                &conn,
                "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'main' \
                 AND table_name IN ('source', 'source_folder', 'query', 'playlist', \
                 'playlist_track', 'preset', 'contextual_query')"
            ),
            0
        );
        // The constraints came along: a source wraps exactly one thing, and a table has one
        // default sort.
        assert!(
            conn.execute_batch(
                "INSERT INTO app.source (id, name, created_at, modified_at, last_play) \
                 VALUES ('00000000-0000-0000-0000-0000000000b9', 'x', now(), now(), now())"
            )
            .is_err()
        );
        assert!(
            conn.execute_batch(
                "INSERT INTO app.preset (id, name, base_table, section, definition, is_default, created_at, modified_at) \
                 VALUES ('00000000-0000-0000-0000-0000000000b9', 'x', 'track', 'sort', '', true, now(), now())"
            )
            .is_err()
        );
    }

    #[test]
    fn a_table_has_at_most_one_default_sort_and_display() {
        let conn = setup();
        let insert = |id: &str, base_table: &str, section: &str, is_default: bool| {
            conn.execute_batch(&format!(
                "INSERT INTO app.preset (id, name, base_table, section, definition, is_default, created_at, modified_at) \
                 VALUES ('{id}', 'x', '{base_table}', '{section}', '', {is_default}, now(), now())"
            ))
        };
        insert(S1, "track", "filter", true).unwrap();
        insert(S2, "track", "filter", true).unwrap();
        insert(Q1, "track", "sort", true).unwrap();
        insert(Q2, "track", "sort", false).unwrap();
        assert!(
            insert(P1, "track", "sort", true).is_err(),
            "two default sorts"
        );
        insert(P1, "album", "sort", true).unwrap();
        insert(F1, "track", "display", true).unwrap();
    }

    #[test]
    fn a_new_default_sort_displaces_the_old_one() {
        let mut conn = setup();
        add_preset(&mut conn, &preset(S1, "a", "track", "sort", true)).unwrap();
        add_preset(&mut conn, &preset(S2, "b", "album", "sort", true)).unwrap();
        add_preset(&mut conn, &preset(Q1, "c", "track", "filter", true)).unwrap();

        add_preset(&mut conn, &preset(Q2, "d", "track", "sort", true)).unwrap();
        assert_eq!(
            preset_defaults(&conn),
            [
                ("a".to_string(), false),
                ("b".to_string(), true),
                ("c".to_string(), true),
                ("d".to_string(), true),
            ]
        );

        update_preset(
            &mut conn,
            S1,
            "a",
            "",
            FilterStrategy::Querydown,
            true,
            1_700_000_001,
        )
        .unwrap();
        assert_eq!(preset_defaults(&conn)[0], ("a".to_string(), true));
        assert_eq!(preset_defaults(&conn)[3], ("d".to_string(), false));
    }

    #[test]
    fn default_filters_never_displace_one_another() {
        let mut conn = setup();
        add_preset(&mut conn, &preset(S1, "a", "track", "filter", true)).unwrap();
        add_preset(&mut conn, &preset(S2, "b", "track", "filter", false)).unwrap();
        update_preset(
            &mut conn,
            S2,
            "b",
            "",
            FilterStrategy::Querydown,
            true,
            1_700_000_001,
        )
        .unwrap();
        assert_eq!(
            preset_defaults(&conn),
            [("a".to_string(), true), ("b".to_string(), true)]
        );
    }

    #[test]
    fn a_preset_keeps_its_filter_strategy() {
        let mut conn = setup();
        add_preset(&mut conn, &preset(S1, "a", "track", "filter", false)).unwrap();
        let strategy = |conn: &Connection| list_presets(conn).unwrap()[0].filter_strategy;
        assert_eq!(strategy(&conn), FilterStrategy::Querydown);

        update_preset(
            &mut conn,
            S1,
            "a",
            "café",
            FilterStrategy::BasicText,
            false,
            1_700_000_001,
        )
        .unwrap();
        assert_eq!(strategy(&conn), FilterStrategy::BasicText);

        let mut added = preset(S2, "b", "track", "filter", false);
        added.filter_strategy = FilterStrategy::BasicText;
        add_preset(&mut conn, &added).unwrap();
        assert_eq!(
            list_presets(&conn).unwrap()[1].filter_strategy,
            FilterStrategy::BasicText
        );
    }

    #[test]
    fn migration_0021_reads_existing_presets_as_querydown() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_through(&mut conn, 20);
        let insert = |conn: &Connection, id: &str| {
            conn.execute_batch(&format!(
                "INSERT INTO app.preset (id, name, base_table, section, definition, is_default, created_at, modified_at)
                 VALUES ('{id}', 'sort {id}', 'nothing', 'sort', '', true, now(), now());"
            ))
        };
        insert(&conn, S1).unwrap();
        crate::db::migrate_through(&mut conn, 21);
        let presets = list_presets(&conn).unwrap();
        let preset = presets.iter().find(|p| p.id == S1).unwrap();
        assert_eq!(preset.filter_strategy, FilterStrategy::Querydown);
        assert!(preset.is_default);
        assert!(
            presets
                .iter()
                .all(|p| p.filter_strategy == FilterStrategy::Querydown)
        );
        // The default-sort index came back with the column.
        assert!(insert(&conn, S2).is_err(), "two default sorts");
    }

    #[test]
    fn a_source_wraps_exactly_one_query_or_playlist() {
        let conn = setup();
        let insert = |id: &str, query: &str, playlist: &str| {
            conn.execute_batch(&format!(
                "INSERT INTO app.source (id, name, created_at, modified_at, last_play, query, playlist) \
                 VALUES ('{id}', 'x', now(), now(), now(), {query}, {playlist})"
            ))
        };
        assert!(insert(S1, "NULL", "NULL").is_err(), "wraps neither");
        assert!(
            insert(S1, &format!("'{Q1}'"), &format!("'{P1}'")).is_err(),
            "wraps both"
        );
        insert(S1, &format!("'{Q1}'"), "NULL").unwrap();
        assert!(
            insert(S2, &format!("'{Q1}'"), "NULL").is_err(),
            "two sources wrap one query"
        );
        insert(S2, "NULL", &format!("'{P1}'")).unwrap();
        assert!(
            insert(Q2, "NULL", &format!("'{P1}'")).is_err(),
            "two sources wrap one playlist"
        );
    }

    #[test]
    fn source_list_returns_both_kinds() {
        let mut conn = setup();
        add_query(&mut conn, &query(S1, Q1, "a query", 1)).unwrap();
        conn.execute_batch(&format!(
            "INSERT INTO app.playlist (id, definition) VALUES ('{P1}', 'pdef');
             INSERT INTO app.source (id, name, created_at, modified_at, last_play, position, playlist)
             VALUES ('{S2}', 'a playlist', now(), now(), now(), 0, '{P1}');"
        ))
        .unwrap();
        let sources = list_sources(&conn).unwrap();
        let summary: Vec<_> = sources
            .iter()
            .map(|s| (s.name.as_str(), s.kind, s.definition.as_str()))
            .collect();
        assert_eq!(
            summary,
            [
                ("a playlist", SourceKind::Playlist, "pdef"),
                ("a query", SourceKind::Query, "{}"),
            ]
        );
        assert_eq!(sources[0].playlist_id.as_deref(), Some(P1));
        assert_eq!(sources[0].query_id, None);
        assert_eq!(sources[1].query_id.as_deref(), Some(Q1));
    }

    #[test]
    fn update_definition_writes_the_wrapped_row() {
        let mut conn = setup();
        add_query(&mut conn, &query(S1, Q1, "q", 0)).unwrap();
        conn.execute_batch(&format!(
            "INSERT INTO app.playlist (id, definition) VALUES ('{P1}', 'old');
             INSERT INTO app.source (id, name, created_at, modified_at, last_play, playlist)
             VALUES ('{S2}', 'p', now(), now(), now(), '{P1}');"
        ))
        .unwrap();
        update_definition(&mut conn, S1, "new query", 1_800_000_000).unwrap();
        update_definition(&mut conn, S2, "new playlist", 1_800_000_001).unwrap();
        let sources = list_sources(&conn).unwrap();
        let by_id = |id: &str| sources.iter().find(|s| s.id == id).unwrap();
        assert_eq!(
            (by_id(S1).definition.as_str(), by_id(S1).modified_at),
            ("new query", 1_800_000_000)
        );
        assert_eq!(
            (by_id(S2).definition.as_str(), by_id(S2).modified_at),
            ("new playlist", 1_800_000_001)
        );
    }

    #[test]
    fn query_add_and_delete_span_both_tables() {
        let mut conn = setup();
        add_query(&mut conn, &query(S1, Q1, "q", 0)).unwrap();
        assert_eq!(count(&conn, "SELECT count(*) FROM app.query"), 1);
        delete_query(&mut conn, S1).unwrap();
        assert_eq!(count(&conn, "SELECT count(*) FROM app.source"), 0);
        assert_eq!(count(&conn, "SELECT count(*) FROM app.query"), 0);
    }

    #[test]
    fn query_add_rejects_a_playlist() {
        let mut conn = setup();
        let mut source = query(S1, Q1, "q", 0);
        source.kind = SourceKind::Playlist;
        assert!(add_query(&mut conn, &source).is_err());
        source.kind = SourceKind::Query;
        source.query_id = None;
        assert!(add_query(&mut conn, &source).is_err());
        assert_eq!(count(&conn, "SELECT count(*) FROM app.query"), 0);
    }

    #[test]
    fn rename_and_record_play_target_the_source() {
        let mut conn = setup();
        add_query(&mut conn, &query(S1, Q1, "old", 0)).unwrap();
        rename_source(&conn, S1, "new").unwrap();
        record_play(&conn, S1, 1_800_000_000).unwrap();
        let s = &list_sources(&conn).unwrap()[0];
        assert_eq!((s.name.as_str(), s.last_play), ("new", 1_800_000_000));
    }

    #[test]
    fn sources_list_in_position_order() {
        let mut conn = setup();
        add_query(&mut conn, &query(S1, Q1, "second", 5)).unwrap();
        add_query(&mut conn, &query(S2, Q2, "first", -1)).unwrap();
        let names: Vec<_> = list_sources(&conn)
            .unwrap()
            .into_iter()
            .map(|q| q.name)
            .collect();
        assert_eq!(names, ["first", "second"]);
    }

    fn column(name: &str) -> FieldRef {
        FieldRef::ColumnName(name.to_string())
    }

    fn multi_link(related_table_name: &str, fk_column_name: &str) -> FieldRef {
        FieldRef::MultiLink(MultiLink {
            related_table_name: related_table_name.to_string(),
            fk_column_name: fk_column_name.to_string(),
        })
    }

    fn contextual_query(id: &str) -> FieldRef {
        FieldRef::ContextualQuery(id.to_string())
    }

    fn computed_column(name: &str) -> FieldRef {
        FieldRef::ComputedColumn(name.to_string())
    }

    fn computed_row(table_name: &str, name: &str, expression: Option<&str>) -> ComputedColumnRow {
        ComputedColumnRow {
            schema_name: "main".to_string(),
            table_name: table_name.to_string(),
            name: name.to_string(),
            expression: expression.map(str::to_string),
        }
    }

    fn field_row(
        table_name: &str,
        field: FieldRef,
        visible: bool,
        order: Option<f64>,
    ) -> FieldMetadataRow {
        FieldMetadataRow {
            schema_name: "main".to_string(),
            table_name: table_name.to_string(),
            field,
            visible,
            order,
            display: None,
            sorting: None,
        }
    }

    fn order_of(field: FieldRef, order: f64) -> FieldOrder {
        FieldOrder { field, order }
    }

    #[test]
    fn field_metadata_starts_empty() {
        let conn = setup();
        assert_eq!(list_field_metadata(&conn).unwrap(), vec![]);
    }

    #[test]
    fn hiding_a_field_leaves_its_order_and_ordering_leaves_its_visibility() {
        let mut conn = setup();
        set_field_visible(&conn, "main", "track", &column("genre"), false).unwrap();
        assert_eq!(
            list_field_metadata(&conn).unwrap(),
            vec![field_row("track", column("genre"), false, None)],
        );

        set_field_order(
            &mut conn,
            "main",
            "track",
            &[
                order_of(column("genre"), 1.0),
                order_of(column("title"), 2.0),
            ],
        )
        .unwrap();
        assert_eq!(
            list_field_metadata(&conn).unwrap(),
            vec![
                field_row("track", column("genre"), false, Some(1.0)),
                field_row("track", column("title"), true, Some(2.0)),
            ],
        );

        set_field_visible(&conn, "main", "track", &column("genre"), true).unwrap();
        set_field_order(
            &mut conn,
            "main",
            "track",
            &[order_of(column("title"), 0.5)],
        )
        .unwrap();
        assert_eq!(
            list_field_metadata(&conn).unwrap(),
            vec![
                field_row("track", column("genre"), true, Some(1.0)),
                field_row("track", column("title"), true, Some(0.5)),
            ],
        );
    }

    #[test]
    fn a_fields_querydown_leaves_the_rest_of_its_row_alone() {
        let conn = setup();
        let credits = multi_link("credit", "track");
        let set = |column, value: Option<&str>| {
            upsert_field_metadata(&conn, "main", "track", &credits, column, &value).unwrap();
        };
        set_field_visible(&conn, "main", "track", &credits, false).unwrap();

        set("display", Some("$artist.name $role"));
        set("sorting", Some("\\\\role"));
        assert_eq!(
            list_field_metadata(&conn).unwrap(),
            vec![FieldMetadataRow {
                display: Some("$artist.name $role".to_string()),
                sorting: Some("\\\\role".to_string()),
                ..field_row("track", credits.clone(), false, None)
            }],
        );

        // Restoring one goes back to null, and takes nothing else with it.
        set("display", None);
        assert_eq!(
            list_field_metadata(&conn).unwrap(),
            vec![FieldMetadataRow {
                sorting: Some("\\\\role".to_string()),
                ..field_row("track", credits.clone(), false, None)
            }],
        );
    }

    #[test]
    fn a_multi_link_field_round_trips_and_updates_in_place() {
        let mut conn = setup();
        let credits = multi_link("credit", "track");
        set_field_visible(&conn, "main", "track", &credits, false).unwrap();
        set_field_order(
            &mut conn,
            "main",
            "track",
            &[order_of(credits.clone(), 3.0)],
        )
        .unwrap();
        set_field_visible(&conn, "main", "track", &credits, true).unwrap();
        assert_eq!(
            list_field_metadata(&conn).unwrap(),
            vec![field_row("track", credits, true, Some(3.0))],
        );
    }

    #[test]
    fn a_contextual_query_field_round_trips_and_updates_in_place() {
        let mut conn = setup();
        let query = contextual_query(Q1);
        set_field_order(
            &mut conn,
            "main",
            "track",
            &[order_of(column("title"), 1.0), order_of(query.clone(), 2.0)],
        )
        .unwrap();
        set_field_visible(&conn, "main", "track", &query, false).unwrap();
        assert_eq!(
            list_field_metadata(&conn).unwrap(),
            vec![
                field_row("track", column("title"), true, Some(1.0)),
                field_row("track", query, false, Some(2.0)),
            ],
        );
    }

    #[test]
    fn resequencing_can_write_a_field_more_than_once() {
        let mut conn = setup();
        let orders = |first: f64, second: f64| {
            [
                order_of(multi_link("credit", "track"), first),
                order_of(column("title"), second),
            ]
        };
        set_field_order(&mut conn, "main", "track", &orders(1.0, 2.0)).unwrap();
        let [credits, title] = orders(3.0, 4.0);
        let repeated = [credits.clone(), title, credits];
        set_field_order(&mut conn, "main", "track", &repeated).unwrap();
        assert_eq!(
            list_field_metadata(&conn).unwrap(),
            vec![
                field_row("track", column("title"), true, Some(4.0)),
                field_row("track", multi_link("credit", "track"), true, Some(3.0)),
            ],
        );
    }

    #[test]
    fn fields_are_told_apart_by_table_kind_and_both_parts_of_a_link() {
        let conn = setup();
        for (table_name, field) in [
            ("album", column("title")),
            ("track", column("title")),
            ("track", column("credit")),
            ("track", multi_link("credit", "track")),
            ("track", multi_link("credit", "other_track")),
            ("track", contextual_query(Q1)),
            ("track", contextual_query(Q2)),
            // Named as a column above is.
            ("track", computed_column("title")),
            ("album", computed_column("title")),
            // Spells out how the first query above renders as text.
            ("track", column(Q1)),
            // Spells out how the first link above renders as text.
            (
                "track",
                column("{'related_table_name': credit, 'fk_column_name': track}"),
            ),
        ] {
            set_field_visible(&conn, "main", table_name, &field, false).unwrap();
        }
        assert_eq!(list_field_metadata(&conn).unwrap().len(), 11);
    }

    #[test]
    fn a_field_goes_over_the_wire_as_a_union_of_its_kinds() {
        let params: MetadataFieldSetOrderParams = from_params(serde_json::json!({
            "schemaName": "main",
            "tableName": "track",
            "orders": [
                { "field": { "columnName": "title" }, "order": 1.0 },
                {
                    "field": {
                        "multiLink": { "relatedTableName": "credit", "fkColumnName": "track" }
                    },
                    "order": 2.0
                },
                { "field": { "contextualQuery": Q1 }, "order": 3.0 },
                { "field": { "computedColumn": "last_play" }, "order": 4.0 },
            ],
        }))
        .unwrap();
        assert_eq!(params.orders[0].field, column("title"));
        assert_eq!(params.orders[1].field, multi_link("credit", "track"));
        assert_eq!(params.orders[2].field, contextual_query(Q1));
        assert_eq!(params.orders[3].field, computed_column("last_play"));

        assert_eq!(
            serde_json::to_value(field_row("a", multi_link("b", "c"), true, None)).unwrap(),
            serde_json::json!({
                "schemaName": "main",
                "tableName": "a",
                "field": { "multiLink": { "relatedTableName": "b", "fkColumnName": "c" } },
                "visible": true,
                "order": null,
                "display": null,
                "sorting": null,
            }),
        );
    }

    fn table_row(table_name: &str, visible: bool, order: Option<f64>) -> TableMetadataRow {
        TableMetadataRow {
            schema_name: "main".to_string(),
            table_name: table_name.to_string(),
            visible,
            order,
            default_text_search: None,
            linked_record_comparison: None,
            record_picker_sorting: None,
            record_picker_display: None,
        }
    }

    #[test]
    fn table_metadata_starts_empty() {
        let conn = setup();
        assert_eq!(list_table_metadata(&conn).unwrap(), vec![]);
    }

    #[test]
    fn a_tables_metadata_is_set_a_column_at_a_time() {
        let mut conn = setup();
        upsert_table_metadata(&conn, "main", "role", "visible", &false).unwrap();
        set_table_order(
            &mut conn,
            &[
                TableOrder {
                    schema_name: "main".to_string(),
                    table_name: "track".to_string(),
                    order: 1.0,
                },
                TableOrder {
                    schema_name: "main".to_string(),
                    table_name: "role".to_string(),
                    order: 2.0,
                },
            ],
        )
        .unwrap();
        assert_eq!(
            list_table_metadata(&conn).unwrap(),
            vec![
                table_row("role", false, Some(2.0)),
                table_row("track", true, Some(1.0)),
            ],
        );

        let set = |setting, text: Option<&str>| {
            upsert_table_metadata(
                &conn,
                "main",
                "track",
                table_querydown_column(setting),
                &text,
            )
            .unwrap();
        };
        set(TableQuerydownSetting::DefaultTextSearch, Some("title:@x"));
        set(
            TableQuerydownSetting::LinkedRecordComparison,
            Some("title:@x"),
        );
        set(
            TableQuerydownSetting::RecordPickerSorting,
            Some("\\\\title"),
        );
        set(TableQuerydownSetting::RecordPickerDisplay, Some("$title"));
        set(TableQuerydownSetting::LinkedRecordComparison, None);
        assert_eq!(
            list_table_metadata(&conn).unwrap(),
            vec![
                table_row("role", false, Some(2.0)),
                TableMetadataRow {
                    default_text_search: Some("title:@x".to_string()),
                    record_picker_sorting: Some("\\\\title".to_string()),
                    record_picker_display: Some("$title".to_string()),
                    ..table_row("track", true, Some(1.0))
                },
            ],
        );
    }

    /// Writes a field's `column` as the RPCs did before migration 0017, when a
    /// table went by its name alone: what the tests of earlier migrations set
    /// their rows up with.
    fn legacy_upsert_field(
        conn: &Connection,
        table_name: &str,
        field: &FieldRef,
        column: &str,
        value: &dyn duckdb::ToSql,
    ) {
        let (field_sql, field_params) = field_ref_sql(field);
        let sql = format!(
            "INSERT INTO metadata.field (table_name, field, {column}) VALUES (?, {field_sql}, ?) \
             ON CONFLICT DO UPDATE SET {column} = excluded.{column}"
        );
        let mut params: Vec<&dyn duckdb::ToSql> = vec![&table_name];
        params.extend(field_params.iter().map(|p| p as &dyn duckdb::ToSql));
        params.push(value);
        conn.execute(&sql, duckdb::params_from_iter(params))
            .unwrap();
    }

    /// Writes a computed column as the RPCs did before migration 0017.
    fn legacy_set_computed_column(conn: &Connection, row: &ComputedColumnRow) {
        conn.execute(
            "INSERT INTO metadata.computed_column (table_name, name, expression) \
             VALUES (?, ?, ?) \
             ON CONFLICT (table_name, name) DO UPDATE SET expression = excluded.expression",
            duckdb::params![row.table_name, row.name, row.expression],
        )
        .unwrap();
    }

    #[test]
    fn migration_0012_keeps_field_metadata() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_through(&mut conn, 11);
        legacy_upsert_field(&conn, "track", &column("title"), "visible", &false);
        legacy_upsert_field(
            &conn,
            "track",
            &multi_link("credit", "track"),
            "\"order\"",
            &2.0,
        );
        // Read as text: `list_field_metadata` asks for a kind of field this schema
        // doesn't have yet.
        let rows = |conn: &Connection| -> Vec<String> {
            conn.prepare(
                "SELECT concat_ws(' | ', table_name, field, visible, \"order\") \
                 FROM metadata.field ORDER BY 1",
            )
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
        };
        let before = rows(&conn);
        assert_eq!(before.len(), 2);

        crate::db::migrate_through(&mut conn, 12);

        assert_eq!(rows(&conn), before);
        // The rebuilt table still keeps one row per field. Counted rather than
        // listed: `list_field_metadata` asks for a kind of field a later
        // migration adds.
        legacy_upsert_field(&conn, "track", &column("title"), "visible", &true);
        legacy_upsert_field(
            &conn,
            "track",
            &multi_link("credit", "track"),
            "display",
            &Some("$role"),
        );
        assert_eq!(count(&conn, "SELECT count(*) FROM metadata.field"), 2);
        assert_eq!(count(&conn, "SELECT count(*) FROM contextual_query"), 0);
    }

    #[test]
    fn a_computed_column_is_set_by_table_and_name() {
        let conn = setup();
        assert_eq!(list_computed_columns(&conn).unwrap(), vec![]);
        set_computed_column(&conn, &computed_row("track", "decade", Some("year"))).unwrap();
        set_computed_column(&conn, &computed_row("album", "decade", Some("year / 10"))).unwrap();
        set_computed_column(&conn, &computed_row("track", "decade", Some("year / 10"))).unwrap();
        // One of the app's own, gone back to the app's expression.
        set_computed_column(&conn, &computed_row("track", "last_play", None)).unwrap();
        assert_eq!(
            list_computed_columns(&conn).unwrap(),
            vec![
                computed_row("album", "decade", Some("year / 10")),
                computed_row("track", "decade", Some("year / 10")),
                computed_row("track", "last_play", None),
            ],
        );
    }

    #[test]
    fn renaming_a_computed_column_renames_its_field_metadata() {
        let mut conn = setup();
        set_computed_column(&conn, &computed_row("track", "decade", Some("year / 10"))).unwrap();
        set_computed_column(&conn, &computed_row("album", "decade", Some("year / 10"))).unwrap();
        set_field_visible(&conn, "main", "track", &computed_column("decade"), false).unwrap();
        set_field_order(
            &mut conn,
            "main",
            "track",
            &[order_of(computed_column("decade"), 3.0)],
        )
        .unwrap();
        // Neither another table's column of the name, nor a real column of it,
        // is the one renamed.
        set_field_visible(&conn, "main", "album", &computed_column("decade"), false).unwrap();
        set_field_visible(&conn, "main", "track", &column("decade"), false).unwrap();

        rename_computed_column(&mut conn, "main", "track", "decade", "era").unwrap();

        assert_eq!(
            list_computed_columns(&conn).unwrap(),
            vec![
                computed_row("album", "decade", Some("year / 10")),
                computed_row("track", "era", Some("year / 10")),
            ],
        );
        assert_eq!(
            list_field_metadata(&conn).unwrap(),
            vec![
                field_row("album", computed_column("decade"), false, None),
                field_row("track", column("decade"), false, None),
                field_row("track", computed_column("era"), false, Some(3.0)),
            ],
        );
        // The renamed field still has the one row.
        set_field_visible(&conn, "main", "track", &computed_column("era"), true).unwrap();
        assert_eq!(list_field_metadata(&conn).unwrap().len(), 3);
    }

    fn comparison_row(
        table_name: &str,
        name: &str,
        expression: Option<&str>,
    ) -> CustomComparisonRow {
        CustomComparisonRow {
            schema_name: "main".into(),
            table_name: table_name.into(),
            name: name.into(),
            expression: expression.map(Into::into),
        }
    }

    #[test]
    fn a_custom_comparison_is_set_renamed_and_deleted_by_table_and_name() {
        let conn = setup();
        assert_eq!(list_custom_comparisons(&conn).unwrap(), vec![]);
        set_custom_comparison(&conn, &comparison_row("track", "tag", Some("a"))).unwrap();
        set_custom_comparison(&conn, &comparison_row("album", "tag", Some("b"))).unwrap();
        set_custom_comparison(&conn, &comparison_row("track", "tag", Some("c"))).unwrap();
        set_custom_comparison(&conn, &comparison_row("track", "artist", None)).unwrap();
        assert_eq!(
            list_custom_comparisons(&conn).unwrap(),
            vec![
                comparison_row("album", "tag", Some("b")),
                comparison_row("track", "artist", None),
                comparison_row("track", "tag", Some("c")),
            ],
        );

        // A name the table's other comparison has is refused, and changes nothing.
        assert!(rename_custom_comparison(&conn, "main", "track", "tag", "artist").is_err());
        rename_custom_comparison(&conn, "main", "track", "tag", "genre").unwrap();
        delete_custom_comparison(&conn, "main", "album", "tag").unwrap();
        assert_eq!(
            list_custom_comparisons(&conn).unwrap(),
            vec![
                comparison_row("track", "artist", None),
                comparison_row("track", "genre", Some("c")),
            ],
        );
    }

    #[test]
    fn a_computed_column_cant_take_the_name_of_another() {
        let mut conn = setup();
        set_computed_column(&conn, &computed_row("track", "decade", Some("a"))).unwrap();
        set_computed_column(&conn, &computed_row("track", "era", Some("b"))).unwrap();
        set_field_visible(&conn, "main", "track", &computed_column("decade"), false).unwrap();

        assert!(rename_computed_column(&mut conn, "main", "track", "decade", "era").is_err());

        assert_eq!(
            list_computed_columns(&conn).unwrap(),
            vec![
                computed_row("track", "decade", Some("a")),
                computed_row("track", "era", Some("b")),
            ],
        );
        assert_eq!(
            list_field_metadata(&conn).unwrap(),
            vec![field_row("track", computed_column("decade"), false, None)],
        );
    }

    #[test]
    fn deleting_a_computed_column_deletes_its_field_metadata() {
        let mut conn = setup();
        set_computed_column(&conn, &computed_row("track", "decade", Some("a"))).unwrap();
        set_computed_column(&conn, &computed_row("track", "era", Some("b"))).unwrap();
        set_field_visible(&conn, "main", "track", &computed_column("decade"), false).unwrap();
        set_field_visible(&conn, "main", "track", &computed_column("era"), false).unwrap();
        set_field_visible(&conn, "main", "track", &column("decade"), false).unwrap();

        delete_computed_column(&mut conn, "main", "track", "decade").unwrap();

        assert_eq!(
            list_computed_columns(&conn).unwrap(),
            vec![computed_row("track", "era", Some("b"))],
        );
        assert_eq!(
            list_field_metadata(&conn).unwrap(),
            vec![
                field_row("track", column("decade"), false, None),
                field_row("track", computed_column("era"), false, None),
            ],
        );
    }

    #[test]
    fn migration_0014_keeps_field_metadata() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_through(&mut conn, 13);
        legacy_upsert_field(&conn, "track", &column("title"), "visible", &false);
        legacy_upsert_field(
            &conn,
            "track",
            &multi_link("credit", "track"),
            "\"order\"",
            &2.0,
        );
        legacy_upsert_field(
            &conn,
            "artist",
            &contextual_query(Q1),
            "display",
            &Some("$title"),
        );
        // Read as text: `list_field_metadata` asks for a kind of field this schema
        // doesn't have yet.
        let rows = |conn: &Connection| -> Vec<String> {
            conn.prepare(
                "SELECT concat_ws(' | ', table_name, union_tag(field), field, visible, \
                 \"order\", display, sorting) FROM metadata.field ORDER BY 1",
            )
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
        };
        let before = rows(&conn);
        assert_eq!(before.len(), 3);

        crate::db::migrate_through(&mut conn, 14);

        assert_eq!(rows(&conn), before);
        // The rebuilt table still keeps one row per field.
        legacy_upsert_field(&conn, "track", &column("title"), "visible", &true);
        assert_eq!(count(&conn, "SELECT count(*) FROM metadata.field"), 3);
        assert_eq!(
            count(&conn, "SELECT count(*) FROM metadata.computed_column"),
            0
        );
    }

    /// The `querydown_prelude` setting migration 0014 leaves, having started from
    /// `prelude`.
    fn prelude_after_migration_0014(prelude: &str) -> Option<String> {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_through(&mut conn, 13);
        set_setting(&conn, "querydown_prelude", prelude).unwrap();
        set_setting(&conn, "other", "#track.year = album.year").unwrap();
        crate::db::migrate_through(&mut conn, 14);
        let settings = list_settings(&conn).unwrap();
        assert!(
            settings
                .iter()
                .any(|s| s.key == "other" && s.value == "#track.year = album.year"),
            "another setting was touched"
        );
        settings
            .into_iter()
            .find(|s| s.key == "querydown_prelude")
            .map(|s| s.value)
    }

    /// The prelude the app shipped as the setting's default, before migration 0014.
    const OLD_DEFAULT_PRELUDE: &str = "#track.firstplay = #play.timestamp%min\n\
        #track.lastplay = #play.timestamp%max\n\
        #track.artists = #credit.artist.name%list_all(\\\\order \\\\artist.name)\n\
        #track.year = album.year\n\
        #track.added = file.added\n\
        #track.duration = file.duration\n\
        #track.playcount = #play\n\
        #track.number = track_number\n\
        #track.artist:@x = ++#artist{name:@x}";

    #[test]
    fn migration_0014_takes_the_old_default_out_of_a_customized_prelude() {
        // Nothing but the old default, however its lines end: no customization.
        assert_eq!(prelude_after_migration_0014(OLD_DEFAULT_PRELUDE), None);
        assert_eq!(
            prelude_after_migration_0014(&format!(
                "{}\r\n",
                OLD_DEFAULT_PRELUDE.replace('\n', "\r\n")
            )),
            None,
        );
        // The user's own lines stay, and a line of the default they changed is
        // one of them.
        let customized = OLD_DEFAULT_PRELUDE
            .replace("#track.year = album.year", "#track.year = album.year + 1")
            + "\n@mine = 3";
        assert_eq!(
            prelude_after_migration_0014(&customized).as_deref(),
            Some("#track.year = album.year + 1\n@mine = 3"),
        );
        // A line that only starts like one of the default's is the user's too.
        assert_eq!(
            prelude_after_migration_0014("#track.playcount = #play{timestamp:<1y}").as_deref(),
            Some("#track.playcount = #play{timestamp:<1y}"),
        );
    }

    #[test]
    fn migration_0016_moves_the_app_columns_customizations_to_their_new_names() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_through(&mut conn, 15);
        for row in [
            computed_row("track", "lastplay", Some("#play.timestamp%min")),
            computed_row("track", "playcount", None),
            // The user already has a column by the new name: the old stays theirs.
            computed_row("track", "firstplay", Some("1")),
            computed_row("track", "first_play", Some("2")),
            // Not a track: not one of the app's.
            computed_row("album", "lastplay", Some("3")),
        ] {
            legacy_set_computed_column(&conn, &row);
        }
        legacy_upsert_field(
            &conn,
            "track",
            &computed_column("lastplay"),
            "visible",
            &false,
        );
        legacy_upsert_field(
            &conn,
            "track",
            &computed_column("firstplay"),
            "visible",
            &false,
        );
        legacy_upsert_field(
            &conn,
            "album",
            &computed_column("lastplay"),
            "visible",
            &false,
        );
        legacy_upsert_field(&conn, "track", &column("lastplay"), "visible", &false);

        // Read through the RPCs, which name the schema as migration 0019 does.
        crate::db::migrate_through(&mut conn, 19);

        assert_eq!(
            list_computed_columns(&conn).unwrap(),
            vec![
                computed_row("album", "lastplay", Some("3")),
                computed_row("track", "first_play", Some("2")),
                computed_row("track", "firstplay", Some("1")),
                computed_row("track", "last_play", Some("#play.timestamp%min")),
                computed_row("track", "play_count", None),
            ],
        );
        assert_eq!(
            list_field_metadata(&conn).unwrap(),
            vec![
                field_row("album", computed_column("lastplay"), false, None),
                field_row("track", column("lastplay"), false, None),
                field_row("track", computed_column("firstplay"), false, None),
                field_row("track", computed_column("last_play"), false, None),
            ],
        );
    }

    #[test]
    fn migration_0017_puts_every_tables_metadata_in_main() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_through(&mut conn, 16);
        legacy_upsert_field(&conn, "track", &column("title"), "visible", &false);
        legacy_upsert_field(
            &conn,
            "track",
            &multi_link("credit", "track"),
            "display",
            &Some("$role"),
        );
        legacy_set_computed_column(&conn, &computed_row("track", "decade", Some("year / 10")));
        conn.execute_batch(
            "INSERT INTO metadata.\"table\" (table_name, visible, \"order\", default_text_search) \
             VALUES ('role', false, 2.0, NULL), ('track', true, 1.0, 'title:@x');
             INSERT INTO metadata.custom_comparison (table_name, name, expression) \
             VALUES ('track', 'tag', '#tag{name:@x}');",
        )
        .unwrap();

        // Read through the RPCs, which name the schema as migration 0019 does.
        crate::db::migrate_through(&mut conn, 19);

        assert_eq!(
            list_field_metadata(&conn).unwrap(),
            vec![
                field_row("track", column("title"), false, None),
                FieldMetadataRow {
                    display: Some("$role".to_string()),
                    ..field_row("track", multi_link("credit", "track"), true, None)
                },
            ],
        );
        assert_eq!(
            list_computed_columns(&conn).unwrap(),
            vec![computed_row("track", "decade", Some("year / 10"))],
        );
        assert_eq!(
            list_table_metadata(&conn).unwrap(),
            vec![
                table_row("role", false, Some(2.0)),
                TableMetadataRow {
                    default_text_search: Some("title:@x".to_string()),
                    ..table_row("track", true, Some(1.0))
                },
            ],
        );
        assert_eq!(
            list_custom_comparisons(&conn).unwrap(),
            vec![comparison_row("track", "tag", Some("#tag{name:@x}"))],
        );
        // The rebuilt tables still keep one row per field and per table.
        set_field_visible(&conn, "main", "track", &column("title"), true).unwrap();
        upsert_table_metadata(&conn, "main", "role", "visible", &true).unwrap();
        assert_eq!(list_field_metadata(&conn).unwrap().len(), 2);
        assert_eq!(list_table_metadata(&conn).unwrap().len(), 2);
    }

    #[test]
    fn tables_of_one_name_in_two_schemas_are_customized_apart() {
        let mut conn = setup();
        set_field_visible(&conn, "main", "artist", &column("name"), false).unwrap();
        set_field_visible(&conn, "lastfm", "artist", &column("name"), true).unwrap();
        upsert_table_metadata(&conn, "lastfm", "artist", "visible", &false).unwrap();
        set_table_order(
            &mut conn,
            &[TableOrder {
                schema_name: "main".to_string(),
                table_name: "artist".to_string(),
                order: 1.0,
            }],
        )
        .unwrap();
        let lastfm = |row: ComputedColumnRow| ComputedColumnRow {
            schema_name: "lastfm".to_string(),
            ..row
        };
        set_computed_column(&conn, &computed_row("artist", "tracks", Some("#track"))).unwrap();
        set_computed_column(&conn, &lastfm(computed_row("artist", "tracks", Some("0")))).unwrap();
        set_field_visible(&conn, "lastfm", "artist", &computed_column("tracks"), false).unwrap();
        set_custom_comparison(
            &conn,
            &CustomComparisonRow {
                schema_name: "lastfm".to_string(),
                ..comparison_row("artist", "named", Some("mbid:@x"))
            },
        )
        .unwrap();

        // Each schema's rows are its own: renaming and deleting reach only them.
        rename_computed_column(&mut conn, "lastfm", "artist", "tracks", "plays").unwrap();
        delete_custom_comparison(&conn, "main", "artist", "named").unwrap();

        assert_eq!(
            list_field_metadata(&conn).unwrap(),
            vec![
                FieldMetadataRow {
                    schema_name: "lastfm".to_string(),
                    ..field_row("artist", column("name"), true, None)
                },
                FieldMetadataRow {
                    schema_name: "lastfm".to_string(),
                    ..field_row("artist", computed_column("plays"), false, None)
                },
                field_row("artist", column("name"), false, None),
            ],
        );
        assert_eq!(
            list_table_metadata(&conn).unwrap(),
            vec![
                TableMetadataRow {
                    schema_name: "lastfm".to_string(),
                    ..table_row("artist", false, None)
                },
                table_row("artist", true, Some(1.0)),
            ],
        );
        assert_eq!(
            list_computed_columns(&conn).unwrap(),
            vec![
                lastfm(computed_row("artist", "plays", Some("0"))),
                computed_row("artist", "tracks", Some("#track")),
            ],
        );
        assert_eq!(list_custom_comparisons(&conn).unwrap().len(), 1);
    }

    #[test]
    fn the_table_refuses_a_second_row_for_a_field() {
        let conn = setup();
        for field in [
            "union_value(column_name := 'title')",
            "union_value(multi_link := {'related_table_name': 'credit', 'fk_column_name': 'track'})",
            "union_value(contextual_query := '00000000-0000-0000-0000-0000000000e1'::uuid)",
            "union_value(computed_column := 'last_play')",
        ] {
            let insert = format!(
                "INSERT INTO metadata.field (schema_name, table_name, field) VALUES ('main', 'a', {field})"
            );
            conn.execute_batch(&insert).unwrap();
            assert!(conn.execute_batch(&insert).is_err());
        }
    }

    #[test]
    fn introspection_puts_the_other_schemas_tables_under_their_schema() {
        let conn = setup();
        conn.execute_batch("CREATE TEMP TABLE staging_track (id UUID);")
            .unwrap();
        let json: String = conn
            .query_row(introspection::introspection_sql(), [], |row| row.get(0))
            .unwrap();
        let schema = introspection::Schema::parse(&json).unwrap();
        // Querydown sees `metadata.field` as `#/metadata/field`, but the app, which names
        // tables alone, never mistakes it for one of its own.
        let field = schema.tables.iter().find(|t| t.name == "field").unwrap();
        assert_eq!(field.schema, ["metadata"]);
        assert!(schema.table("field").is_none());
        assert!(schema.table("track").unwrap().is_current());
        // A session's temp tables stay out altogether.
        assert!(schema.tables.iter().all(|t| t.name != "staging_track"));
    }

    #[test]
    fn introspection_links_only_the_declared_relationships() {
        let conn = setup();
        conn.execute_batch(
            "CREATE SCHEMA lastfm;
             CREATE TABLE lastfm.scrobble (id UUID PRIMARY KEY, track UUID, album UUID, credit UUID);
             INSERT INTO metadata.relationship VALUES
               ('lastfm', 'scrobble', 'track', 'main', 'track'),
               ('lastfm', 'scrobble', 'gone', 'main', 'track'),
               ('lastfm', 'scrobble', 'credit', 'main', 'credit'),
               ('lastfm', 'nowhere', 'track', 'main', 'track');",
        )
        .unwrap();
        let json: String = conn
            .query_row(introspection::introspection_sql(), [], |row| row.get(0))
            .unwrap();
        let schema = introspection::Schema::parse(&json).unwrap();
        let app = ["app".to_string()];
        let lastfm = ["lastfm".to_string()];

        // The app's own, from migration 0019, each to its target's primary key.
        let album = schema.link("track", "album").unwrap();
        assert_eq!(
            (album.to_table.as_str(), album.to_column.as_str()),
            ("album", "id")
        );
        let entry = schema.link_in(&app, "playlist_track", "track").unwrap();
        assert!(entry.to_schema.is_empty());
        let parent = schema.link_in(&app, "source_folder", "parent").unwrap();
        assert_eq!(
            (parent.to_schema.as_slice(), parent.to_table.as_str()),
            (&app[..], "source_folder")
        );

        // A declared relationship links whatever its column is named; a column named after a table
        // links nothing unless it's declared.
        assert!(schema.link_in(&lastfm, "scrobble", "track").is_some());
        assert!(schema.link_in(&lastfm, "scrobble", "album").is_none());
        // A relationship whose column or table isn't there, or whose target has no single-column
        // primary key, is left out.
        assert!(schema.link_in(&lastfm, "scrobble", "credit").is_none());
        assert_eq!(
            schema
                .links
                .iter()
                .filter(|l| l.from_schema == lastfm)
                .count(),
            1
        );
        assert_eq!(schema.links.len(), 16);
    }

    #[test]
    fn migration_0019_moves_contextual_queries_and_renames_the_schema_columns() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_through(&mut conn, 18);
        conn.execute_batch(&format!(
            "INSERT INTO app.contextual_query (id, table_name, name, query)
             VALUES ('{Q1}', 'track', 'Same album', NULL);
             INSERT INTO metadata.field (table_schema, table_name, field, visible)
             VALUES ('main', 'track', union_value(contextual_query := '{Q1}'::uuid), false);
             INSERT INTO metadata.\"table\" (table_schema, table_name, visible)
             VALUES ('main', 'tag', false);
             INSERT INTO metadata.computed_column VALUES ('main', 'track', 'decade', 'year / 10');
             INSERT INTO metadata.custom_comparison VALUES ('main', 'track', 'tag', '#tag{{name:@x}}');"
        ))
        .unwrap();

        crate::db::migrate_through(&mut conn, 19);

        assert_eq!(
            count(
                &conn,
                "SELECT count(*) FROM metadata.contextual_query WHERE name = 'Same album'"
            ),
            1
        );
        assert_eq!(
            count(
                &conn,
                "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'app' \
                 AND table_name = 'contextual_query'"
            ),
            0
        );
        assert_eq!(
            list_field_metadata(&conn).unwrap(),
            vec![field_row("track", contextual_query(Q1), false, None)],
        );
        assert_eq!(
            list_table_metadata(&conn).unwrap(),
            vec![table_row("tag", false, None)]
        );
        assert_eq!(
            list_computed_columns(&conn).unwrap(),
            vec![computed_row("track", "decade", Some("year / 10"))],
        );
        assert_eq!(list_custom_comparisons(&conn).unwrap().len(), 1);
        // The index, made anew around the renamed column, still keeps one row per field.
        assert!(set_field_visible(&conn, "main", "track", &contextual_query(Q1), true).is_ok());
        assert_eq!(count(&conn, "SELECT count(*) FROM metadata.field"), 1);
        assert_eq!(
            count(&conn, "SELECT count(*) FROM metadata.relationship"),
            15
        );
    }

    #[test]
    fn a_new_library_starts_with_the_apps_defaults() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_through(&mut conn, u32::MAX);

        // Migration 0003's vocabularies.
        let ratings: Vec<(f32, String)> = conn
            .prepare("SELECT value, description FROM rating ORDER BY value")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            ratings,
            [
                (-1.0, "Skip".to_string()),
                (0.0, "Like".to_string()),
                (1.0, "Prefer".to_string()),
                (2.0, "Love".to_string()),
            ]
        );
        let roles: Vec<String> = conn
            .prepare("SELECT name FROM role ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(roles, ["Composer", "Featured", "Remix"]);

        // Migration 0020's customizations, every row of which the RPCs read back.
        assert_eq!(list_table_metadata(&conn).unwrap().len(), 10);
        assert_eq!(list_field_metadata(&conn).unwrap().len(), 59);
        assert_eq!(list_presets(&conn).unwrap().len(), 29);
        assert_eq!(
            count(&conn, "SELECT count(*) FROM metadata.contextual_query"),
            3
        );
        // Each is about one of the app's own tables, in `main`.
        assert_eq!(
            count(
                &conn,
                "SELECT count(*) FROM (
                   SELECT table_name FROM metadata.\"table\"
                   UNION ALL SELECT table_name FROM metadata.field
                   UNION ALL SELECT table_name FROM metadata.contextual_query
                   UNION ALL SELECT base_table FROM app.preset
                 )
                 WHERE table_name NOT IN (
                   SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'
                 )"
            ),
            0
        );
        // Each contextual query's field is one the migration made a query for.
        assert_eq!(
            count(
                &conn,
                "SELECT count(*) FROM metadata.field
                 WHERE union_tag(field) = 'contextual_query'
                   AND union_extract(field, 'contextual_query')
                     NOT IN (SELECT id FROM metadata.contextual_query)"
            ),
            0
        );
        // The explorer's saved queries, in order, each on its table's default
        // presets and no others.
        let sources: Vec<(String, String)> = list_sources(&conn)
            .unwrap()
            .into_iter()
            .map(|s| (s.name, s.definition))
            .collect();
        let names: Vec<&str> = sources.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, ["Tracks", "Albums", "Artists"]);
        let presets = list_presets(&conn).unwrap();
        for (name, definition) in &sources {
            let def: serde_json::Value = serde_json::from_str(definition).unwrap();
            let base = def["base"].as_str().unwrap();
            let mut used: Vec<&str> = def["filter"]["presets"]
                .as_array()
                .unwrap()
                .iter()
                .chain([&def["sort"]["preset"], &def["display"]["preset"]])
                .filter_map(|id| id.as_str())
                .collect();
            let mut defaults: Vec<&str> = presets
                .iter()
                .filter(|p| p.is_default && p.base_table == base)
                .map(|p| p.id.as_str())
                .collect();
            used.sort_unstable();
            defaults.sort_unstable();
            assert_eq!(used, defaults, "{name}");
        }
    }

    #[test]
    fn summarize_reports_every_table_with_its_column_statistics() {
        let conn = setup();
        conn.execute_batch(
            "INSERT INTO album (id, title, year) VALUES \
             (uuid(), 'Blue', 1971), (uuid(), 'Blue', NULL), (uuid(), 'Hejira', NULL), \
             (uuid(), NULL, NULL);
             CREATE TEMP TABLE artist (only_in_temp integer);
             CREATE SCHEMA lastfm;
             CREATE TABLE lastfm.artist (mbid text);
             INSERT INTO lastfm.artist VALUES ('a'), ('b');",
        )
        .unwrap();
        let tables = summarize_tables(&conn).unwrap();

        // The same tables introspection lists, in every schema, each by its schema.
        let json: String = conn
            .query_row(introspection::introspection_sql(), [], |row| row.get(0))
            .unwrap();
        let schema = introspection::Schema::parse(&json).unwrap();
        let mut summarized: Vec<(String, String)> = tables
            .iter()
            .map(|t| (t.schema.clone(), t.name.clone()))
            .collect();
        let mut introspected: Vec<(String, String)> = schema
            .tables
            .iter()
            .map(|t| {
                let schema = t.schema.last().map_or("main", String::as_str);
                (schema.to_string(), t.name.clone())
            })
            .collect();
        summarized.sort();
        introspected.sort();
        assert_eq!(summarized, introspected);
        assert!(summarized.contains(&("metadata".to_string(), "field".to_string())));

        // A table of another schema is told apart from the app's of its name.
        let theirs = tables
            .iter()
            .find(|t| t.schema == "lastfm" && t.name == "artist")
            .unwrap();
        assert_eq!(theirs.row_count, 2);
        assert_eq!(theirs.columns.len(), 1);

        let album = tables.iter().find(|t| t.name == "album").unwrap();
        assert_eq!(album.row_count, 4);
        let column = |name: &str| album.columns.iter().find(|c| c.name == name).unwrap();
        assert_eq!(
            album.columns.iter().map(|c| &c.name).collect::<Vec<_>>(),
            ["id", "title", "year"]
        );
        assert_eq!(column("id").null_percentage, Some(0.0));
        assert_eq!(column("id").approx_unique, 4);
        assert_eq!(column("title").approx_unique, 2);
        assert_eq!(column("title").null_percentage, Some(25.0));
        assert_eq!(column("year").null_percentage, Some(75.0));

        // An empty table has no share of NULLs to report, and the temp table that
        // shares its name is passed over for the real one.
        let artist = tables
            .iter()
            .find(|t| t.schema == "main" && t.name == "artist")
            .unwrap();
        assert_eq!(artist.row_count, 0);
        assert_eq!(
            artist.columns.iter().map(|c| &c.name).collect::<Vec<_>>(),
            ["id", "name"]
        );
        assert_eq!(artist.columns[0].null_percentage, None);
    }

    #[test]
    fn arrange_moves_sources_and_folders() {
        let mut conn = setup();
        add_query(&mut conn, &query(S1, Q1, "a", 0)).unwrap();
        add_folder(
            &conn,
            &SourceFolder {
                id: F1.to_string(),
                name: "folder".to_string(),
                parent: None,
                position: 1,
            },
        )
        .unwrap();
        arrange(
            &mut conn,
            &[
                Placement {
                    kind: TreeItemKind::Source,
                    id: S1.to_string(),
                    parent: Some(F1.to_string()),
                    position: 0,
                },
                Placement {
                    kind: TreeItemKind::Folder,
                    id: F1.to_string(),
                    parent: None,
                    position: 0,
                },
            ],
        )
        .unwrap();
        let q = &list_sources(&conn).unwrap()[0];
        assert_eq!(q.parent.as_deref(), Some(F1));
        assert_eq!(q.position, 0);
        let f = &list_folders(&conn).unwrap()[0];
        assert_eq!((f.parent.as_deref(), f.position), (None, 0));
    }

    #[test]
    fn folders_rename_and_delete() {
        let conn = setup();
        add_folder(
            &conn,
            &SourceFolder {
                id: F1.to_string(),
                name: "old".to_string(),
                parent: None,
                position: 0,
            },
        )
        .unwrap();
        rename_folder(&conn, F1, "new").unwrap();
        assert_eq!(list_folders(&conn).unwrap()[0].name, "new");
        delete_folder(&conn, F1).unwrap();
        assert!(list_folders(&conn).unwrap().is_empty());
    }

    // -----------------------------------------------------------------------
    // Change topics (specs/2026-11-live-updates, §3.2)
    // -----------------------------------------------------------------------

    /// What a run of `dispatch` announced, as `(method, topics)`.
    fn drain(rx: &mut tokio::sync::broadcast::Receiver<api_schema::TopicChanged>) -> Vec<Topic> {
        let mut topics = Vec::new();
        while let Ok(changed) = rx.try_recv() {
            topics.push(changed.topic);
        }
        topics
    }

    /// An `AppState` over a fresh database, whose collection is an empty
    /// directory of its own so `collection.rescan` has nothing to find.
    fn test_state() -> Arc<AppState> {
        let dir = std::env::temp_dir().join(format!("radiocrate-rpc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        crate::server::app_state(setup(), dir, "test".into(), "test".into())
    }

    /// Every RPC method, run through `dispatch` in an order that has each one's
    /// prerequisites in place, announces exactly the topics the spec gives it,
    /// with the caller as their origin. The cases must cover `METHODS`, so a
    /// new method can't go untested.
    #[test]
    #[allow(clippy::too_many_lines)]
    fn dispatch_announces_exactly_its_topics() {
        use Topic::{
            ComputedColumns, CustomComparisons, FieldMetadata, Keybindings, Presets, Settings,
            Sources, TableSettings,
        };
        use serde_json::json;
        let field = json!({ "columnName": "title" });
        let cases: Vec<(&str, Value, Vec<Topic>)> = vec![
            ("app.version", Value::Null, vec![]),
            ("source.list", Value::Null, vec![]),
            ("folder.list", Value::Null, vec![]),
            ("preset.list", Value::Null, vec![]),
            ("keybinding.list", Value::Null, vec![]),
            ("setting.list", Value::Null, vec![]),
            ("metadata.field.list", Value::Null, vec![]),
            ("metadata.table.list", Value::Null, vec![]),
            ("metadata.computed_column.list", Value::Null, vec![]),
            ("metadata.custom_comparison.list", Value::Null, vec![]),
            ("table.summarize", Value::Null, vec![]),
            (
                "query.add",
                serde_json::to_value(query(S1, Q1, "One", 0)).unwrap(),
                vec![Sources],
            ),
            (
                "source.rename",
                json!({ "id": S1, "name": "Uno" }),
                vec![Sources],
            ),
            (
                "source.update_definition",
                json!({ "id": S1, "definition": "{\"a\":1}", "modifiedAt": 1_700_000_001 }),
                vec![Sources],
            ),
            (
                "source.record_play",
                json!({ "id": S1, "lastPlay": 1_700_000_002 }),
                vec![],
            ),
            (
                "folder.add",
                json!({ "id": F1, "name": "Folder", "parent": null, "position": 1 }),
                vec![Sources],
            ),
            (
                "folder.rename",
                json!({ "id": F1, "name": "Box" }),
                vec![Sources],
            ),
            (
                "source.arrange",
                json!({ "placements": [
                    { "kind": "source", "id": S1, "parent": F1, "position": 0 }
                ] }),
                vec![Sources],
            ),
            ("query.delete", json!({ "id": S1 }), vec![Sources]),
            ("folder.delete", json!({ "id": F1 }), vec![Sources]),
            (
                "preset.add",
                serde_json::to_value(preset(P1, "Sort", "track", "sort", false)).unwrap(),
                vec![Presets],
            ),
            (
                "preset.update",
                json!({
                    "id": P1, "name": "Sorted", "definition": "{}",
                    "filterStrategy": "querydown", "isDefault": true,
                    "modifiedAt": 1_700_000_001
                }),
                vec![Presets],
            ),
            ("preset.delete", json!({ "id": P1 }), vec![Presets]),
            (
                "metadata.field.set_visible",
                json!({ "schemaName": "main", "tableName": "track", "field": field, "visible": false }),
                vec![FieldMetadata],
            ),
            (
                "metadata.field.set_order",
                json!({ "schemaName": "main", "tableName": "track", "orders": [{ "field": field, "order": 1.0 }] }),
                vec![FieldMetadata],
            ),
            (
                "metadata.field.set_display",
                json!({ "schemaName": "main", "tableName": "track", "field": field, "display": "x" }),
                vec![FieldMetadata],
            ),
            (
                "metadata.field.set_sorting",
                json!({ "schemaName": "main", "tableName": "track", "field": field, "sorting": "x" }),
                vec![FieldMetadata],
            ),
            (
                "metadata.table.set_visible",
                json!({ "schemaName": "main", "tableName": "track", "visible": false }),
                vec![TableSettings],
            ),
            (
                "metadata.table.set_order",
                json!({ "orders": [{ "schemaName": "main", "tableName": "track", "order": 1.0 }] }),
                vec![TableSettings],
            ),
            (
                "metadata.table.set_querydown",
                json!({ "schemaName": "main", "tableName": "track", "setting": "defaultTextSearch", "text": "x" }),
                vec![TableSettings],
            ),
            (
                "metadata.computed_column.set",
                json!({ "schemaName": "main", "tableName": "track", "name": "c", "expression": "1" }),
                vec![ComputedColumns],
            ),
            (
                "metadata.computed_column.rename",
                json!({ "schemaName": "main", "tableName": "track", "name": "c", "newName": "d" }),
                vec![ComputedColumns, FieldMetadata],
            ),
            (
                "metadata.computed_column.delete",
                json!({ "schemaName": "main", "tableName": "track", "name": "d" }),
                vec![ComputedColumns, FieldMetadata],
            ),
            (
                "metadata.custom_comparison.set",
                json!({ "schemaName": "main", "tableName": "track", "name": "c", "expression": "1" }),
                vec![CustomComparisons],
            ),
            (
                "metadata.custom_comparison.rename",
                json!({ "schemaName": "main", "tableName": "track", "name": "c", "newName": "d" }),
                vec![CustomComparisons],
            ),
            (
                "metadata.custom_comparison.delete",
                json!({ "schemaName": "main", "tableName": "track", "name": "d" }),
                vec![CustomComparisons],
            ),
            (
                "keybinding.set",
                json!({ "commandId": "tabs.save_active", "chord": "Ctrl+S" }),
                vec![Keybindings],
            ),
            (
                "keybinding.delete",
                json!({ "commandId": "tabs.save_active" }),
                vec![Keybindings],
            ),
            (
                "setting.set",
                json!({ "key": "prelude", "value": "x" }),
                vec![Settings],
            ),
            (
                "setting.delete",
                json!({ "key": "prelude" }),
                vec![Settings],
            ),
            ("collection.rescan", Value::Null, vec![]),
            (
                "dml",
                json!({ "operations": [{
                    "operation": "insert", "id": "r", "table": "rating",
                    "values": { "value": 9.0, "symbol": "!", "description": "Wow" }
                }] }),
                vec![Topic::Ratings],
            ),
        ];

        let covered: BTreeSet<&str> = cases.iter().map(|(method, _, _)| *method).collect();
        let methods: BTreeSet<&str> = api_schema::METHODS.iter().map(|m| m.wire).collect();
        assert_eq!(covered, methods, "every method needs a case");

        let state = test_state();
        let (_, mut rx) = state.changes.subscribe();
        for (method, params, expected) in cases {
            let result = dispatch(&state, Some("device-a"), method, params);
            assert!(result.is_ok(), "{method} failed: {:?}", result.err());
            let mut announced = Vec::new();
            while let Ok(changed) = rx.try_recv() {
                assert_eq!(changed.origin.as_deref(), Some("device-a"), "{method}");
                announced.push(changed.topic);
            }
            let mut expected = expected;
            announced.sort();
            expected.sort();
            assert_eq!(announced, expected, "{method}");
        }
    }

    #[test]
    fn a_failed_write_announces_nothing() {
        let state = test_state();
        let (_, mut rx) = state.changes.subscribe();
        let result = dispatch(
            &state,
            None,
            "query.add",
            serde_json::json!({ "not": "a source" }),
        );
        assert!(result.is_err());
        let result = dispatch(
            &state,
            None,
            "dml",
            serde_json::json!({ "operations": [{
                "operation": "update", "id": "x", "table": "rating",
                "where": { "id": P1 }, "values": { "symbol": "?" }
            }] }),
        );
        assert!(result.is_err());
        assert_eq!(drain(&mut rx), vec![]);
    }

    /// DML announces a topic for each of the app's tables its operations
    /// touch, and none for a write that only query results show.
    #[test]
    fn dml_announces_the_topics_of_the_tables_it_touches() {
        use serde_json::json;
        let state = test_state();
        let (_, mut rx) = state.changes.subscribe();
        let playlist = json!({ "operations": [
            { "operation": "insert", "id": "p", "schema": "app", "table": "playlist", "values": { "definition": "{}" } },
            { "operation": "insert", "id": "s", "schema": "app", "table": "source", "values": {
                "name": "Mix", "created_at": "2024-01-01 00:00:00",
                "modified_at": "2024-01-01 00:00:00", "last_play": "2024-01-01 00:00:00",
                "playlist": { "id": "p" }
            } },
            { "operation": "insert", "id": "c", "schema": "metadata", "table": "contextual_query", "values": {
                "table_name": "track", "name": "Same album"
            } },
        ] });
        dispatch(&state, None, "dml", playlist).unwrap();
        assert_eq!(
            drain(&mut rx),
            vec![Topic::Sources, Topic::ContextualQueries]
        );

        let tag = json!({ "operations": [
            { "operation": "insert", "id": "t", "table": "tag", "values": { "name": "loud" } },
        ] });
        dispatch(&state, None, "dml", tag).unwrap();
        assert_eq!(drain(&mut rx), vec![]);
    }
}
