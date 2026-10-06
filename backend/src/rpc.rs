//! Minimal JSON-RPC 2.0 endpoint for managing saved sources (queries and
//! playlists) and settings.
//!
//! The surface is tiny (a handful of methods over a single HTTP route), so the
//! envelope is hand-rolled with serde rather than pulling in a full RPC crate.
//! Each method runs on a blocking thread and talks to `DuckDB` through the
//! shared `Mutex<Connection>`, mirroring the other handlers in [`crate::server`].

use std::sync::Arc;

use api_schema::{
    AppVersion, FolderDeleteParams, FolderRenameParams, Keybinding, KeybindingDeleteParams,
    Placement, Preset, PresetDeleteParams, PresetUpdateParams, QueryDeleteParams, Setting,
    SettingDeleteParams, Source, SourceArrangeParams, SourceFolder, SourceKind,
    SourceRecordPlayParams, SourceRenameParams, SourceUpdateDefinitionParams, TreeItemKind,
};
use axum::Json;
use axum::extract::State;
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
    Json(req): Json<RpcRequest>,
) -> Json<RpcResponse> {
    let id = req.id.clone();
    // Kept for the logging below; `req` itself moves into the blocking task.
    let method = req.method.clone();
    let outcome =
        tokio::task::spawn_blocking(move || dispatch(&state, &req.method, req.params)).await;

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
fn dispatch(state: &AppState, method: &str, params: Value) -> Result<Value, RpcErr> {
    match method {
        "dml" => crate::dml::handle(state, params),
        _ => dispatch_legacy(state, method, params).map_err(RpcErr::from),
    }
}

// A flat match over the CRUD RPC methods; splitting it up would just scatter the
// per-method param structs and handlers.
#[allow(clippy::too_many_lines)]
fn dispatch_legacy(state: &AppState, method: &str, params: Value) -> Result<Value, String> {
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
            state.write(|conn| {
                record_play(conn, &p.id, p.last_play)?;
                Ok(Value::Null)
            })
        }
        "source.rename" => {
            let p: SourceRenameParams = from_params(params)?;
            state.write(|conn| {
                rename_source(conn, &p.id, &p.name)?;
                Ok(Value::Null)
            })
        }
        "source.update_definition" => {
            let p: SourceUpdateDefinitionParams = from_params(params)?;
            state.write_mut(|conn| {
                update_definition(conn, &p.id, &p.definition, p.modified_at).map(|()| Value::Null)
            })
        }
        "source.arrange" => {
            let p: SourceArrangeParams = from_params(params)?;
            state.write_mut(|conn| arrange(conn, &p.placements).map(|()| Value::Null))
        }
        // Playlists have no counterpart to these two: they are created and
        // deleted through `dml`, since their writes also span `playlist_track`.
        "query.add" => {
            let source: Source = from_params(params)?;
            state.write_mut(|conn| add_query(conn, &source).map(|()| Value::Null))
        }
        "query.delete" => {
            let p: QueryDeleteParams = from_params(params)?;
            state.write_mut(|conn| delete_query(conn, &p.id).map(|()| Value::Null))
        }
        "folder.list" => state.read(|conn| -> Result<Value, String> {
            let folders = list_folders(conn)?;
            serde_json::to_value(folders).map_err(|e| e.to_string())
        }),
        "folder.add" => {
            let folder: SourceFolder = from_params(params)?;
            state.write(|conn| {
                add_folder(conn, &folder)?;
                Ok(Value::Null)
            })
        }
        "folder.rename" => {
            let p: FolderRenameParams = from_params(params)?;
            state.write(|conn| {
                rename_folder(conn, &p.id, &p.name)?;
                Ok(Value::Null)
            })
        }
        "folder.delete" => {
            let p: FolderDeleteParams = from_params(params)?;
            state.write(|conn| {
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
            state.write(|conn| {
                add_preset(conn, &preset)?;
                Ok(Value::Null)
            })
        }
        "preset.update" => {
            let p: PresetUpdateParams = from_params(params)?;
            state.write(|conn| {
                update_preset(
                    conn,
                    &p.id,
                    &p.name,
                    &p.definition,
                    p.is_default,
                    p.modified_at,
                )?;
                Ok(Value::Null)
            })
        }
        "preset.delete" => {
            let p: PresetDeleteParams = from_params(params)?;
            state.write(|conn| {
                delete_preset(conn, &p.id)?;
                Ok(Value::Null)
            })
        }
        "keybinding.list" => state.read(|conn| -> Result<Value, String> {
            let bindings = list_keybindings(conn)?;
            serde_json::to_value(bindings).map_err(|e| e.to_string())
        }),
        "keybinding.set" => {
            let binding: Keybinding = from_params(params)?;
            state.write(|conn| {
                set_keybinding(conn, &binding.command_id, binding.chord.as_deref())?;
                Ok(Value::Null)
            })
        }
        "keybinding.delete" => {
            let p: KeybindingDeleteParams = from_params(params)?;
            state.write(|conn| {
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
            state.write(|conn| {
                set_setting(conn, &setting.key, &setting.value)?;
                Ok(Value::Null)
            })
        }
        "setting.delete" => {
            let p: SettingDeleteParams = from_params(params)?;
            state.write(|conn| {
                delete_setting(conn, &p.key)?;
                Ok(Value::Null)
            })
        }
        // Re-scans the collection the server was started against — the same
        // pass `radiocrate-server scan` runs, and the one `serve` runs at boot
        // unless `--no-scan` is given. It takes no params: which directory to
        // scan is the server's to know, not the client's.
        //
        // The scan runs under the connection lock (like every other write), so
        // a large collection blocks the other API methods for as long as it
        // takes. Acceptable while this is a deliberate, one-at-a-time action a
        // person takes from the Settings menu and waits on.
        "collection.rescan" => state.write(|conn| {
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
             FROM source s \
             LEFT JOIN query q ON q.id = s.query \
             LEFT JOIN playlist p ON p.id = s.playlist \
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
        "INSERT INTO query (id, definition) VALUES (TRY_CAST(? AS UUID), ?)",
        duckdb::params![query_id, source.definition],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO source (id, name, created_at, modified_at, last_play, source_folder, position, query) \
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
            "SELECT query::text FROM source WHERE id = TRY_CAST(? AS UUID)",
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
        "DELETE FROM source WHERE id = TRY_CAST(? AS UUID)",
        duckdb::params![id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM query WHERE id = TRY_CAST(? AS UUID)",
        duckdb::params![query_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

fn record_play(conn: &Connection, id: &str, last_play: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE source SET last_play = make_timestamp(? * 1000000)::timestamp_s WHERE id = TRY_CAST(? AS UUID)",
        duckdb::params![last_play, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn rename_source(conn: &Connection, id: &str, name: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE source SET name = ? WHERE id = TRY_CAST(? AS UUID)",
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
                "UPDATE source SET source_folder = TRY_CAST(? AS UUID), position = ? \
                 WHERE id = TRY_CAST(? AS UUID)"
            }
            TreeItemKind::Folder => {
                "UPDATE source_folder SET parent = TRY_CAST(? AS UUID), position = ? \
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
             FROM source_folder ORDER BY position, name",
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
        "INSERT INTO source_folder (id, name, parent, position) \
         VALUES (TRY_CAST(? AS UUID), ?, TRY_CAST(? AS UUID), ?)",
        duckdb::params![folder.id, folder.name, folder.parent, folder.position],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn rename_folder(conn: &Connection, id: &str, name: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE source_folder SET name = ? WHERE id = TRY_CAST(? AS UUID)",
        duckdb::params![name, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn delete_folder(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM source_folder WHERE id = TRY_CAST(? AS UUID)",
        duckdb::params![id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn list_presets(conn: &Connection) -> Result<Vec<Preset>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id::text, name, base_table, section, definition, is_default, \
             epoch(created_at)::bigint, epoch(modified_at)::bigint \
             FROM preset ORDER BY name",
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
                is_default: row.get(5)?,
                created_at: row.get(6)?,
                modified_at: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

fn add_preset(conn: &Connection, preset: &Preset) -> Result<(), String> {
    conn.execute(
        "INSERT INTO preset (id, name, base_table, section, definition, is_default, created_at, modified_at) \
         VALUES (TRY_CAST(? AS UUID), ?, ?, ?, ?, ?, make_timestamp(? * 1000000)::timestamp_s, \
         make_timestamp(? * 1000000)::timestamp_s)",
        duckdb::params![
            preset.id,
            preset.name,
            preset.base_table,
            preset.section,
            preset.definition,
            preset.is_default,
            preset.created_at,
            preset.modified_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn update_preset(
    conn: &Connection,
    id: &str,
    name: &str,
    definition: &str,
    is_default: bool,
    modified_at: i64,
) -> Result<(), String> {
    conn.execute(
        "UPDATE preset SET name = ?, definition = ?, is_default = ?, \
         modified_at = make_timestamp(? * 1000000)::timestamp_s \
         WHERE id = TRY_CAST(? AS UUID)",
        duckdb::params![name, definition, is_default, modified_at, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn delete_preset(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM preset WHERE id = TRY_CAST(? AS UUID)",
        duckdb::params![id],
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
                "UPDATE {table} SET definition = ? \
                 WHERE id = (SELECT {table} FROM source WHERE id = TRY_CAST(? AS UUID))"
            ),
            duckdb::params![definition, id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.execute(
        "UPDATE source SET modified_at = make_timestamp(? * 1000000)::timestamp_s \
         WHERE id = TRY_CAST(? AS UUID)",
        duckdb::params![modified_at, id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const S1: &str = "00000000-0000-0000-0000-000000000001";
    const S2: &str = "00000000-0000-0000-0000-000000000002";
    const Q1: &str = "00000000-0000-0000-0000-0000000000e1";
    const Q2: &str = "00000000-0000-0000-0000-0000000000e2";
    const P1: &str = "00000000-0000-0000-0000-0000000000a1";
    const F1: &str = "00000000-0000-0000-0000-0000000000f1";

    /// A fresh in-memory database with the real migration schema applied.
    fn setup() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_through(&mut conn, u32::MAX);
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

        crate::db::migrate_through(&mut conn, 6);

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

    #[test]
    fn a_source_wraps_exactly_one_query_or_playlist() {
        let conn = setup();
        let insert = |id: &str, query: &str, playlist: &str| {
            conn.execute_batch(&format!(
                "INSERT INTO source (id, name, created_at, modified_at, last_play, query, playlist) \
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
            "INSERT INTO playlist (id, definition) VALUES ('{P1}', 'pdef');
             INSERT INTO source (id, name, created_at, modified_at, last_play, position, playlist)
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
            "INSERT INTO playlist (id, definition) VALUES ('{P1}', 'old');
             INSERT INTO source (id, name, created_at, modified_at, last_play, playlist)
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
        assert_eq!(count(&conn, "SELECT count(*) FROM query"), 1);
        delete_query(&mut conn, S1).unwrap();
        assert_eq!(count(&conn, "SELECT count(*) FROM source"), 0);
        assert_eq!(count(&conn, "SELECT count(*) FROM query"), 0);
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
        assert_eq!(count(&conn, "SELECT count(*) FROM query"), 0);
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
}
