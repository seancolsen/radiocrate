//! The shared wire contract between `RadioCrate`'s backend and its generated
//! TypeScript client.
//!
//! Every request/response type that crosses the `POST /api/rpc` boundary is
//! defined here exactly once, so the backend (which `use`s these structs in
//! [`crate`]-consuming code like `backend::rpc`) and the client generator
//! (`cargo xtask gen-api`, which reads [`type_decls`] and [`METHODS`]) can never
//! drift apart.
//!
//! # The two casings
//!
//! The Rust code stays `snake_case` (the server's idiom, and what the DB columns
//! and SQL use); the *wire* is `camelCase`. Each struct carries
//! `#[serde(rename_all = "camelCase")]`, so serde renames the fields only at
//! (de)serialization — the transformation lives on the server, at the boundary.
//! `ts-rs` reads that same serde attribute (its default `serde-compat` feature),
//! so the generated `.ts` types match the wire exactly and the client needs no
//! conversion of its own.
//!
//! Because serde's `rename_all` renames only *declared* struct fields, the DML
//! method's free-form maps — keyed by *database column names* (see
//! `backend::dml`) — pass through verbatim with no special handling. DML's TS
//! types aren't modeled here; the generator emits them as a static block.

use serde::{Deserialize, Serialize};
use ts_rs::{Config, TS};

/// Which kind of row a [`Source`] wraps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SourceKind {
    Query,
    Playlist,
}

/// A saved source — a query or a playlist — as exchanged over the wire. See
/// migration 0006.
///
/// `id` is the `source` row's own id, which is how the frontend names a source
/// everywhere (tabs, the explorer, ordering, `last_play`). The wrapped row is
/// reached through `query_id` or `playlist_id`, exactly one of which is set
/// (matching `kind`); no code may assume either equals `id`. `definition` is
/// that wrapped row's.
///
/// Timestamps are i64 epoch seconds and are authored by the frontend, as is its
/// place in the explorer tree: `parent` is the containing [`SourceFolder`]'s id
/// (`None` at the top level, stored as `source.source_folder`) and `position`
/// orders it among its siblings — folders and sources alike.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub kind: SourceKind,
    pub name: String,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub modified_at: i64,
    #[ts(type = "number")]
    pub last_play: i64,
    pub definition: String,
    pub parent: Option<String>,
    pub position: i32,
    pub query_id: Option<String>,
    pub playlist_id: Option<String>,
}

/// A folder in the explorer's tree of sources. It holds sources and other
/// folders, and sits in its own `parent` at `position`, exactly as a [`Source`]
/// does. See migrations 0005 and 0006.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SourceFolder {
    pub id: String,
    pub name: String,
    pub parent: Option<String>,
    pub position: i32,
}

/// Which table a [`Placement`] moves a row of.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TreeItemKind {
    Source,
    Folder,
}

/// One explorer-tree item's new place: its parent folder (`None` at the top
/// level) and its position among that folder's children.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    pub kind: TreeItemKind,
    pub id: String,
    pub parent: Option<String>,
    pub position: i32,
}

/// Params for `source.arrange`: every item whose place in the tree changed. They
/// are written together, in one transaction, so the tree is never seen half
/// rearranged.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SourceArrangeParams {
    pub placements: Vec<Placement>,
}

/// Params for `folder.rename`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FolderRenameParams {
    pub id: String,
    pub name: String,
}

/// Params for `folder.delete`. Only the folder row goes: its contents are the
/// caller's to move out first (with `source.arrange`), or they are left naming a
/// parent that no longer exists — which reads as the top level.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FolderDeleteParams {
    pub id: String,
}

/// A saved query-section preset as exchanged over the wire. The `section` is one
/// of `filter`/`sort`/`display` and the `definition` is a raw Querydown fragment;
/// both are opaque to the backend.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub base_table: String,
    pub section: String,
    pub definition: String,
    pub is_default: bool,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub modified_at: i64,
}

/// A user override for a command's keyboard shortcut. `chord` is `None` when the
/// command is explicitly unbound. See `settings.keybinding` in migration 0002.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Keybinding {
    pub command_id: String,
    pub chord: Option<String>,
}

/// One user-customized setting: an opaque string `value` stored under a string
/// `key`. See `settings.settings` in migration 0004.
///
/// The backend never interprets either field. Which keys exist, what a value
/// means, and what the default is when no row exists all live in the frontend
/// (`frontend/src/state/settings.ts`), so a row is present only for a setting
/// the user has changed and deleting it restores the default.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Setting {
    pub key: String,
    pub value: String,
}

/// The `build_id` a server reports when it embeds no frontend of its own — the
/// standalone dev server, which serves its client from Vite instead. A client
/// seeing this must skip the staleness comparison entirely rather than conclude
/// it is out of date, since there is no embedded build to be out of date
/// against. See [`AppVersion`].
pub const DEV_BUILD_ID: &str = "dev";

/// What the running server is, as reported by `app.version`.
///
/// `build_id` identifies the frontend build embedded in this binary (read from
/// `build-id.txt` in the embedded assets — see `frontend/vite.config.ts`), and
/// is the field that matters: a client compares it against the id compiled into
/// its own bundle, and the two differ exactly when the client running is not the
/// one this binary serves. The exception is [`DEV_BUILD_ID`], which means "don't
/// compare". `server_version` is the binary's own version string, for display
/// only — never for staleness decisions, since a rebuild at the same commit
/// leaves it unchanged.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AppVersion {
    pub build_id: String,
    pub server_version: String,
}

/// Params for `query.delete`. The `id` is the query's *source* id: the source
/// row goes, then the query it wraps.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct QueryDeleteParams {
    pub id: String,
}

/// Params for `source.record_play`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SourceRecordPlayParams {
    pub id: String,
    #[ts(type = "number")]
    pub last_play: i64,
}

/// Params for `source.rename`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SourceRenameParams {
    pub id: String,
    pub name: String,
}

/// Params for `source.update_definition`: the `definition` lands on whichever
/// row (query or playlist) the source wraps, and `modified_at` on the source.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SourceUpdateDefinitionParams {
    pub id: String,
    pub definition: String,
    #[ts(type = "number")]
    pub modified_at: i64,
}

/// Params for `preset.update`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PresetUpdateParams {
    pub id: String,
    pub name: String,
    pub definition: String,
    pub is_default: bool,
    #[ts(type = "number")]
    pub modified_at: i64,
}

/// Params for `preset.delete`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PresetDeleteParams {
    pub id: String,
}

/// Params for `keybinding.delete`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct KeybindingDeleteParams {
    pub command_id: String,
}

/// Params for `setting.delete`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SettingDeleteParams {
    pub key: String,
}

/// One method in the RPC surface, as consumed by the client generator.
///
/// The registry ([`METHODS`]) is the one hand-maintained list here; it names each
/// method, the generated client function, and the TS types on either side. The
/// TS type *definitions* still come from the `ts-rs` derives above (or, for DML,
/// the generator's static block), so this only wires names together.
pub struct Method {
    /// The JSON-RPC method name, e.g. `"source.list"`.
    pub wire: &'static str,
    /// The generated client function name, e.g. `"sourceList"`.
    pub func: &'static str,
    /// The TS type of the single params argument, or `None` for a no-arg method.
    pub params: Option<&'static str>,
    /// The TS type the method resolves to, e.g. `"Source[]"` or `"null"`.
    pub result: &'static str,
}

/// Every `POST /api/rpc` method, in a stable order. Mirrors the dispatch in
/// `backend::rpc` and `backend::dml`.
pub const METHODS: &[Method] = &[
    Method {
        wire: "source.list",
        func: "sourceList",
        params: None,
        result: "Source[]",
    },
    Method {
        wire: "source.record_play",
        func: "sourceRecordPlay",
        params: Some("SourceRecordPlayParams"),
        result: "null",
    },
    Method {
        wire: "source.rename",
        func: "sourceRename",
        params: Some("SourceRenameParams"),
        result: "null",
    },
    Method {
        wire: "source.update_definition",
        func: "sourceUpdateDefinition",
        params: Some("SourceUpdateDefinitionParams"),
        result: "null",
    },
    Method {
        wire: "source.arrange",
        func: "sourceArrange",
        params: Some("SourceArrangeParams"),
        result: "null",
    },
    Method {
        wire: "query.add",
        func: "queryAdd",
        params: Some("Source"),
        result: "null",
    },
    Method {
        wire: "query.delete",
        func: "queryDelete",
        params: Some("QueryDeleteParams"),
        result: "null",
    },
    Method {
        wire: "folder.list",
        func: "folderList",
        params: None,
        result: "SourceFolder[]",
    },
    Method {
        wire: "folder.add",
        func: "folderAdd",
        params: Some("SourceFolder"),
        result: "null",
    },
    Method {
        wire: "folder.rename",
        func: "folderRename",
        params: Some("FolderRenameParams"),
        result: "null",
    },
    Method {
        wire: "folder.delete",
        func: "folderDelete",
        params: Some("FolderDeleteParams"),
        result: "null",
    },
    Method {
        wire: "preset.list",
        func: "presetList",
        params: None,
        result: "Preset[]",
    },
    Method {
        wire: "preset.add",
        func: "presetAdd",
        params: Some("Preset"),
        result: "null",
    },
    Method {
        wire: "preset.update",
        func: "presetUpdate",
        params: Some("PresetUpdateParams"),
        result: "null",
    },
    Method {
        wire: "preset.delete",
        func: "presetDelete",
        params: Some("PresetDeleteParams"),
        result: "null",
    },
    Method {
        wire: "keybinding.list",
        func: "keybindingList",
        params: None,
        result: "Keybinding[]",
    },
    Method {
        wire: "keybinding.set",
        func: "keybindingSet",
        params: Some("Keybinding"),
        result: "null",
    },
    Method {
        wire: "keybinding.delete",
        func: "keybindingDelete",
        params: Some("KeybindingDeleteParams"),
        result: "null",
    },
    Method {
        wire: "setting.list",
        func: "settingList",
        params: None,
        result: "Setting[]",
    },
    Method {
        wire: "setting.set",
        func: "settingSet",
        params: Some("Setting"),
        result: "null",
    },
    Method {
        wire: "setting.delete",
        func: "settingDelete",
        params: Some("SettingDeleteParams"),
        result: "null",
    },
    Method {
        wire: "collection.rescan",
        func: "collectionRescan",
        params: None,
        result: "null",
    },
    Method {
        wire: "dml",
        func: "dml",
        params: Some("DmlRequest"),
        result: "DmlResult",
    },
    Method {
        wire: "app.version",
        func: "appVersion",
        params: None,
        result: "AppVersion",
    },
];

/// The `export type … = …;` declaration for every `ts-rs`-modeled wire type, in
/// the order the generated `types.ts` should list them. The DML types are *not*
/// here — the generator prepends them as a static block (see the module docs).
#[must_use]
pub fn type_decls() -> Vec<String> {
    // `TS::decl()` yields `type Name = { … };` with camelCased fields; we only add
    // the `export` keyword. Cross-type references (e.g. inside arrays) resolve by
    // name within the single generated file. The default `Config` is all we need —
    // per-field `#[ts(type = "number")]` overrides already pin the i64 timestamps,
    // so its `large_int` setting never applies to our types.
    let cfg = Config::default();
    vec![
        format!("export {}", SourceKind::decl(&cfg)),
        format!("export {}", Source::decl(&cfg)),
        format!("export {}", SourceFolder::decl(&cfg)),
        format!("export {}", TreeItemKind::decl(&cfg)),
        format!("export {}", Placement::decl(&cfg)),
        format!("export {}", Preset::decl(&cfg)),
        format!("export {}", Keybinding::decl(&cfg)),
        format!("export {}", Setting::decl(&cfg)),
        format!("export {}", AppVersion::decl(&cfg)),
        format!("export {}", QueryDeleteParams::decl(&cfg)),
        format!("export {}", SourceRecordPlayParams::decl(&cfg)),
        format!("export {}", SourceRenameParams::decl(&cfg)),
        format!("export {}", SourceUpdateDefinitionParams::decl(&cfg)),
        format!("export {}", SourceArrangeParams::decl(&cfg)),
        format!("export {}", FolderRenameParams::decl(&cfg)),
        format!("export {}", FolderDeleteParams::decl(&cfg)),
        format!("export {}", PresetUpdateParams::decl(&cfg)),
        format!("export {}", PresetDeleteParams::decl(&cfg)),
        format!("export {}", KeybindingDeleteParams::decl(&cfg)),
        format!("export {}", SettingDeleteParams::decl(&cfg)),
    ]
}
