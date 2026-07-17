//! The record editor form: a dynamic, introspection-driven form for editing one
//! record from a base table.
//!
//! # A recursive, lazily-loaded tree
//!
//! The form is a tree of [`RecordEditor`]s. The root edits the selected record;
//! each *scalar-linked* field can expand into a nested `RecordEditor` for the
//! record it points at, and each *multi-record* field expands into a list of
//! embedded records, any of which can itself expand into a nested `RecordEditor`.
//! The recursion is unbounded — the user can drill in arbitrarily deep — because
//! nested editors are only built (and their data only fetched) once the user
//! expands into them.
//!
//! # Data loading
//!
//! Structure comes from introspection (synchronous); *values* come from the query
//! API (asynchronous). Every asynchronously-loaded piece of the tree holds a
//! [`Load`] state carrying a unique token. [`FormCtx`] dispatches a query for any
//! `Idle` slot it renders, flipping it to `Loading(token)`; when the query
//! finishes it posts a [`FormLoadMsg`] to the app's inbox, and [`RecordEditor::deliver`]
//! walks the tree to deliver the payload to the slot whose token matches. A slot
//! whose node was dropped (e.g. the form was rebuilt for a new record) simply
//! never matches, so stale responses are ignored without any bookkeeping.
//!
//! While a region loads, its skeleton renders under a translucent [`panel_fill`]
//! overlay (a subtle dimming) and its widgets are drawn non-interactively.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use eframe::egui;
use egui::text::{LayoutJob, TextWrapping};
use introspection::Schema;

use crate::button::{Button, SplitButton};
use crate::columns::ColumnMetadata;
use crate::compile;
use crate::display_gen;
use crate::field_layout::{ColSize, compute_field_layout};
use crate::http;
use crate::icons::{self, MaterialIcon};
use crate::query_def::{CompileSource, QuerySections};
use crate::rows::{CellValue, ResultRows};
use crate::theme::{self, Duo};

/// The type of a primitive (non-linked) field, which picks its label color and
/// glyph.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Primitive {
    /// A string/text column.
    Text,
    /// A numeric column.
    Number,
    /// A `UUID` column (typically the record's own id).
    Id,
}

/// The async lifecycle of one query-loaded piece of the form.
#[derive(Debug, Default)]
pub(crate) enum Load<T> {
    /// Not requested yet. Rendering an `Idle` slot (with a [`FormCtx`]) dispatches
    /// its query.
    #[default]
    Idle,
    /// A query is in flight; `token` matches the pending [`FormLoadMsg`].
    Loading(u64),
    Ready(T),
    Failed(String),
}

impl<T> Load<T> {
    fn is_idle(&self) -> bool {
        matches!(self, Load::Idle)
    }

    fn is_loading(&self) -> bool {
        matches!(self, Load::Loading(_))
    }

    /// The token this slot is waiting on, if any.
    fn token(&self) -> Option<u64> {
        match self {
            Load::Loading(t) => Some(*t),
            _ => None,
        }
    }
}

/// A single row's worth of display data for an embedded-record widget: the
/// resolved column metadata and the (one) row's Arrow cells.
#[derive(Debug)]
pub(crate) struct RecordDisplay {
    pub(crate) columns: Vec<ColumnMetadata>,
    /// Exactly one row (the linked record), kept in Arrow form so it renders
    /// through the same cell/pill logic as query results.
    pub(crate) rows: ResultRows,
}

/// The loaded rows of a multi-record field: the display columns and the related
/// records' Arrow cells. Decoupled from the field's [`MultiEntry`] list, so a
/// newly-added record can exist (and render as "New") before — or without — this
/// ever loading.
#[derive(Debug)]
pub(crate) struct MultiData {
    pub(crate) columns: Vec<ColumnMetadata>,
    pub(crate) rows: ResultRows,
    /// Number of leading columns that carry the row's identifying key (prepended
    /// to the query so each record can be re-fetched on expand); skipped when
    /// drawing the embedded widget.
    pub(crate) display_offset: usize,
}

/// UI state for one record within a multi-record field: either a loaded record
/// (pointing at a row of the field's [`MultiData`]) or a brand-new record the user
/// is adding.
#[derive(Debug)]
pub(crate) struct MultiEntry {
    /// Column/value pairs identifying this record, for re-fetching its full form.
    /// Empty for a not-yet-saved new record.
    pub(crate) key: Vec<(String, String)>,
    /// Index of this record's row within the field's loaded [`MultiData`], or
    /// `None` for a new record (which has no loaded row and renders as "New").
    pub(crate) row: Option<usize>,
    /// Whether this is a brand-new record the user is adding (not yet in the
    /// database).
    pub(crate) is_new: bool,
    pub(crate) collapsed: bool,
    /// The nested editor for this record, built when first expanded (or eagerly,
    /// for a new record).
    pub(crate) expanded: Option<Box<RecordEditor>>,
    /// Set when the user has ephemerally deleted this record within the form; a
    /// deleted entry is skipped when rendering, navigating, and counting.
    pub(crate) deleted: bool,
}

impl MultiEntry {
    /// Whether this entry currently contributes a record: not deleted.
    fn live(&self) -> bool {
        !self.deleted
    }

    /// Whether this entry represents an unsaved change: a live new record, a
    /// deleted loaded record, or a loaded record whose nested editor was edited.
    fn is_modified(&self) -> bool {
        if self.deleted {
            // Deleting a loaded record is a change; discarding a new one is not.
            return !self.is_new;
        }
        self.is_new || self.expanded.as_ref().is_some_and(|e| e.is_modified())
    }
}

/// What a form field represents, plus the state needed to render and load it.
#[derive(Debug)]
pub(crate) enum FieldKind {
    /// A plain column value. `value` is the current display text (`None` means
    /// `NULL`); `original` is the value as first loaded, so an edit is detected by
    /// `value != original`.
    Primitive {
        ty: Primitive,
        value: Option<String>,
        original: Option<String>,
    },
    /// A foreign-key column referencing a single record in `target`. `id` is the
    /// raw key value (`None` for `NULL`); `original_id` is the value as first
    /// loaded (so a cleared/changed link is detected); `embedded` is the
    /// collapsed-preview data (loaded even while collapsed); `expanded` is the
    /// nested editor built when the user drills in.
    ScalarLink {
        target: String,
        id: Option<String>,
        original_id: Option<String>,
        embedded: Load<RecordDisplay>,
        expanded: Option<Box<RecordEditor>>,
    },
    /// The set of records in `table` referencing this record through
    /// `link_column`. `count` is the number of related records as first loaded
    /// (up front); `load` is the records' display data (fetched on expand); and
    /// `entries` holds the per-record UI state — new records the user is adding
    /// (at the front) followed by the loaded records (materialized once `load`
    /// completes).
    MultiRecord {
        table: String,
        /// The column in `table` that references this record.
        link_column: String,
        /// The referenced column on this record's table (the link target, usually
        /// `id`) — the value the child rows filter against.
        parent_column: String,
        /// The current baseline record count: the loaded count, or zeroed when the
        /// user deletes all records of a not-yet-loaded field. New/deleted entries
        /// adjust the *displayed* count on top of this (see [`multi_display_count`]).
        count: usize,
        /// The record count as first loaded — the reference for detecting a
        /// structural change (records added or removed).
        original_count: usize,
        load: Load<MultiData>,
        entries: Vec<MultiEntry>,
    },
}

impl FieldKind {
    /// Whether this field currently has anything to expand into. A collapsible
    /// field is *not* expandable when it's empty — a scalar link with a `NULL`
    /// target, or a multi-record field with no related records — so no expansion
    /// toggle is shown for it.
    pub(crate) fn is_expandable(&self) -> bool {
        match self {
            // A scalar link expands into its linked record — or into the new record
            // the user is entering (id `None` while an editor is scaffolded).
            FieldKind::ScalarLink { id, expanded, .. } => id.is_some() || expanded.is_some(),
            FieldKind::MultiRecord { count, entries, .. } => {
                multi_display_count(*count, entries) > 0
            }
            FieldKind::Primitive { .. } => false,
        }
    }
}

/// The number of records a multi-record field currently shows: its loaded count,
/// plus the live new records the user has added, minus the loaded records they've
/// deleted. Equals the live-entry count once the field's records have loaded.
fn multi_display_count(count: usize, entries: &[MultiEntry]) -> usize {
    let added = entries.iter().filter(|e| e.is_new && e.live()).count();
    let removed = entries.iter().filter(|e| !e.is_new && e.deleted).count();
    (count + added).saturating_sub(removed)
}

/// One field in the form.
#[derive(Debug)]
pub(crate) struct FormField {
    /// The label shown in the field's pill — a column name, or a referencing
    /// table's name for a multi-record field.
    pub(crate) name: String,
    pub(crate) kind: FieldKind,
    /// Whether a collapsible field is collapsed. Initially `true`.
    pub(crate) collapsed: bool,
}

impl FormField {
    /// A collapsible field, collapsed (the initial state).
    fn collapsible(name: impl Into<String>, kind: FieldKind) -> Self {
        Self {
            name: name.into(),
            kind,
            collapsed: true,
        }
    }

    /// A non-collapsible primitive field.
    fn primitive(name: impl Into<String>, ty: Primitive, value: Option<String>) -> Self {
        Self {
            name: name.into(),
            kind: FieldKind::Primitive {
                ty,
                original: value.clone(),
                value,
            },
            collapsed: true,
        }
    }

    /// Whether this field (or any record nested beneath it) carries an unsaved
    /// change — drives the red modification star, propagating up the tree.
    pub(crate) fn is_modified(&self) -> bool {
        match &self.kind {
            FieldKind::Primitive {
                value, original, ..
            } => value != original,
            FieldKind::ScalarLink {
                id,
                original_id,
                expanded,
                ..
            } => {
                // A change is: a re-pointed/cleared link, a brand-new record being
                // entered (id `None` with a scaffolded editor), or edits within the
                // nested record.
                id != original_id
                    || (id.is_none() && expanded.is_some())
                    || expanded.as_ref().is_some_and(|e| e.is_modified())
            }
            FieldKind::MultiRecord {
                count,
                original_count,
                entries,
                ..
            } => {
                multi_display_count(*count, entries) != *original_count
                    || entries.iter().any(MultiEntry::is_modified)
            }
        }
    }
}

/// One step down the form tree from the root editor. A path is a sequence of
/// steps; its last step names the selectable element it addresses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FormStep {
    /// Field `index` of the editor reached so far. As a non-final step it means
    /// "descend into this scalar-link field's expanded editor"; as the final step
    /// it names the field's label (for a scalar link, its embedded value too).
    Field(usize),
    /// Embedded-record entry `index` of the multi-record field reached by the
    /// preceding `Field` step. As a non-final step it means "descend into this
    /// entry's expanded editor"; as the final step it names the embedded record.
    Entry(usize),
}

/// A path from the root editor to a selectable element.
pub(crate) type FormPath = Vec<FormStep>;

/// The current focus/selection within a record editor form. A field label carries
/// *focus* (single, exclusive); sibling embedded records within one multi-record
/// field carry a *selection* (multi). Only one of the two is active at a time — the
/// combined state is modelled as one enum so keyboard navigation moves through both.
#[derive(Debug, Clone)]
pub(crate) enum FormSelection {
    /// The focused field label. (A scalar link's embedded record shares its field's
    /// path, so focusing it focuses the label; this is always a field-label path.)
    Single(FormPath),
    /// Several sibling embedded records within one multi-record field. `parent` is
    /// the path to (and including) the multi-record `Field` step; each selected
    /// record is `parent` + `Entry(i)` for `i` in `indices`. `anchor`/`lead` are
    /// the entry indices a range extension grows between.
    Entries {
        parent: FormPath,
        indices: std::collections::HashSet<usize>,
        anchor: usize,
        lead: usize,
    },
}

impl FormSelection {
    /// Whether `path` is one of the selected elements.
    fn contains(&self, path: &[FormStep]) -> bool {
        match self {
            FormSelection::Single(p) => p.as_slice() == path,
            FormSelection::Entries {
                parent, indices, ..
            } => {
                path.len() == parent.len() + 1
                    && path.starts_with(parent.as_slice())
                    && matches!(path.last(), Some(FormStep::Entry(i)) if indices.contains(i))
            }
        }
    }

    /// The lead (primary) element's path — the one a keyboard move grows from and
    /// that is scrolled into view.
    fn lead_path(&self) -> FormPath {
        match self {
            FormSelection::Single(p) => p.clone(),
            FormSelection::Entries { parent, lead, .. } => {
                let mut p = parent.clone();
                p.push(FormStep::Entry(*lead));
                p
            }
        }
    }
}

/// Interactions captured while rendering a form body, applied by the caller after
/// the render (so state updates don't fight the borrow of the tree). At most one
/// of these fires per frame.
#[derive(Default)]
pub(crate) struct FormOutput {
    /// A selectable element was primary-clicked, with the modifiers then held.
    pub(crate) clicked: Option<(FormPath, egui::Modifiers)>,
    /// A primitive field was activated for inline editing (double-click on its
    /// label, click on its value, the pencil affordance, or the "Edit" menu item).
    pub(crate) activate: Option<FormEdit>,
    /// An inline edit committed/cancelled and the field's label should become the
    /// selection.
    pub(crate) select: Option<FormPath>,
    /// An inline edit committed via Tab: select the *next* field after this path.
    pub(crate) tab_advance: Option<FormPath>,
    /// The expansion toggle was Ctrl+clicked: toggle this item and all its
    /// siblings to match.
    pub(crate) ctrl_toggle: Option<FormPath>,
    /// The user asked to add a new record to the multi-record field at this path.
    pub(crate) new_record: Option<FormPath>,
    /// The collapsible field at this path should toggle its expansion (a
    /// double-click on a scalar link's embedded record).
    pub(crate) toggle_expand: Option<FormPath>,
    /// The field at this path should be cleared (Clear / Delete-all menu items):
    /// a primitive → `NULL`, a scalar link → unset, a multi-record field → emptied.
    pub(crate) clear: Option<FormPath>,
    /// The user asked to pick an existing record for the scalar-link field at this
    /// path (the pencil on a NULL link, or the "Pick a record" menu item). Opening
    /// the modal picker is app-level state, so this is handled by the caller.
    pub(crate) pick_record: Option<FormPath>,
    /// The user asked to enter a brand-new record for the scalar-link field at this
    /// path (the "Enter a new record" menu item).
    pub(crate) new_linked_record: Option<FormPath>,
    /// A primary click landed on the form body but not on any selectable element
    /// (a field label or embedded record) — clear the focus/selection.
    pub(crate) clear_focus: bool,
}

/// The selection/edit state threaded through the recursive render: the current
/// selection to highlight against, whether to scroll the lead into view this
/// frame, the active inline-edit buffer, and the output accumulator for
/// interactions.
struct SelCtx<'a> {
    sel: Option<&'a FormSelection>,
    scroll: bool,
    /// The active inline edit, if any (owned here for the duration of the render,
    /// restored to the root editor afterward).
    editing: &'a mut Option<FormEdit>,
    out: &'a mut FormOutput,
}

impl SelCtx<'_> {
    /// Whether the element at `path` is selected.
    fn selected(&self, path: &[FormStep]) -> bool {
        self.sel.is_some_and(|s| s.contains(path))
    }

    /// Whether the element at `path` is the lead of the selection (the one to
    /// scroll into view).
    fn is_lead(&self, path: &[FormStep]) -> bool {
        self.sel.is_some_and(|s| s.lead_path().as_slice() == path)
    }

    /// Whether the field at `path` is the one currently activated for editing.
    fn editing_at(&self, path: &[FormStep]) -> bool {
        self.editing
            .as_ref()
            .is_some_and(|e| e.path.as_slice() == path)
    }

    /// Records a primary click on the element at `path`.
    fn click(&mut self, path: &[FormStep], resp: &egui::Response) {
        if resp.clicked() {
            let mods = resp.ctx.input(|i| i.modifiers);
            self.out.clicked = Some((path.to_vec(), mods));
        }
    }
}

/// A record editor form: the fields of one record from `base_table`, in display
/// order. Used both as the sidebar's root form and, recursively, as a nested
/// editor for a linked or related record.
#[derive(Debug)]
pub(crate) struct RecordEditor {
    /// The base table whose record is being edited (drives the toolbar title).
    pub(crate) base_table: String,
    /// Column/value pairs identifying which record this edits. A single `("id", …)`
    /// for the common case; multiple entries for a composite-key table.
    pub(crate) key: Vec<(String, String)>,
    pub(crate) fields: Vec<FormField>,
    /// Load state of this record's own column values and referencing counts. The
    /// payload is applied straight into `fields`, so the slot only tracks lifecycle.
    pub(crate) values: Load<()>,
    /// The current selection within the form. Only meaningful on the *root* editor
    /// (paths are absolute from the root); nested editors leave it `None`.
    pub(crate) selection: Option<FormSelection>,
    /// The field currently activated for inline editing, if any. Only meaningful on
    /// the *root* editor (its path is absolute from the root).
    pub(crate) editing: Option<FormEdit>,
    /// Set when the selection changed via keyboard so the next render scrolls the
    /// lead element into view; cleared once consumed.
    pub(crate) scroll_to_selection: bool,
}

/// A field activated for inline editing: the path to the (primitive) field, the
/// in-progress text buffer, and a one-shot request to grab focus on the next
/// render (set when edit mode is entered).
#[derive(Debug, Clone)]
pub(crate) struct FormEdit {
    pub(crate) path: FormPath,
    pub(crate) buffer: String,
    pub(crate) focus: bool,
}

impl RecordEditor {
    /// Builds the form *structure* for editing a record from `base` — which fields
    /// exist, of which kind, in what order — from the introspected `schema`. Field
    /// values are left empty; [`FormCtx`] fetches them when the form is rendered.
    /// Returns `None` if `base` isn't a table in the schema.
    ///
    /// Order follows the plan: the base table's own columns first, in introspection
    /// order, then one multi-record field per (table, column) that references the
    /// base, listed alphabetically. A base column that is an inferred foreign key
    /// becomes a scalar-linked field; otherwise it's a primitive typed by its
    /// column type.
    pub(crate) fn structure(schema: &Schema, base: &str) -> Option<Self> {
        let table = schema.table(base)?;

        let mut fields: Vec<FormField> = table
            .columns
            .iter()
            .map(|col| {
                if let Some(link) = schema.link(base, &col.name) {
                    FormField::collapsible(
                        col.name.clone(),
                        FieldKind::ScalarLink {
                            target: link.to_table.clone(),
                            id: None,
                            original_id: None,
                            embedded: Load::Idle,
                            expanded: None,
                        },
                    )
                } else {
                    FormField::primitive(col.name.clone(), primitive_type(col), None)
                }
            })
            .collect();

        // Referencing tables become multi-record fields, alphabetical by
        // (table, column). A table may reference the base through more than one
        // column; each such link is its own field.
        let mut incoming: Vec<(&str, &str, &str)> = schema
            .incoming_links(base)
            .map(|l| {
                (
                    l.from_table.as_str(),
                    l.from_column.as_str(),
                    l.to_column.as_str(),
                )
            })
            .collect();
        incoming.sort_unstable();
        incoming.dedup();
        for (table_name, link_column, parent_column) in incoming {
            fields.push(FormField::collapsible(
                table_name.to_owned(),
                FieldKind::MultiRecord {
                    table: table_name.to_owned(),
                    link_column: link_column.to_owned(),
                    parent_column: parent_column.to_owned(),
                    count: 0,
                    original_count: 0,
                    load: Load::Idle,
                    entries: Vec::new(),
                },
            ));
        }

        Some(Self {
            base_table: base.to_owned(),
            key: Vec::new(),
            fields,
            values: Load::Idle,
            selection: None,
            editing: None,
            scroll_to_selection: false,
        })
    }

    /// Whether any field in this editor (or any record nested within it) carries an
    /// unsaved change. Recurses through the whole tree, so a modification stays
    /// visible even when the intervening sections are collapsed.
    pub(crate) fn is_modified(&self) -> bool {
        self.fields.iter().any(FormField::is_modified)
    }

    /// A stable string identifying which record this editor edits, built from its
    /// key column/value pairs. Used to stash per-record form state on the page so a
    /// record's unsaved edits survive switching to another record and back.
    pub(crate) fn key_string(&self) -> String {
        self.key
            .iter()
            .map(|(col, val)| format!("{col}={val}"))
            .collect::<Vec<_>>()
            .join("\u{1f}")
    }

    /// Sets this editor's identifying key, seeding the corresponding primitive
    /// fields with their values so the form shows which record it edits before its
    /// data loads.
    pub(crate) fn with_key(mut self, key: Vec<(String, String)>) -> Self {
        for (col, val) in &key {
            for field in &mut self.fields {
                if field.name == *col
                    && let FieldKind::Primitive {
                        value, original, ..
                    } = &mut field.kind
                {
                    *value = Some(val.clone());
                    *original = Some(val.clone());
                }
            }
        }
        self.key = key;
        self
    }

    /// Drops the field for a base column named `column`, if present. Used to hide a
    /// multi-record child's *contextual filter* column — the column that references
    /// the parent record (e.g. `credit`'s `track` when listing a track's credits).
    /// Its value is fixed and uninformative in that context, so it's omitted rather
    /// than shown for every embedded record. Only direct columns are removed; a
    /// referencing (multi-record) field that happens to share the name is kept.
    fn without_column(mut self, column: &str) -> Self {
        self.fields
            .retain(|f| f.name != column || matches!(f.kind, FieldKind::MultiRecord { .. }));
        self
    }

    /// The record's `id` value, when it's keyed by a single `id` column. Used to
    /// compare a freshly-selected result row against the open editor.
    pub(crate) fn record_id(&self) -> Option<&str> {
        self.key
            .iter()
            .find(|(c, _)| c == "id")
            .map(|(_, v)| v.as_str())
    }

    /// Attempts to deliver `slot`'s payload to the node awaiting `token`, taking it
    /// out of the `Option` on a match. Threading an `Option` (rather than the value)
    /// lets a caller try the same message against several editors in turn — only the
    /// one that owns the token consumes it.
    pub(crate) fn deliver(&mut self, token: u64, slot: &mut Option<Result<FormPayload, String>>) {
        if slot.is_none() {
            return;
        }
        if self.values.token() == Some(token) {
            self.values = match slot.take().unwrap() {
                Ok(FormPayload::Values(rows)) => {
                    self.apply_values(&rows);
                    Load::Ready(())
                }
                Ok(_) => Load::Failed("unexpected payload".to_owned()),
                Err(e) => Load::Failed(e),
            };
            return;
        }

        for field in &mut self.fields {
            if slot.is_none() {
                return;
            }
            match &mut field.kind {
                FieldKind::ScalarLink {
                    embedded, expanded, ..
                } => {
                    if embedded.token() == Some(token) {
                        *embedded = match slot.take().unwrap() {
                            Ok(FormPayload::Embedded(d)) => Load::Ready(d),
                            Ok(_) => Load::Failed("unexpected payload".to_owned()),
                            Err(e) => Load::Failed(e),
                        };
                        return;
                    }
                    if let Some(sub) = expanded {
                        sub.deliver(token, slot);
                    }
                }
                FieldKind::MultiRecord { load, entries, .. } => {
                    if load.token() == Some(token) {
                        *load = match slot.take().unwrap() {
                            Ok(FormPayload::Multi(payload)) => {
                                // Materialize one loaded entry per row, appended
                                // after any new records already at the front.
                                for (row, key) in payload.keys.into_iter().enumerate() {
                                    entries.push(MultiEntry {
                                        key,
                                        row: Some(row),
                                        is_new: false,
                                        collapsed: true,
                                        expanded: None,
                                        deleted: false,
                                    });
                                }
                                Load::Ready(payload.data)
                            }
                            Ok(_) => Load::Failed("unexpected payload".to_owned()),
                            Err(e) => Load::Failed(e),
                        };
                        return;
                    }
                    for entry in entries.iter_mut() {
                        if let Some(sub) = &mut entry.expanded {
                            sub.deliver(token, slot);
                            if slot.is_none() {
                                return;
                            }
                        }
                    }
                }
                FieldKind::Primitive { .. } => {}
            }
        }
    }

    /// Maps a one-row values result positionally onto the fields: each primitive or
    /// scalar-link field consumes the next cell as its value/id, and each
    /// multi-record field consumes the next cell as its count. The query's result
    /// columns are emitted in exactly this order (see [`values_display`]).
    fn apply_values(&mut self, rows: &ResultRows) {
        for (col, field) in self.fields.iter_mut().enumerate() {
            let cell = rows.cell_text(0, col);
            match &mut field.kind {
                FieldKind::Primitive {
                    value, original, ..
                } => {
                    *value = cell.filter(|s| !s.is_empty());
                    original.clone_from(value);
                }
                FieldKind::ScalarLink {
                    id, original_id, ..
                } => {
                    *id = cell.filter(|s| !s.is_empty());
                    original_id.clone_from(id);
                }
                FieldKind::MultiRecord {
                    count,
                    original_count,
                    ..
                } => {
                    *count = cell.and_then(|s| s.parse().ok()).unwrap_or(0);
                    *original_count = *count;
                }
            }
        }
    }
}

// --- Selection & focus -----------------------------------------------------

/// A resolved mutable reference to the node a [`FormPath`] addresses.
enum Target<'a> {
    Field(&'a mut FormField),
    Entry(&'a mut MultiEntry),
}

/// `prefix` extended by one more step.
fn child(prefix: &[FormStep], step: FormStep) -> FormPath {
    let mut v = prefix.to_vec();
    v.push(step);
    v
}

/// The selection that a click/keyboard-navigation to `path` produces on its own:
/// an entry target becomes a single-entry [`FormSelection::Entries`]; anything else
/// is a [`FormSelection::Single`].
fn selection_for_target(path: FormPath) -> FormSelection {
    if let Some(FormStep::Entry(k)) = path.last().copied() {
        let mut parent = path;
        parent.pop();
        FormSelection::Entries {
            parent,
            indices: std::iter::once(k).collect(),
            anchor: k,
            lead: k,
        }
    } else {
        FormSelection::Single(path)
    }
}

/// The set of `live` indices spanning `anchor`..=`k` inclusive (a contiguous range
/// over the *live* order, so deleted entries in between are skipped). Falls back to
/// just `{k}` if either endpoint isn't live.
fn range_indices(live: &[usize], anchor: usize, k: usize) -> HashSet<usize> {
    let (Some(a), Some(b)) = (
        live.iter().position(|&x| x == anchor),
        live.iter().position(|&x| x == k),
    ) else {
        return std::iter::once(k).collect();
    };
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    live[lo..=hi].iter().copied().collect()
}

/// Clears a field's value ephemerally (the "Selection: Delete" action on a field
/// label): a primitive becomes `NULL`, a scalar link becomes unset, and a
/// multi-record field is emptied.
fn clear_field(field: &mut FormField) {
    let mut collapse = false;
    match &mut field.kind {
        FieldKind::Primitive { value, .. } => *value = None,
        FieldKind::ScalarLink {
            id,
            embedded,
            expanded,
            ..
        } => {
            *id = None;
            *embedded = Load::Idle;
            *expanded = None;
            collapse = true;
        }
        FieldKind::MultiRecord {
            count,
            load,
            entries,
            ..
        } => {
            // Ephemerally delete every record: drop the new ones outright and mark
            // the loaded ones deleted (so the deletion counts as a change). If the
            // records were never loaded there are no entries to mark, so drop the
            // baseline count to zero instead.
            entries.retain(|e| !e.is_new);
            for entry in entries.iter_mut() {
                entry.deleted = true;
                entry.expanded = None;
            }
            if !matches!(load, Load::Ready(_)) {
                *count = 0;
            }
            collapse = true;
        }
    }
    if collapse {
        field.collapsed = true;
    }
}

impl RecordEditor {
    /// The paths of every currently-visible selectable element (field labels and
    /// embedded records), in top-to-bottom tree order. Collapsed subtrees and
    /// deleted entries are omitted. Drives keyboard selection movement.
    pub(crate) fn visible_targets(&self) -> Vec<FormPath> {
        let mut out = Vec::new();
        self.collect_targets(&[], &mut out);
        out
    }

    fn collect_targets(&self, prefix: &[FormStep], out: &mut Vec<FormPath>) {
        for (i, field) in self.fields.iter().enumerate() {
            let fp = child(prefix, FormStep::Field(i));
            out.push(fp.clone());
            if field.collapsed || !field.kind.is_expandable() {
                continue;
            }
            match &field.kind {
                FieldKind::ScalarLink {
                    expanded: Some(sub),
                    ..
                } => sub.collect_targets(&fp, out),
                FieldKind::MultiRecord { entries, .. } => {
                    for (j, entry) in entries.iter().enumerate() {
                        if entry.deleted {
                            continue;
                        }
                        let ep = child(&fp, FormStep::Entry(j));
                        out.push(ep.clone());
                        if !entry.collapsed
                            && let Some(sub) = &entry.expanded
                        {
                            sub.collect_targets(&ep, out);
                        }
                    }
                }
                _ => {}
            }
        }
    }

    /// The field a path (ending in a `Field` step) addresses, if it resolves.
    fn field_at(&self, path: &[FormStep]) -> Option<&FormField> {
        match path.split_first()? {
            (FormStep::Field(fi), []) => self.fields.get(*fi),
            (FormStep::Field(fi), rest) => {
                let field = self.fields.get(*fi)?;
                match (&field.kind, rest.split_first()?) {
                    (
                        FieldKind::ScalarLink {
                            expanded: Some(sub),
                            ..
                        },
                        (FormStep::Field(_), _),
                    ) => sub.field_at(rest),
                    (FieldKind::MultiRecord { entries, .. }, (FormStep::Entry(ej), erest)) => {
                        entries.get(*ej)?.expanded.as_ref()?.field_at(erest)
                    }
                    _ => None,
                }
            }
            (FormStep::Entry(_), _) => None,
        }
    }

    /// A mutable reference to the field or entry a path addresses, if it resolves.
    fn resolve_mut(&mut self, path: &[FormStep]) -> Option<Target<'_>> {
        match path.split_first()? {
            (FormStep::Field(fi), []) => Some(Target::Field(self.fields.get_mut(*fi)?)),
            (FormStep::Field(fi), rest) => {
                let field = self.fields.get_mut(*fi)?;
                match (&mut field.kind, rest.split_first()?) {
                    (
                        FieldKind::ScalarLink {
                            expanded: Some(sub),
                            ..
                        },
                        (FormStep::Field(_), _),
                    ) => sub.resolve_mut(rest),
                    (FieldKind::MultiRecord { entries, .. }, (FormStep::Entry(ej), erest)) => {
                        let entry = entries.get_mut(*ej)?;
                        if erest.is_empty() {
                            Some(Target::Entry(entry))
                        } else {
                            entry.expanded.as_mut()?.resolve_mut(erest)
                        }
                    }
                    _ => None,
                }
            }
            (FormStep::Entry(_), _) => None,
        }
    }

    /// The non-deleted entry indices, in order, of the multi-record field addressed
    /// by `parent` (ending in that field's `Field` step). Empty if it doesn't
    /// resolve to a loaded multi-record field.
    fn live_entry_indices(&self, parent: &[FormStep]) -> Vec<usize> {
        match self.field_at(parent) {
            Some(FormField {
                kind: FieldKind::MultiRecord { entries, .. },
                ..
            }) => entries
                .iter()
                .enumerate()
                .filter(|(_, e)| !e.deleted)
                .map(|(i, _)| i)
                .collect(),
            _ => Vec::new(),
        }
    }

    /// Updates the selection from a click on the element at `path` with `mods` held.
    /// Field labels are single-selection; sibling embedded records within one
    /// multi-record field extend (Shift) or toggle (Ctrl/⌘).
    pub(crate) fn select_click(&mut self, path: FormPath, mods: egui::Modifiers) {
        let Some(FormStep::Entry(k)) = path.last().copied() else {
            // A field label (or a scalar link's embedded record, which shares its
            // field's path): focus it, clearing any multi-record selection.
            self.selection = Some(FormSelection::Single(path));
            return;
        };
        let mut parent = path;
        parent.pop();
        // The already-selected sibling entries, if the current selection is under
        // this same multi-record field.
        let existing = match &self.selection {
            Some(FormSelection::Entries {
                parent: p,
                indices,
                anchor,
                ..
            }) if *p == parent => Some((indices.clone(), *anchor)),
            _ => None,
        };

        self.selection = Some(if mods.shift {
            let anchor = existing.map_or(k, |(_, a)| a);
            let live = self.live_entry_indices(&parent);
            FormSelection::Entries {
                indices: range_indices(&live, anchor, k),
                anchor,
                lead: k,
                parent,
            }
        } else if mods.command || mods.ctrl {
            let mut indices = existing.map(|(i, _)| i).unwrap_or_default();
            if !indices.remove(&k) {
                indices.insert(k);
            }
            if indices.is_empty() {
                self.selection = None;
                return;
            }
            FormSelection::Entries {
                indices,
                anchor: k,
                lead: k,
                parent,
            }
        } else {
            FormSelection::Entries {
                indices: std::iter::once(k).collect(),
                anchor: k,
                lead: k,
                parent,
            }
        });
    }

    /// Moves the form selection one element down (`forward`) or up. With `extend`,
    /// grows a sibling-embedded-record range from the anchor (Shift+Arrow); for a
    /// non-entry selection, or nothing selected, `extend` behaves like a plain move.
    /// A no-op when the form has no selectable elements. Flags the lead for
    /// scroll-into-view.
    pub(crate) fn select_delta(&mut self, forward: bool, extend: bool) {
        let targets = self.visible_targets();
        if targets.is_empty() {
            return;
        }

        if extend
            && let Some(FormSelection::Entries {
                parent,
                anchor,
                lead,
                ..
            }) = self.selection.clone()
        {
            let live = self.live_entry_indices(&parent);
            if let Some(pos) = live.iter().position(|&x| x == lead) {
                let new_pos = if forward {
                    (pos + 1).min(live.len().saturating_sub(1))
                } else {
                    pos.saturating_sub(1)
                };
                let new_lead = live[new_pos];
                self.selection = Some(FormSelection::Entries {
                    indices: range_indices(&live, anchor, new_lead),
                    anchor,
                    lead: new_lead,
                    parent,
                });
                self.scroll_to_selection = true;
                return;
            }
        }

        let last = targets.len() - 1;
        let cur = self.selection.as_ref().map(FormSelection::lead_path);
        let pos = cur
            .as_ref()
            .and_then(|c| targets.iter().position(|t| t == c));
        let idx = match pos {
            Some(i) if forward => (i + 1).min(last),
            Some(i) => i.saturating_sub(1),
            None if forward => 0,
            None => last,
        };
        self.selection = Some(selection_for_target(targets[idx].clone()));
        self.scroll_to_selection = true;
    }

    /// Collapses or expands the selected form items (the "Selection: Expand/Collapse
    /// nested items" actions). Only affects expandable fields and embedded records.
    pub(crate) fn set_selection_collapsed(&mut self, collapsed: bool) {
        let Some(sel) = self.selection.clone() else {
            return;
        };
        for path in selected_paths(&sel) {
            match self.resolve_mut(&path) {
                Some(Target::Field(f)) if f.kind.is_expandable() => f.collapsed = collapsed,
                Some(Target::Entry(e)) => e.collapsed = collapsed,
                _ => {}
            }
        }
    }

    /// Applies the "Selection: Delete" action to the current selection: clears a
    /// field label's value, or ephemerally deletes the selected embedded records
    /// from their multi-record field. Clears the selection afterward.
    pub(crate) fn delete_selection(&mut self) {
        let Some(sel) = self.selection.take() else {
            return;
        };
        match sel {
            FormSelection::Single(path) => {
                if let Some(Target::Field(f)) = self.resolve_mut(&path) {
                    clear_field(f);
                }
            }
            FormSelection::Entries {
                parent, indices, ..
            } => {
                if let Some(Target::Field(f)) = self.resolve_mut(&parent)
                    && let FieldKind::MultiRecord { entries, .. } = &mut f.kind
                {
                    for i in &indices {
                        if let Some(e) = entries.get_mut(*i) {
                            e.deleted = true;
                            e.expanded = None;
                        }
                    }
                    // A fully-discarded new record leaves the list entirely.
                    entries.retain(|e| !(e.is_new && e.deleted));
                }
            }
        }
    }

    /// Whether the form currently has a selection.
    pub(crate) fn has_selection(&self) -> bool {
        self.selection.is_some()
    }

    /// Drops any form selection (e.g. when the user shifts focus to the results).
    pub(crate) fn clear_selection(&mut self) {
        self.selection = None;
    }

    /// Applies the interactions captured during a [`RecordEditor::body`] render.
    /// `schema` is needed to scaffold a new record's nested structure. At most one
    /// of these fires per frame.
    pub(crate) fn apply_output(&mut self, out: FormOutput, schema: Option<&Schema>) {
        // An inline edit's commit-and-select is applied first, so that if the same
        // click both ended the edit (focus lost) and landed on another element, the
        // click's own action below wins.
        if let Some(path) = out.select {
            self.selection = Some(FormSelection::Single(path));
            self.scroll_to_selection = true;
        }
        if let Some(path) = out.tab_advance {
            self.select_next_field(&path);
        }
        // A click on empty body space clears focus/selection; a click that landed on
        // an element (`clicked`) supersedes it below.
        if out.clear_focus {
            self.selection = None;
        }
        if let Some((path, mods)) = out.clicked {
            self.select_click(path, mods);
        }
        if let Some(path) = out.ctrl_toggle {
            self.toggle_siblings(&path);
        }
        if let Some(path) = out.clear
            && let Some(Target::Field(f)) = self.resolve_mut(&path)
        {
            clear_field(f);
        }
        if let Some(path) = out.new_record
            && let Some(schema) = schema
        {
            self.add_new_record(&path, schema);
        }
        if let Some(path) = out.new_linked_record
            && let Some(schema) = schema
        {
            self.add_new_linked_record(&path, schema, String::new());
        }
        if let Some(path) = out.toggle_expand
            && let Some(Target::Field(f)) = self.resolve_mut(&path)
            && f.kind.is_expandable()
        {
            f.collapsed = !f.collapsed;
        }
        // Activation (entering edit mode) is applied last so it wins over a
        // same-frame selection, and clears any lingering label selection.
        if let Some(edit) = out.activate {
            self.selection = None;
            self.editing = Some(edit);
        }
    }

    /// The nested editor reached by a path prefix: the root for an empty path, else
    /// the expanded editor of the scalar link or entry the prefix addresses.
    fn editor_at_mut(&mut self, path: &[FormStep]) -> Option<&mut RecordEditor> {
        if path.is_empty() {
            return Some(self);
        }
        match self.resolve_mut(path)? {
            Target::Field(f) => match &mut f.kind {
                FieldKind::ScalarLink {
                    expanded: Some(sub),
                    ..
                } => Some(sub),
                _ => None,
            },
            Target::Entry(e) => e.expanded.as_deref_mut(),
        }
    }

    /// Ctrl+click on an expansion toggle: sets every sibling of the item at `path`
    /// (the other fields of its record, or the other records of its multi-record
    /// field) to match the item's newly-toggled collapsed state.
    fn toggle_siblings(&mut self, path: &[FormStep]) {
        let Some(&last) = path.last() else {
            return;
        };
        let collapsed = match self.resolve_mut(path) {
            Some(Target::Field(f)) => f.collapsed,
            Some(Target::Entry(e)) => e.collapsed,
            None => return,
        };
        let target = !collapsed;
        let parent = &path[..path.len() - 1];
        match last {
            FormStep::Field(_) => {
                if let Some(ed) = self.editor_at_mut(parent) {
                    for f in &mut ed.fields {
                        if f.kind.is_expandable() {
                            f.collapsed = target;
                        }
                    }
                }
            }
            FormStep::Entry(_) => {
                if let Some(Target::Field(f)) = self.resolve_mut(parent)
                    && let FieldKind::MultiRecord { entries, .. } = &mut f.kind
                {
                    for e in entries {
                        e.collapsed = target;
                    }
                }
            }
        }
    }

    /// After a Tab commit, moves the selection to the next field label after `path`
    /// (or leaves it there if this is the last field).
    fn select_next_field(&mut self, path: &[FormStep]) {
        let targets = self.visible_targets();
        let Some(pos) = targets.iter().position(|t| t.as_slice() == path) else {
            self.selection = Some(FormSelection::Single(path.to_vec()));
            return;
        };
        let next = targets[pos + 1..]
            .iter()
            .find(|t| matches!(t.last(), Some(FormStep::Field(_))))
            .unwrap_or(&targets[pos])
            .clone();
        self.selection = Some(FormSelection::Single(next));
        self.scroll_to_selection = true;
    }

    /// Scaffolds a new record at the top of the multi-record field at `path`:
    /// prepends an expanded, empty nested editor and activates its first editable
    /// (primitive, non-id) field for immediate typing.
    fn add_new_record(&mut self, path: &[FormStep], schema: &Schema) {
        let first_field;
        {
            let Some(Target::Field(f)) = self.resolve_mut(path) else {
                return;
            };
            let FieldKind::MultiRecord {
                table,
                link_column,
                entries,
                ..
            } = &mut f.kind
            else {
                return;
            };
            let Some(structure) = RecordEditor::structure(schema, table) else {
                return;
            };
            let mut sub = structure.without_column(link_column);
            // A new record has no key, so nothing loads; mark it ready so it renders
            // fully (not dimmed) with empty, editable fields.
            sub.values = Load::Ready(());
            first_field = sub.first_editable_index();
            entries.insert(
                0,
                MultiEntry {
                    key: Vec::new(),
                    row: None,
                    is_new: true,
                    collapsed: false,
                    expanded: Some(Box::new(sub)),
                    deleted: false,
                },
            );
            f.collapsed = false;
        }
        self.selection = None;
        if let Some(fi) = first_field {
            let mut edit_path = path.to_vec();
            edit_path.push(FormStep::Entry(0));
            edit_path.push(FormStep::Field(fi));
            self.editing = Some(FormEdit {
                path: edit_path,
                buffer: String::new(),
                focus: true,
            });
        }
    }

    /// The index of the first inline-editable field: a primitive that isn't the
    /// record's (auto-generated) id.
    fn first_editable_index(&self) -> Option<usize> {
        self.fields.iter().position(|f| {
            matches!(
                f.kind,
                FieldKind::Primitive {
                    ty: Primitive::Text | Primitive::Number,
                    ..
                }
            )
        })
    }

    /// Scaffolds a brand-new record for the scalar-link field at `path`: replaces
    /// the link with an expanded, empty nested editor (leaving `original_id` intact
    /// so the change is detected), seeds its first editable field with `prefill`
    /// (the picker's filter text, or empty), and activates that field for typing.
    pub(crate) fn add_new_linked_record(
        &mut self,
        path: &[FormStep],
        schema: &Schema,
        prefill: String,
    ) {
        let first_field;
        {
            let Some(Target::Field(f)) = self.resolve_mut(path) else {
                return;
            };
            let FieldKind::ScalarLink {
                target,
                id,
                embedded,
                expanded,
                ..
            } = &mut f.kind
            else {
                return;
            };
            let Some(mut sub) = RecordEditor::structure(schema, target) else {
                return;
            };
            // A new record has no key, so nothing loads; mark it ready so it renders
            // fully (not dimmed) with empty, editable fields.
            sub.values = Load::Ready(());
            first_field = sub.first_editable_index();
            // Seed the first editable field with the prefill so it shows the copied
            // filter text even before the user commits the activated edit below.
            if let Some(fi) = first_field
                && !prefill.is_empty()
                && let Some(FormField {
                    kind: FieldKind::Primitive { value, .. },
                    ..
                }) = sub.fields.get_mut(fi)
            {
                *value = Some(prefill.clone());
            }
            *id = None;
            *embedded = Load::Idle;
            *expanded = Some(Box::new(sub));
            f.collapsed = false;
        }
        self.selection = None;
        if let Some(fi) = first_field {
            let mut edit_path = path.to_vec();
            edit_path.push(FormStep::Field(fi));
            self.editing = Some(FormEdit {
                path: edit_path,
                buffer: prefill,
                focus: true,
            });
        }
    }

    /// Submits a record chosen in the modal picker into the scalar-link field at
    /// `path`: points the link at `id` and stashes the already-loaded `display` as
    /// the embedded preview (so no follow-up request is needed). Leaves
    /// `original_id` and the collapsed state as-is; drops any scaffolded editor.
    pub(crate) fn apply_picked_record(
        &mut self,
        path: &[FormStep],
        id: Option<String>,
        display: RecordDisplay,
    ) {
        if let Some(Target::Field(f)) = self.resolve_mut(path)
            && let FieldKind::ScalarLink {
                id: field_id,
                embedded,
                expanded,
                ..
            } = &mut f.kind
        {
            *field_id = id;
            *embedded = Load::Ready(display);
            *expanded = None;
        }
    }

    /// The target table of the scalar-link field at `path`, if it resolves to one.
    /// Used to title and query the modal record picker.
    pub(crate) fn scalar_link_target(&self, path: &[FormStep]) -> Option<String> {
        match &self.field_at(path)?.kind {
            FieldKind::ScalarLink { target, .. } => Some(target.clone()),
            _ => None,
        }
    }
}

/// Every selected element's path.
fn selected_paths(sel: &FormSelection) -> Vec<FormPath> {
    match sel {
        FormSelection::Single(p) => vec![p.clone()],
        FormSelection::Entries {
            parent, indices, ..
        } => indices
            .iter()
            .map(|&i| child(parent, FormStep::Entry(i)))
            .collect(),
    }
}

/// The column that identifies a single record in `table`, by Collectune's
/// convention: a non-null, single-column UNIQUE / PRIMARY KEY constraint,
/// preferring one named `id` when a table has several. Returns `None` for a
/// table keyed only by a composite constraint (e.g. `credit (track, artist)`).
pub(crate) fn primary_key(table: &introspection::Table) -> Option<&str> {
    let singles = || {
        table
            .unique_constraints
            .iter()
            .filter(|cols| cols.len() == 1)
            .map(|cols| cols[0].as_str())
            .filter(|name| table.column(name).is_some_and(|c| !c.nullable))
    };
    singles()
        .find(|name| *name == "id")
        .or_else(|| singles().next())
}

/// The columns that identify one record in `table` for re-fetching: the single
/// primary key when there is one, otherwise the first unique constraint (e.g. the
/// composite `(track, artist)` of `credit`). Empty when the table has no unique
/// constraint at all.
pub(crate) fn identifying_columns(table: &introspection::Table) -> Vec<String> {
    if let Some(pk) = primary_key(table) {
        return vec![pk.to_owned()];
    }
    table
        .unique_constraints
        .first()
        .cloned()
        .unwrap_or_default()
}

/// Classifies a column into a [`Primitive`] type for icon/color purposes.
fn primitive_type(col: &introspection::Column) -> Primitive {
    match col.type_name.as_deref() {
        Some(t) if t.eq_ignore_ascii_case("UUID") => Primitive::Id,
        Some(t) if is_numeric_type(t) => Primitive::Number,
        _ => Primitive::Text,
    }
}

/// Whether a `DuckDB` type name denotes a number (so its field gets the numeric
/// styling).
fn is_numeric_type(type_name: &str) -> bool {
    const NUMERIC_PREFIXES: &[&str] = &[
        "TINYINT",
        "SMALLINT",
        "INTEGER",
        "INT",
        "BIGINT",
        "HUGEINT",
        "UTINYINT",
        "USMALLINT",
        "UINTEGER",
        "UBIGINT",
        "UHUGEINT",
        "FLOAT",
        "REAL",
        "DOUBLE",
        "DECIMAL",
        "NUMERIC",
    ];
    let t = type_name.to_ascii_uppercase();
    NUMERIC_PREFIXES.iter().any(|p| t.starts_with(p))
}

// --- Query building --------------------------------------------------------

/// A Querydown string literal: single-quoted with `'` and `\` escaped.
fn qd_str(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))
}

/// A backtick-quoted Querydown identifier (so reserved words / odd names are safe).
fn qd_ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

/// The filter section matching a record by its identifying key: one
/// `col:=='value'` equality per key column, space-joined (top-level AND).
fn key_filter(key: &[(String, String)]) -> String {
    key.iter()
        .map(|(col, val)| format!("{}:=={}", qd_ident(col), qd_str(val)))
        .collect::<Vec<_>>()
        .join(" ")
}

/// The display section for a record's own values query: one result column per
/// field, in field order — the column value for primitives/scalar links, a related
/// count for multi-record fields — so the result can be mapped back positionally.
fn values_display(fields: &[FormField]) -> String {
    fields
        .iter()
        .map(|field| match &field.kind {
            FieldKind::Primitive { .. } | FieldKind::ScalarLink { .. } => {
                format!("${}", qd_ident(&field.name))
            }
            FieldKind::MultiRecord {
                table, link_column, ..
            } => format!("$#{}({})", qd_ident(table), qd_ident(link_column)),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The [`CompileSource`] for a record's own values: filter by key, select each
/// field's value or count.
fn values_source(editor: &RecordEditor) -> CompileSource {
    CompileSource::Sections(QuerySections {
        base: editor.base_table.clone(),
        filter: key_filter(&editor.key),
        sort: String::new(),
        display: values_display(&editor.fields),
    })
}

// --- Async loading ---------------------------------------------------------

/// A finished form query, ready to be applied to the tree by [`RecordEditor::deliver`].
#[derive(Debug)]
pub(crate) enum FormPayload {
    /// One row of the record's own column values and referencing counts.
    Values(ResultRows),
    /// The single linked record for a scalar-link preview.
    Embedded(RecordDisplay),
    /// The related records for an expanded multi-record field: the display data and
    /// one identifying key per row (used to materialize the field's entries).
    Multi(MultiPayload),
}

/// The result of a multi-record field's related-records query: the display data
/// plus each row's identifying key (in row order).
#[derive(Debug)]
pub(crate) struct MultiPayload {
    pub(crate) data: MultiData,
    pub(crate) keys: Vec<Vec<(String, String)>>,
}

/// A completed form query posted to the app inbox: which slot (`token`) it belongs
/// to and its result.
pub(crate) struct FormLoadMsg {
    pub(crate) token: u64,
    pub(crate) result: Result<FormPayload, String>,
}

/// How to interpret a query's rows when it finishes.
enum LoadShape {
    Values,
    Embedded,
    /// Multi-record: the `key` columns prepended to the display, for building each
    /// entry's identity.
    Multi {
        key_columns: Vec<String>,
    },
}

/// The environment a form render needs to fetch data: the schema (for building
/// nested structure), the compiler inputs, and the inbox/token machinery that
/// carries query results back to the tree.
pub(crate) struct FormCtx<'a> {
    pub(crate) schema: &'a Schema,
    pub(crate) schema_json: &'a str,
    pub(crate) egui_ctx: &'a egui::Context,
    pub(crate) inbox: &'a Arc<Mutex<Vec<FormLoadMsg>>>,
    /// Monotonic token source; each dispatched query claims the next value.
    pub(crate) next_token: &'a mut u64,
}

impl FormCtx<'_> {
    fn alloc_token(&mut self) -> u64 {
        let t = *self.next_token;
        *self.next_token += 1;
        t
    }

    /// Compiles `source` and streams it, posting a [`FormLoadMsg`] tagged `token`
    /// when it finishes. `shape` says how to turn the rows into a [`FormPayload`].
    fn run(&mut self, token: u64, source: &CompileSource, shape: LoadShape) {
        let compiled = match compile::querydown_to_duckdb(source, self.schema_json) {
            Ok(c) => c,
            Err(e) => {
                self.post(token, Err(e));
                return;
            }
        };
        let columns = compiled.columns;
        let inbox = Arc::clone(self.inbox);
        let ctx = self.egui_ctx.clone();
        http::load_rows(compiled.sql, move |result| {
            let payload = result.map(|rows| match shape {
                LoadShape::Values => FormPayload::Values(rows),
                LoadShape::Embedded => FormPayload::Embedded(RecordDisplay { columns, rows }),
                LoadShape::Multi { key_columns } => {
                    let display_offset = key_columns.len();
                    let keys = (0..rows.len())
                        .map(|r| {
                            key_columns
                                .iter()
                                .enumerate()
                                .map(|(i, name)| {
                                    (name.clone(), rows.cell_text(r, i).unwrap_or_default())
                                })
                                .collect()
                        })
                        .collect();
                    FormPayload::Multi(MultiPayload {
                        data: MultiData {
                            columns,
                            rows,
                            display_offset,
                        },
                        keys,
                    })
                }
            });
            inbox.lock().unwrap().push(FormLoadMsg {
                token,
                result: payload,
            });
            ctx.request_repaint();
        });
    }

    /// Posts a result to the inbox directly (used for synchronous compile errors).
    fn post(&self, token: u64, result: Result<FormPayload, String>) {
        self.inbox
            .lock()
            .unwrap()
            .push(FormLoadMsg { token, result });
        self.egui_ctx.request_repaint();
    }

    /// Dispatches a record's own values query, returning the claimed token.
    fn load_values(&mut self, editor: &RecordEditor) -> u64 {
        let token = self.alloc_token();
        self.run(token, &values_source(editor), LoadShape::Values);
        token
    }

    /// Dispatches a scalar-link's collapsed-preview query (one row), with a
    /// dynamically-generated display derived from the target table's schema.
    fn load_embedded(&mut self, target: &str, id: &str) -> u64 {
        let token = self.alloc_token();
        let generated = display_gen::generate(self.schema, target, None);
        let source = CompileSource::Sections(QuerySections {
            base: target.to_owned(),
            filter: format!("{}:=={}", qd_ident("id"), qd_str(id)),
            sort: String::new(),
            display: generated.display,
        });
        self.run(token, &source, LoadShape::Embedded);
        token
    }

    /// Dispatches a multi-record field's related-records query. Prepends the child
    /// table's identifying columns to the display (so each row carries its key) and
    /// filters by the link column pointing back at `parent_value`.
    fn load_multi(
        &mut self,
        table: &str,
        link_column: &str,
        parent_value: &str,
        key_columns: &[String],
    ) -> u64 {
        let token = self.alloc_token();
        let keys_display = key_columns
            .iter()
            .map(|c| format!("${}", qd_ident(c)))
            .collect::<Vec<_>>()
            .join(" ");
        // The link column is the contextual filter: excluded from the display and
        // factored into the dynamic column scoring/sorting.
        let generated = display_gen::generate(self.schema, table, Some(link_column));
        let display = if keys_display.is_empty() {
            generated.display
        } else {
            format!("{keys_display} {}", generated.display)
        };
        let source = CompileSource::Sections(QuerySections {
            base: table.to_owned(),
            filter: format!("{}:=={}", qd_ident(link_column), qd_str(parent_value)),
            sort: generated.sort,
            display,
        });
        self.run(
            token,
            &source,
            LoadShape::Multi {
                key_columns: key_columns.to_vec(),
            },
        );
        token
    }
}

// --- Rendering: constants --------------------------------------------------

/// Field-label background per kind: a light pastel on the light theme, a deep
/// desaturated tone on the dark one. The light values are taken from the mockup.
const TEXT_BG: Duo = Duo {
    light: egui::Color32::from_rgb(0xC8, 0xE3, 0xC7),
    dark: egui::Color32::from_rgb(0x2E, 0x45, 0x2C),
};
const NUMBER_BG: Duo = Duo {
    light: egui::Color32::from_rgb(0xFD, 0xD8, 0xD8),
    dark: egui::Color32::from_rgb(0x4E, 0x2C, 0x2C),
};
const LINK_BG: Duo = Duo {
    light: egui::Color32::from_rgb(0xF8, 0xF4, 0xB6),
    dark: egui::Color32::from_rgb(0x50, 0x49, 0x24),
};
const ID_BG: Duo = Duo {
    light: egui::Color32::from_rgb(0xEA, 0xD7, 0xFC),
    dark: egui::Color32::from_rgb(0x3D, 0x2E, 0x52),
};
const MULTI_BG: Duo = Duo {
    light: egui::Color32::from_rgb(0xB4, 0xD3, 0xFB),
    dark: egui::Color32::from_rgb(0x2A, 0x47, 0x66),
};

/// Icon + text color inside a label pill.
const LABEL_FG: Duo = Duo {
    light: egui::Color32::from_gray(0x22),
    dark: egui::Color32::from_gray(0xEC),
};

/// Background of a multi-record field's count badge.
const COUNT_BG: Duo = Duo {
    light: egui::Color32::from_gray(0xE3),
    dark: egui::Color32::from_gray(0x3A),
};

/// Color of the hierarchy tree lines down the left gutter.
const TREE_LINE: Duo = Duo {
    light: egui::Color32::from_gray(0xC8),
    dark: egui::Color32::from_gray(0x50),
};

/// Border of an embedded-record widget — kept faint (a small step off the panel)
/// so the widget reads without a hard outline.
const EMBED_BORDER: Duo = Duo {
    light: egui::Color32::from_gray(0xDC),
    dark: egui::Color32::from_gray(0x3E),
};
/// Fill of a not-yet-loaded embedded-record skeleton.
const SKELETON_FILL: Duo = Duo {
    light: egui::Color32::from_gray(0xEC),
    dark: egui::Color32::from_gray(0x33),
};

const PILL_RADIUS: f32 = 6.0;
/// Width of the blue border drawn tight around a focused field label's pill.
const FOCUS_BORDER_WIDTH: f32 = 1.5;
const PILL_PAD_X: f32 = 7.0;
const PILL_PAD_Y: f32 = 2.0;
const PILL_ICON_SIZE: f32 = 14.0;
const PILL_TEXT_SIZE: f32 = 13.0;
const PILL_ICON_GAP: f32 = 5.0;
/// Width of the chevron gutter reserved on the left of every field.
const CHEVRON_GUTTER: f32 = 18.0;
const CHEVRON_SIZE: f32 = 17.6;
/// Radius of the panel-colored disc drawn behind a chevron to break the tree
/// line. Kept a touch smaller than the glyph so the tree lines read right up
/// close to the chevron.
const CHEVRON_DISC_RADIUS: f32 = 6.5;
/// Extra horizontal space between the chevron gutter and the rest of the form
/// item, exposing more of the tree line's connecting segment.
const TICK_EXTRA: f32 = 5.0;
const VALUE_GAP: f32 = 8.0;
const ROW_SPACING: f32 = 3.0;
/// Space between the toolbar's bottom border and the first field row.
const BODY_HEADROOM: f32 = 6.0;
const COUNT_TEXT_SIZE: f32 = 12.0;
const VALUE_TEXT_SIZE: f32 = 14.0;
const UUID_TEXT_SIZE: f32 = 12.0;
/// Left indent added per level of nesting.
const INDENT: f32 = 16.0;
/// Embedded-record widget: inner padding, gaps, text size.
const EMBED_PAD_X: f32 = 9.0;
const EMBED_PAD_Y: f32 = 5.0;
const EMBED_COL_GAP: f32 = 12.0;
const EMBED_TEXT_SIZE: f32 = 12.0;

/// Height of the record editor toolbar — matched to the query builder toolbar.
pub(crate) const TOOLBAR_HEIGHT: f32 = 30.0;

/// The outcome of showing a [`RecordEditor`]: whether the user asked to close it.
#[derive(Default)]
pub(crate) struct FormResponse {
    pub(crate) cancel: bool,
}

impl RecordEditor {
    /// Renders the whole form (toolbar then body). Used by snapshot tests to drive
    /// the form standalone with no data loading (`ctx` is `None`, so nothing is
    /// dispatched and the tree renders exactly as constructed).
    #[allow(dead_code)]
    pub(crate) fn show(&mut self, ui: &mut egui::Ui) -> FormResponse {
        let inner = ui.allocate_ui_with_layout(
            egui::vec2(ui.available_width(), TOOLBAR_HEIGHT),
            egui::Layout::left_to_right(egui::Align::Center),
            |ui| self.toolbar(ui),
        );
        let border_y = inner.response.rect.bottom();
        ui.painter().hline(
            inner.response.rect.x_range(),
            border_y,
            egui::Stroke::new(1.0, ui.visuals().widgets.noninteractive.bg_stroke.color),
        );
        let _ = self.body(ui, None);
        inner.inner
    }

    /// The toolbar: the "Edit {table}" title, then a disabled Save and a close
    /// ("X") button. Returns whether close was clicked.
    pub(crate) fn toolbar(&self, ui: &mut egui::Ui) -> FormResponse {
        let mut resp = FormResponse::default();
        // The Save button enables once the form has unsaved changes. (Submission is
        // handled elsewhere; here it just reflects modification state.)
        let modified = self.is_modified();
        ui.horizontal_centered(|ui| {
            ui.label(
                egui::RichText::new(format!("Edit {}", self.base_table))
                    .size(13.0)
                    .color(ui.visuals().weak_text_color()),
            );
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if Button::icon(icons::CLOSE).show(ui).clicked() {
                    resp.cancel = true;
                }
                ui.add_space(2.0);
                ui.add_enabled_ui(modified, |ui| {
                    SplitButton::new(icons::SAVE, "Save")
                        .active(false)
                        .show_menu(false)
                        .show(ui);
                });
            });
        });
        resp
    }

    /// The form body: the recursive field tree. Pass a [`FormCtx`] to fetch data
    /// for any not-yet-loaded slots that come into view.
    ///
    /// The caller places the body immediately below the toolbar's bottom border;
    /// we capture that border position first, then inset the fields with a little
    /// headroom — so the root tree spine can rise all the way up to the border,
    /// visually anchoring the tree to the toolbar.
    pub(crate) fn body(&mut self, ui: &mut egui::Ui, ctx: Option<&mut FormCtx>) -> FormOutput {
        // Clone the selection so it can be read while the tree is borrowed mutably
        // for rendering; consume the one-shot scroll request.
        let sel = self.selection.clone();
        let scroll = self.scroll_to_selection;
        self.scroll_to_selection = false;
        // Move the active-edit state out of `self` for the render (so `self` can be
        // borrowed as the tree while the edit buffer is threaded separately);
        // restore whatever survives — an in-progress edit stays, a committed or
        // cancelled one is cleared in-render.
        let mut editing = self.editing.take();
        let mut out = FormOutput::default();
        let mut sc = SelCtx {
            sel: sel.as_ref(),
            scroll,
            editing: &mut editing,
            out: &mut out,
        };
        // A background click sensor spanning the whole body, registered *before* the
        // fields so their own click regions sit on top of it. A click that misses
        // every field/embedded record falls through to this and clears the
        // focus/selection ("click elsewhere to unfocus").
        let bg = ui.interact(
            ui.available_rect_before_wrap(),
            ui.id().with("form_bg"),
            egui::Sense::click(),
        );
        let toolbar_border = ui.cursor().top();
        ui.add_space(BODY_HEADROOM);
        render_record(ui, ctx, self, 0, Some(toolbar_border), &[], &mut sc);
        if bg.clicked() {
            out.clear_focus = true;
        }
        self.editing = editing;
        out
    }
}

// --- Rendering: the recursive tree -----------------------------------------

/// One sibling's anchors for the tree spine: `(spine x, tick end x, row center y)`.
type Tick = (f32, f32, f32);

/// Draws a sibling group's tree lines into the reserved `idx` slot (so the rows'
/// chevron discs, painted later, break the spine): a vertical spine at the shared
/// `spine_x`, plus a horizontal tick from the spine to each row. `spine_top` fixes
/// where the spine begins — the bottom of the element the branch descends from, so
/// it never rides up into the parent; when `None` (the root) it starts at the first
/// row's center.
fn draw_tree(ui: &egui::Ui, idx: egui::layers::ShapeIdx, ticks: &[Tick], spine_top: Option<f32>) {
    let stroke = egui::Stroke::new(1.0, TREE_LINE.get(ui.visuals()));
    let spine_x = ticks[0].0;
    let top = spine_top.map_or(ticks[0].2, f32::round);
    let mut shapes: Vec<egui::Shape> = Vec::with_capacity(ticks.len() + 1);
    shapes.push(egui::Shape::line_segment(
        [
            egui::pos2(spine_x, top),
            egui::pos2(spine_x, ticks.last().unwrap().2),
        ],
        stroke,
    ));
    for (tx, tick_end, cy) in ticks {
        shapes.push(egui::Shape::line_segment(
            [egui::pos2(*tx, *cy), egui::pos2(*tick_end, *cy)],
            stroke,
        ));
    }
    ui.painter().set(idx, egui::Shape::Vec(shapes));
}

/// The spine x and tick-end x for a row whose content starts at `row_left`, at the
/// given `indent`: the spine runs through the chevron gutter's center; the tick
/// reaches the left edge of the row's pill/widget.
fn tick_anchors(row_left: f32, indent: f32) -> (f32, f32) {
    let spine_x = (row_left + indent + CHEVRON_GUTTER * 0.5).round();
    let tick_end = row_left + indent + CHEVRON_GUTTER + TICK_EXTRA;
    (spine_x, tick_end)
}

/// Renders one record editor's fields as a sibling group (with the left-gutter
/// tree spine), then any expanded children beneath each field, indented one level.
/// Dispatches this record's values query if it hasn't loaded yet. `spine_top` is
/// where this group's spine begins (see [`draw_tree`]).
fn render_record(
    ui: &mut egui::Ui,
    mut ctx: Option<&mut FormCtx>,
    editor: &mut RecordEditor,
    depth: usize,
    spine_top: Option<f32>,
    path: &[FormStep],
    sc: &mut SelCtx,
) {
    // Fetch this record's values once, but only when we know which record it is —
    // an empty key would otherwise match the whole table.
    if editor.values.is_idle()
        && !editor.key.is_empty()
        && let Some(ctx) = ctx.as_deref_mut()
    {
        editor.values = Load::Loading(ctx.load_values(editor));
    }
    let loading = editor.values.is_loading();
    let indent = depth as f32 * INDENT;

    if editor.fields.is_empty() {
        return;
    }

    let tree_idx = ui.painter().add(egui::Shape::Noop);
    let mut ticks: Vec<Tick> = Vec::with_capacity(editor.fields.len());

    // While this record's own values load, the fields are placeholders; draw them
    // under a dimming overlay and don't let them take input.
    let key = editor.key.clone();
    let group = ui.scope(|ui| {
        for (i, field) in editor.fields.iter_mut().enumerate() {
            if i > 0 {
                ui.add_space(ROW_SPACING);
            }
            let field_path = child(path, FormStep::Field(i));
            let rect = render_field(
                ui,
                ctx.as_deref_mut(),
                field,
                &key,
                depth,
                indent,
                loading,
                &field_path,
                sc,
            );
            let (spine_x, tick_end) = tick_anchors(rect.left(), indent);
            ticks.push((spine_x, tick_end, rect.center().y.round()));
        }
    });

    draw_tree(ui, tree_idx, &ticks, spine_top);

    if loading {
        paint_overlay(ui, group.response.rect);
    }
}

/// Renders one field row (chevron gutter, label pill, value) at `indent`, then —
/// if it's an expanded collapsible field — its children beneath. Returns the
/// header row's rect (for the parent's tree ticks).
///
/// Every inline element is vertically centered on a single line. The row is pinned
/// to a fixed height up front (a zero-width spacer) so left-to-right center
/// alignment lines every element up on the same center regardless of the order
/// they're added — needed because a value's embedded-record widget can be taller
/// than the label pill.
#[allow(clippy::too_many_arguments)]
fn render_field(
    ui: &mut egui::Ui,
    mut ctx: Option<&mut FormCtx>,
    field: &mut FormField,
    parent_key: &[(String, String)],
    depth: usize,
    indent: f32,
    parent_loading: bool,
    path: &[FormStep],
    sc: &mut SelCtx,
) -> egui::Rect {
    // A collapsible field shows an expansion toggle only when it's non-empty; an
    // empty scalar link (NULL) or empty multi-record field has nothing to expand.
    let expandable = field.kind.is_expandable();
    let selected = sc.selected(path);
    let modified = field.is_modified();
    let (bg, icon) = kind_style(&field.kind);
    let galley = layout_pill(ui, icon, &field.name);
    let pill_size = pill_size(&galley);

    // Width left for the value area, matching what `draw_value` sees once the
    // chevron gutter, pill and gaps are consumed — so a dynamic embedded widget's
    // height can be measured to size the row before anything is drawn.
    let value_left = indent + CHEVRON_GUTTER + TICK_EXTRA + pill_size.x + VALUE_GAP;
    let value_avail = (ui.available_width() - value_left).max(0.0);
    // An activated field's editor lets the row grow to fit the input; otherwise the
    // row is pinned to the taller of the pill and the value affordance.
    let active_edit = sc.editing.as_ref().filter(|e| e.path.as_slice() == path);
    let row_h = pill_size
        .y
        .max(value_height(ui, &field.kind, value_avail, active_edit));

    let row = ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 0.0;
        ui.allocate_exact_size(egui::vec2(0.0, row_h), egui::Sense::hover());
        if indent > 0.0 {
            ui.add_space(indent);
        }
        // Chevron gutter — clickable for an expandable field (unless the parent
        // record is still loading its structure/values).
        let (gutter, gutter_resp) = ui.allocate_exact_size(
            egui::vec2(CHEVRON_GUTTER, row_h),
            if expandable && !parent_loading {
                egui::Sense::CLICK
            } else {
                egui::Sense::hover()
            },
        );
        if expandable {
            draw_chevron(ui, gutter.center(), field.collapsed, gutter_resp.hovered());
            if gutter_resp.clicked() {
                // Ctrl/⌘+click toggles this item and all its siblings together.
                let mods = ui.input(|i| i.modifiers);
                if mods.command || mods.ctrl {
                    sc.out.ctrl_toggle = Some(path.to_vec());
                } else {
                    field.collapsed = !field.collapsed;
                }
            }
        }

        ui.add_space(TICK_EXTRA);
        // The label pill selects the field on click; its ring shows the selection.
        let pill_resp = paint_pill(ui, galley, pill_size, bg, selected);
        if modified {
            paint_modified_star(ui, pill_resp.rect);
        }
        label_interactions(ui, field, path, &pill_resp, sc);
        if sc.scroll && sc.is_lead(path) {
            ui.scroll_to_rect(pill_resp.rect, None);
        }
        ui.add_space(VALUE_GAP);
        draw_value(ui, ctx.as_deref_mut(), field, path, sc);
    });

    // Children of an expanded expandable field: their spine descends from the
    // bottom of this header row.
    if expandable && !field.collapsed {
        render_children(
            ui,
            ctx,
            field,
            parent_key,
            depth,
            row.response.rect.bottom(),
            path,
            sc,
        );
    }

    row.response.rect
}

/// Renders the expanded children of a collapsible field one level deeper: a
/// scalar link's nested editor, or a multi-record field's list of embedded records
/// (each itself expandable into a nested editor). `parent_bottom` is where the
/// children's tree spine begins.
#[allow(clippy::too_many_arguments)]
fn render_children(
    ui: &mut egui::Ui,
    mut ctx: Option<&mut FormCtx>,
    field: &mut FormField,
    parent_key: &[(String, String)],
    depth: usize,
    parent_bottom: f32,
    path: &[FormStep],
    sc: &mut SelCtx,
) {
    ui.add_space(ROW_SPACING);
    match &mut field.kind {
        FieldKind::ScalarLink {
            target,
            id,
            expanded,
            ..
        } => {
            // Build the nested editor lazily on first expand of an existing link.
            // A new record being entered arrives with `expanded` already scaffolded
            // (and no `id`), so it renders straight through.
            if expanded.is_none()
                && let Some(id) = id.clone()
                && let Some(ctx) = ctx.as_deref_mut()
                && let Some(sub) = RecordEditor::structure(ctx.schema, target)
            {
                *expanded = Some(Box::new(sub.with_key(vec![("id".to_owned(), id)])));
            }
            if let Some(sub) = expanded {
                render_record(ui, ctx, sub, depth + 1, Some(parent_bottom), path, sc);
            }
        }
        FieldKind::MultiRecord {
            table,
            link_column,
            parent_column,
            count,
            load,
            entries,
            ..
        } => {
            // Dispatch the related-records query on first expand, but only when
            // there are loaded records to fetch — a field showing only new records
            // never needs a query.
            if load.is_idle()
                && *count > 0
                && let Some(ctx) = ctx.as_deref_mut()
                && let Some(parent_value) = parent_key
                    .iter()
                    .find(|(c, _)| c == parent_column)
                    .map(|(_, v)| v.clone())
            {
                let key_columns = ctx
                    .schema
                    .table(table)
                    .map(identifying_columns)
                    .unwrap_or_default();
                *load =
                    Load::Loading(ctx.load_multi(table, link_column, &parent_value, &key_columns));
            }
            render_multi(
                ui,
                ctx,
                table,
                link_column,
                *count,
                load,
                entries,
                depth + 1,
                parent_bottom,
                path,
                sc,
            );
        }
        FieldKind::Primitive { .. } => {}
    }
}

/// Renders a multi-record field's related records at `depth`: `count` skeleton
/// widgets while loading (under an overlay), or the loaded rows once ready — each
/// an embedded record with its own chevron that expands into a nested editor. Once
/// loaded, the embedded records get their own tree spine (descending from
/// `parent_bottom`) connecting their chevrons.
#[allow(clippy::too_many_arguments)]
fn render_multi(
    ui: &mut egui::Ui,
    mut ctx: Option<&mut FormCtx>,
    table: &str,
    link_column: &str,
    count: usize,
    load: &mut Load<MultiData>,
    entries: &mut [MultiEntry],
    depth: usize,
    parent_bottom: f32,
    path: &[FormStep],
    sc: &mut SelCtx,
) {
    let indent = depth as f32 * INDENT;

    if let Load::Failed(e) = load {
        ui.horizontal(|ui| {
            ui.add_space(indent + CHEVRON_GUTTER + TICK_EXTRA);
            ui.colored_label(egui::Color32::RED, e.as_str());
        });
        return;
    }

    let ready = matches!(load, Load::Ready(_));
    let tree_idx = ui.painter().add(egui::Shape::Noop);
    let mut ticks: Vec<Tick> = Vec::with_capacity(entries.len());
    let mut first = true;
    for (i, entry) in entries.iter_mut().enumerate() {
        // Ephemerally-deleted records leave the list; before the records load only
        // new records are materialized (loaded ones are shown as skeletons below).
        if entry.deleted || (!entry.is_new && !ready) {
            continue;
        }
        if !first {
            ui.add_space(ROW_SPACING);
        }
        first = false;
        // A loaded entry draws from its row of the loaded data; a new record has no
        // row and renders as "New".
        let cells = match (&*load, entry.row) {
            (Load::Ready(d), Some(r)) => {
                Some((d.columns.clone(), d.rows.row_values(r), d.display_offset))
            }
            _ => None,
        };
        let entry_path = child(path, FormStep::Entry(i));
        let rect = render_entry(
            ui,
            ctx.as_deref_mut(),
            cells
                .as_ref()
                .map(|(c, v, o)| (c.as_slice(), v.as_slice(), *o)),
            entry,
            table,
            link_column,
            depth,
            indent,
            &entry_path,
            sc,
        );
        let (spine_x, tick_end) = tick_anchors(rect.left(), indent);
        ticks.push((spine_x, tick_end, rect.center().y.round()));
    }

    // Skeletons for the loaded records still in flight (shown under a dimming
    // overlay), beneath any new records already added.
    if !ready {
        if !first {
            ui.add_space(ROW_SPACING);
        }
        let group = ui.scope(|ui| {
            for i in 0..count.max(1) {
                if i > 0 {
                    ui.add_space(ROW_SPACING);
                }
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 0.0;
                    ui.add_space(indent + CHEVRON_GUTTER + TICK_EXTRA);
                    draw_skeleton(ui);
                });
            }
        });
        paint_overlay(ui, group.response.rect);
    }

    if !ticks.is_empty() {
        draw_tree(ui, tree_idx, &ticks, Some(parent_bottom));
    }
}

/// Renders one embedded record within a multi-record field: a chevron plus the
/// embedded widget (vertically centered together), and (when expanded) its nested
/// editor beneath. `display` carries the loaded row's columns/cells (and their
/// key-column offset), or `None` for a new record (rendered as "New"). Returns the
/// header row's rect (for the parent's tree ticks).
#[allow(clippy::too_many_arguments)]
fn render_entry(
    ui: &mut egui::Ui,
    mut ctx: Option<&mut FormCtx>,
    display: Option<(&[ColumnMetadata], &[CellValue], usize)>,
    entry: &mut MultiEntry,
    table: &str,
    link_column: &str,
    depth: usize,
    indent: f32,
    path: &[FormStep],
    sc: &mut SelCtx,
) -> egui::Rect {
    let row_h = match display {
        Some((columns, _, offset)) => {
            let avail = (ui.available_width() - indent - CHEVRON_GUTTER - TICK_EXTRA).max(0.0);
            embed_size(ui, &columns[offset..], avail).y
        }
        None => skeleton_height(ui),
    };
    let selected = sc.selected(path);
    let modified = entry.is_modified();

    let row = ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 0.0;
        ui.allocate_exact_size(egui::vec2(0.0, row_h), egui::Sense::hover());
        if indent > 0.0 {
            ui.add_space(indent);
        }
        let (gutter, gutter_resp) =
            ui.allocate_exact_size(egui::vec2(CHEVRON_GUTTER, row_h), egui::Sense::CLICK);
        draw_chevron(ui, gutter.center(), entry.collapsed, gutter_resp.hovered());
        ui.add_space(TICK_EXTRA);
        // The embedded record selects on single click (multi-selectable among its
        // siblings) and toggles expand on double click. A selected record takes the
        // same blue fill as a selected query result row.
        let widget = match display {
            Some((columns, cells, offset)) => {
                draw_embedded(ui, &columns[offset..], &cells[offset..], selected)
            }
            None => draw_new_embedded(ui, selected),
        };
        if modified {
            paint_modified_star(ui, widget.rect);
        }
        if sc.scroll && sc.is_lead(path) {
            ui.scroll_to_rect(widget.rect, None);
        }
        sc.click(path, &widget);
        if gutter_resp.clicked() || widget.double_clicked() {
            entry.collapsed = !entry.collapsed;
        }
        // Context menu: delete this single record (ephemerally).
        egui::Popup::context_menu(&widget).show(|ui| {
            ui.set_width(150.0);
            if crate::now_playing::menu_item(ui, icons::DELETE, "Delete", true, None).clicked() {
                entry.deleted = true;
                entry.expanded = None;
            }
        });
    });

    if !entry.collapsed {
        if entry.expanded.is_none()
            && !entry.is_new
            && let Some(ctx) = ctx.as_deref_mut()
            && let Some(sub) = RecordEditor::structure(ctx.schema, table)
        {
            // Hide the contextual-filter column (the one referencing the parent);
            // its value is fixed for every record in this list.
            entry.expanded = Some(Box::new(
                sub.without_column(link_column).with_key(entry.key.clone()),
            ));
        }
        if let Some(sub) = &mut entry.expanded {
            ui.add_space(ROW_SPACING);
            render_record(
                ui,
                ctx,
                sub,
                depth + 1,
                Some(row.response.rect.bottom()),
                path,
                sc,
            );
        }
    }

    row.response.rect
}

// --- Rendering: primitives -------------------------------------------------

/// The label color and glyph for a field kind.
fn kind_style(kind: &FieldKind) -> (Duo, MaterialIcon) {
    match kind {
        FieldKind::Primitive {
            ty: Primitive::Text,
            ..
        } => (TEXT_BG, icons::FIELD_TEXT),
        FieldKind::Primitive {
            ty: Primitive::Number,
            ..
        } => (NUMBER_BG, icons::FIELD_NUMBER),
        FieldKind::Primitive {
            ty: Primitive::Id, ..
        } => (ID_BG, icons::FIELD_ID),
        FieldKind::ScalarLink { .. } => (LINK_BG, icons::FIELD_LINK),
        FieldKind::MultiRecord { .. } => (MULTI_BG, icons::FIELD_RECORDS),
    }
}

/// Draws the expansion chevron for a collapsible item, centered at `center`: a
/// panel-colored disc (breaking the tree line behind it) with the open/closed
/// glyph on top, brightened on hover.
fn draw_chevron(ui: &egui::Ui, center: egui::Pos2, collapsed: bool, hovered: bool) {
    ui.painter()
        .circle_filled(center, CHEVRON_DISC_RADIUS, ui.visuals().panel_fill);
    let glyph = if collapsed {
        icons::EXPAND_CLOSED
    } else {
        icons::EXPAND_OPEN
    };
    let color = if hovered {
        ui.visuals().text_color()
    } else {
        ui.visuals().weak_text_color()
    };
    ui.painter().text(
        center,
        egui::Align2::CENTER_CENTER,
        glyph.codepoint,
        icons::font_id(CHEVRON_SIZE),
        color,
    );
}

/// Lays out a label pill's icon-and-name content (without the surrounding padding).
fn layout_pill(ui: &egui::Ui, icon: MaterialIcon, name: &str) -> Arc<egui::Galley> {
    let fg = LABEL_FG.get(ui.visuals());
    let mut job = LayoutJob::default();
    job.append(
        icon.codepoint,
        0.0,
        egui::TextFormat {
            font_id: icons::font_id(PILL_ICON_SIZE),
            color: fg,
            valign: egui::Align::Center,
            ..Default::default()
        },
    );
    job.append(
        name,
        PILL_ICON_GAP,
        egui::TextFormat {
            font_id: egui::FontId::proportional(PILL_TEXT_SIZE),
            color: fg,
            valign: egui::Align::Center,
            ..Default::default()
        },
    );
    ui.painter().layout_job(job)
}

/// The full outer size of a label pill (content plus padding).
fn pill_size(galley: &Arc<egui::Galley>) -> egui::Vec2 {
    galley.size() + egui::vec2(PILL_PAD_X * 2.0, PILL_PAD_Y * 2.0)
}

/// Allocates and paints a pre-laid-out label pill: a rounded, colored rect with the
/// icon-and-name galley inside. The pill senses clicks (to focus its field) and,
/// when `focused`, is wrapped in a tight blue border. Returns its click response.
fn paint_pill(
    ui: &mut egui::Ui,
    galley: Arc<egui::Galley>,
    size: egui::Vec2,
    bg: Duo,
    focused: bool,
) -> egui::Response {
    let fg = LABEL_FG.get(ui.visuals());
    // `CLICK` (not `click()`) so the pill senses clicks without becoming
    // keyboard-focusable — form focus is app state, and a focused egui widget
    // would suppress the plain-arrow selection commands.
    let (rect, resp) = ui.allocate_exact_size(size, egui::Sense::CLICK);
    ui.painter()
        .rect_filled(rect, PILL_RADIUS, bg.get(ui.visuals()));
    ui.painter()
        .galley(rect.min + egui::vec2(PILL_PAD_X, PILL_PAD_Y), galley, fg);
    if focused {
        paint_focus_border(ui, rect);
    }
    resp
}

/// Draws the blue focus border tight around a field label's pill — hugging the pill
/// edge (drawn inside, so no gap shows between the pill and the border).
fn paint_focus_border(ui: &egui::Ui, rect: egui::Rect) {
    let color = ui.visuals().selection.stroke.color;
    ui.painter().rect_stroke(
        rect,
        PILL_RADIUS,
        egui::Stroke::new(FOCUS_BORDER_WIDTH, color),
        egui::StrokeKind::Inside,
    );
}

/// The static height of a field's value area (everything but a dynamic embedded
/// widget), used to size the row before drawing. `value_avail` is the width the
/// value has, needed to measure an embedded record's wrapped height. `edit` is the
/// active inline edit when it targets *this* field, so the row grows to fit the
/// input.
fn value_height(ui: &egui::Ui, kind: &FieldKind, value_avail: f32, edit: Option<&FormEdit>) -> f32 {
    if let (FieldKind::Primitive { ty, .. }, Some(edit)) = (kind, edit) {
        return edit_input_height(ui, *ty, &edit.buffer);
    }
    match kind {
        // A loaded scalar link shows an embedded widget whose height depends on how
        // its content wraps; everything else is a fixed-height affordance.
        FieldKind::ScalarLink {
            id: Some(_),
            embedded: Load::Ready(d),
            ..
        } => embed_size(ui, &d.columns, value_avail).y,
        FieldKind::ScalarLink {
            id: Some(_),
            embedded: Load::Loading(_) | Load::Idle,
            ..
        } => skeleton_height(ui),
        // A NULL link and a NULL primitive both show the pencil button; a
        // multi-record field shows the count badge and "+" button.
        FieldKind::ScalarLink { .. }
        | FieldKind::Primitive { value: None, .. }
        | FieldKind::MultiRecord { .. } => crate::button::SIZE,
        FieldKind::Primitive {
            ty: Primitive::Id, ..
        } => embed_line_height_for(ui, UUID_TEXT_SIZE),
        FieldKind::Primitive { .. } => embed_line_height_for(ui, VALUE_TEXT_SIZE),
    }
}

/// Draws a field's value area to the right of its label, and wires the value-area
/// interactions (click-to-edit, the value context menu, the pencil/"+" buttons).
/// `path`/`sc` let a scalar-link's embedded record participate in selection.
fn draw_value(
    ui: &mut egui::Ui,
    ctx: Option<&mut FormCtx>,
    field: &mut FormField,
    path: &[FormStep],
    sc: &mut SelCtx,
) {
    // An activated primitive replaces its value display with the edit input.
    if sc.editing_at(path) && matches!(field.kind, FieldKind::Primitive { .. }) {
        draw_primitive_edit(ui, field, path, sc);
        return;
    }
    match &mut field.kind {
        FieldKind::Primitive {
            ty: Primitive::Id,
            value: Some(v),
            ..
        } => {
            let v = v.clone();
            let resp = draw_primitive_value(
                ui,
                &v,
                egui::FontId::monospace(UUID_TEXT_SIZE),
                ui.visuals().weak_text_color(),
            );
            primitive_value_interactions(path, &v, &resp, sc);
        }
        FieldKind::Primitive { value: Some(v), .. } => {
            let v = v.clone();
            let resp = draw_primitive_value(
                ui,
                &v,
                egui::FontId::proportional(VALUE_TEXT_SIZE),
                ui.visuals().text_color(),
            );
            primitive_value_interactions(path, &v, &resp, sc);
        }
        FieldKind::Primitive { value: None, .. } => {
            // A NULL/empty primitive shows a pencil that activates an empty input.
            if Button::icon(icons::EDIT).show(ui).clicked() {
                sc.out.activate = Some(FormEdit {
                    path: path.to_vec(),
                    buffer: String::new(),
                    focus: true,
                });
            }
        }
        FieldKind::ScalarLink {
            target,
            id,
            embedded,
            expanded,
            ..
        } => draw_scalar_link(
            ui,
            ctx,
            target,
            id.as_deref(),
            embedded,
            expanded.is_some(),
            path,
            sc,
        ),
        FieldKind::MultiRecord { count, entries, .. } => {
            let display = multi_display_count(*count, entries);
            if draw_count(ui, display).clicked() {
                sc.out.new_record = Some(path.to_vec());
            }
        }
    }
}

/// Renders the inline edit input for the activated primitive `field`, handling the
/// commit/cancel/advance keys and writing the committed value straight into the
/// field. Clears the active edit (and records the follow-up selection) on exit.
fn draw_primitive_edit(
    ui: &mut egui::Ui,
    field: &mut FormField,
    path: &[FormStep],
    sc: &mut SelCtx,
) {
    let FieldKind::Primitive { ty, .. } = field.kind else {
        return;
    };
    let avail = ui.available_width().max(40.0);
    let Some(edit) = sc.editing.as_mut() else {
        return;
    };
    match edit_input(ui, ty, edit, avail) {
        EditAction::Stay => {}
        EditAction::Commit => {
            commit_primitive(field, &sc.editing.take().unwrap().buffer);
            sc.out.select = Some(path.to_vec());
        }
        EditAction::Advance => {
            commit_primitive(field, &sc.editing.take().unwrap().buffer);
            sc.out.tab_advance = Some(path.to_vec());
        }
        EditAction::Cancel => {
            *sc.editing = None;
            sc.out.select = Some(path.to_vec());
        }
    }
}

/// Draws a scalar-linked field's value: the pencil affordance when `NULL`,
/// otherwise the embedded-record widget (a skeleton while its preview loads).
/// Dispatches the preview query once the id is known. Clicking the embedded record
/// selects the field, double-clicking toggles its expansion, and its context menu
/// clears the link.
#[allow(clippy::too_many_arguments)]
fn draw_scalar_link(
    ui: &mut egui::Ui,
    ctx: Option<&mut FormCtx>,
    target: &str,
    id: Option<&str>,
    embedded: &mut Load<RecordDisplay>,
    entering_new: bool,
    path: &[FormStep],
    sc: &mut SelCtx,
) {
    let Some(id) = id else {
        if entering_new {
            // A brand-new record is being entered: show the "New" embedded widget
            // (a real preview can't be pieced together from unsaved values), which
            // focuses its field, toggles expansion on double-click, and clears via its
            // menu. A scalar link's focus reads on its label, so the widget isn't
            // itself filled blue.
            let widget = draw_new_embedded(ui, false);
            sc.click(path, &widget);
            if widget.double_clicked() {
                sc.out.toggle_expand = Some(path.to_vec());
            }
            if embedded_context_menu(&widget, |ui| {
                crate::now_playing::menu_item(ui, icons::CLEAR, "Clear", true, None).clicked()
            }) {
                sc.out.clear = Some(path.to_vec());
            }
            return;
        }
        // A NULL link shows the pencil affordance, which opens the modal record
        // picker to choose an existing record.
        if Button::icon(icons::EDIT).show(ui).clicked() {
            sc.out.pick_record = Some(path.to_vec());
        }
        return;
    };
    if embedded.is_idle()
        && let Some(ctx) = ctx
    {
        *embedded = Load::Loading(ctx.load_embedded(target, id));
    }
    match embedded {
        Load::Ready(d) => {
            let cells = d.rows.row_values(0);
            // A scalar link's focus reads on its label, so the embedded preview isn't
            // itself filled blue.
            let widget = draw_embedded(ui, &d.columns, &cells, false);
            sc.click(path, &widget);
            if widget.double_clicked() {
                sc.out.toggle_expand = Some(path.to_vec());
            }
            if embedded_context_menu(&widget, |ui| {
                crate::now_playing::menu_item(ui, icons::CLEAR, "Clear", true, None).clicked()
            }) {
                sc.out.clear = Some(path.to_vec());
            }
        }
        Load::Failed(e) => {
            ui.colored_label(egui::Color32::RED, e.as_str());
        }
        Load::Loading(_) | Load::Idle => {
            let rect = draw_skeleton(ui);
            paint_overlay(ui, rect);
        }
    }
}

/// Draws a primitive field value as truncated text, returning a click-sensing
/// response (showing an I-beam on hover to cue that it's editable).
fn draw_primitive_value(
    ui: &mut egui::Ui,
    text: &str,
    font: egui::FontId,
    color: egui::Color32,
) -> egui::Response {
    let avail = ui.available_width().max(0.0);
    let mut job = LayoutJob::single_section(
        text.to_owned(),
        egui::TextFormat {
            font_id: font,
            color,
            ..Default::default()
        },
    );
    job.wrap = TextWrapping::truncate_at_width(avail);
    let galley = ui.painter().layout_job(job);
    // Give the click target a little height so a short value is still comfortably
    // clickable, and reserve the row's full remaining width.
    let size = egui::vec2(avail, galley.size().y.max(embed_line_height(ui)));
    let (rect, resp) = ui.allocate_exact_size(size, egui::Sense::CLICK);
    let y = rect.top() + (rect.height() - galley.size().y) * 0.5;
    ui.painter()
        .galley(egui::pos2(rect.left(), y), galley, color);
    if resp.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::Text);
    }
    resp
}

/// Wires a primitive value's display-mode interactions: single click enters edit
/// mode, and the context menu offers Edit / Clear / Copy.
fn primitive_value_interactions(
    path: &[FormStep],
    value: &str,
    resp: &egui::Response,
    sc: &mut SelCtx,
) {
    if resp.clicked() {
        sc.out.activate = Some(FormEdit {
            path: path.to_vec(),
            buffer: value.to_owned(),
            focus: true,
        });
    }
    primitive_context_menu(path, value, resp, sc);
}

/// Draws a multi-record field's value: a rounded count badge followed by the
/// "add record" button. Returns the add button's response.
fn draw_count(ui: &mut egui::Ui, count: usize) -> egui::Response {
    let text = ui.painter().layout_no_wrap(
        count.to_string(),
        egui::FontId::proportional(COUNT_TEXT_SIZE),
        ui.visuals().text_color(),
    );
    let size = egui::vec2(text.size().x.max(text.size().y) + 10.0, text.size().y + 4.0);
    let (rect, _) = ui.allocate_exact_size(size, egui::Sense::hover());
    ui.painter()
        .rect_filled(rect, size.y * 0.5, COUNT_BG.get(ui.visuals()));
    let pos = rect.center() - text.size() * 0.5;
    ui.painter().galley(pos, text, ui.visuals().text_color());

    ui.add_space(4.0);
    Button::icon(icons::ADD).show(ui)
}

// --- Rendering: interactions & inline editing ------------------------------

/// Paints the red "modified" star as a superscript at the top-left of a field
/// label's pill, mirroring the query tab's unsaved marker.
fn paint_modified_star(ui: &egui::Ui, pill_rect: egui::Rect) {
    ui.painter().text(
        egui::pos2(pill_rect.left() + 1.0, pill_rect.top() + 1.0),
        egui::Align2::CENTER_CENTER,
        icons::UNSAVED.codepoint,
        icons::font_id(crate::page::UNSAVED_MARKER_SIZE),
        crate::page::UNSAVED_RED.get(ui.visuals()),
    );
}

/// Wires a field label's click/double-click and context menu. Single click
/// selects; double click enters edit mode (primitive) or toggles expansion
/// (collapsible). The context menu varies by field kind.
fn label_interactions(
    ui: &egui::Ui,
    field: &mut FormField,
    path: &[FormStep],
    resp: &egui::Response,
    sc: &mut SelCtx,
) {
    let expandable = field.kind.is_expandable();
    let prim_value = match &field.kind {
        FieldKind::Primitive { value, .. } => Some(value.clone().unwrap_or_default()),
        _ => None,
    };
    if resp.double_clicked() {
        if let Some(buffer) = prim_value.clone() {
            sc.out.activate = Some(FormEdit {
                path: path.to_vec(),
                buffer,
                focus: true,
            });
        } else if expandable {
            field.collapsed = !field.collapsed;
        }
    } else if resp.clicked() {
        let mods = ui.input(|i| i.modifiers);
        sc.out.clicked = Some((path.to_vec(), mods));
    }
    match &field.kind {
        FieldKind::Primitive { .. } => {
            primitive_context_menu(path, prim_value.as_deref().unwrap_or(""), resp, sc);
        }
        FieldKind::ScalarLink { .. } => scalar_label_menu(path, resp, sc),
        FieldKind::MultiRecord { .. } => multi_label_menu(path, resp, sc),
    }
}

/// The Edit / Clear / Copy context menu for a primitive field's label or value.
fn primitive_context_menu(path: &[FormStep], value: &str, resp: &egui::Response, sc: &mut SelCtx) {
    egui::Popup::context_menu(resp).show(|ui| {
        ui.set_width(150.0);
        if crate::now_playing::menu_item(ui, icons::EDIT, "Edit", true, None).clicked() {
            sc.out.activate = Some(FormEdit {
                path: path.to_vec(),
                buffer: value.to_owned(),
                focus: true,
            });
        }
        if crate::now_playing::menu_item(ui, icons::CLEAR, "Clear", true, None).clicked() {
            sc.out.clear = Some(path.to_vec());
        }
        if crate::now_playing::menu_item(ui, icons::DUPLICATE, "Copy", true, None).clicked() {
            ui.ctx().copy_text(value.to_owned());
        }
    });
}

/// The context menu for a scalar-linked field's label: pick an existing record
/// (opens the modal picker), enter a brand-new record, or clear the link.
fn scalar_label_menu(path: &[FormStep], resp: &egui::Response, sc: &mut SelCtx) {
    egui::Popup::context_menu(resp).show(|ui| {
        ui.set_width(170.0);
        if crate::now_playing::menu_item(ui, icons::TABLE, "Pick a record", true, None).clicked() {
            sc.out.pick_record = Some(path.to_vec());
        }
        if crate::now_playing::menu_item(ui, icons::ADD, "Enter a new record", true, None).clicked()
        {
            sc.out.new_linked_record = Some(path.to_vec());
        }
        if crate::now_playing::menu_item(ui, icons::CLEAR, "Clear", true, None).clicked() {
            sc.out.clear = Some(path.to_vec());
        }
    });
}

/// The New record / Delete all records context menu for a multi-record field's
/// label.
fn multi_label_menu(path: &[FormStep], resp: &egui::Response, sc: &mut SelCtx) {
    egui::Popup::context_menu(resp).show(|ui| {
        ui.set_width(170.0);
        if crate::now_playing::menu_item(ui, icons::ADD, "New record", true, None).clicked() {
            sc.out.new_record = Some(path.to_vec());
        }
        let red = crate::page::DELETE_RED.get(ui.visuals());
        if crate::now_playing::menu_item(ui, icons::DELETE, "Delete all records", true, Some(red))
            .clicked()
        {
            sc.out.clear = Some(path.to_vec());
        }
    });
}

/// Shows a one-item context menu on an embedded-record widget, returning whether
/// its item (built by `body`, which reports its own click) was chosen.
fn embedded_context_menu(
    widget: &egui::Response,
    body: impl FnOnce(&mut egui::Ui) -> bool,
) -> bool {
    egui::Popup::context_menu(widget)
        .show(|ui| {
            ui.set_width(150.0);
            body(ui)
        })
        .is_some_and(|m| m.inner)
}

/// The outcome of a frame of inline field editing.
enum EditAction {
    /// Still editing.
    Stay,
    /// Exit and save the field (Esc on a valid value, Enter on a number, or focus
    /// lost).
    Commit,
    /// Save and move selection to the next field (Tab).
    Advance,
    /// Exit without saving (Esc on an unparseable value).
    Cancel,
}

/// Renders the activated field's text input (multiline for text, single-line for a
/// number) and interprets the edit keys. An unparseable value gets a red border and
/// blocks Tab/Enter commits until it's fixed or cancelled with Esc.
fn edit_input(ui: &mut egui::Ui, ty: Primitive, edit: &mut FormEdit, avail: f32) -> EditAction {
    let id = egui::Id::new("record_editor_active_edit");
    let multiline = ty != Primitive::Number;
    let widget = if multiline {
        let rows = edit.buffer.lines().count().max(1);
        egui::TextEdit::multiline(&mut edit.buffer)
            .id(id)
            .desired_width(avail)
            .desired_rows(rows)
    } else {
        egui::TextEdit::singleline(&mut edit.buffer)
            .id(id)
            .desired_width(avail)
    };
    let mut output = crate::text_input::show(ui, widget);

    if edit.focus {
        output.response.request_focus();
        let end = edit.buffer.chars().count();
        output
            .state
            .cursor
            .set_char_range(Some(egui::text::CCursorRange::two(
                egui::text::CCursor::new(0),
                egui::text::CCursor::new(end),
            )));
        output.state.store(ui.ctx(), id);
        edit.focus = false;
    }

    let valid = edit_valid(ty, &edit.buffer);
    if !valid {
        ui.painter().rect_stroke(
            output.response.rect,
            4.0,
            egui::Stroke::new(1.0, crate::page::DELETE_RED.get(ui.visuals())),
            egui::StrokeKind::Inside,
        );
    }

    let has_focus = output.response.has_focus();
    // Esc: exit; commit a valid value, discard an invalid one.
    if has_focus && ui.input(|i| i.key_pressed(egui::Key::Escape)) {
        ui.memory_mut(|m| m.surrender_focus(id));
        return if valid {
            EditAction::Commit
        } else {
            EditAction::Cancel
        };
    }
    // Tab: advance to the next field, but only once the value parses.
    if has_focus && ui.input_mut(|i| i.consume_key(egui::Modifiers::NONE, egui::Key::Tab)) && valid
    {
        ui.memory_mut(|m| m.surrender_focus(id));
        return EditAction::Advance;
    }
    // Focus lost some other way (Enter on a single-line number, or a click away):
    // commit if valid, otherwise revert.
    if output.response.lost_focus() {
        return if valid {
            EditAction::Commit
        } else {
            EditAction::Cancel
        };
    }
    EditAction::Stay
}

/// Whether `buffer` parses to the field's storage type. An empty value is `NULL`
/// (always valid); a number field requires a parseable number; text/id accept any
/// string.
fn edit_valid(ty: Primitive, buffer: &str) -> bool {
    let t = buffer.trim();
    if t.is_empty() {
        return true;
    }
    match ty {
        Primitive::Number => t.parse::<f64>().is_ok(),
        Primitive::Text | Primitive::Id => true,
    }
}

/// Writes an edit buffer into a primitive field: an all-whitespace buffer becomes
/// `NULL`, otherwise the value is stored as typed.
fn commit_primitive(field: &mut FormField, buffer: &str) {
    if let FieldKind::Primitive { value, .. } = &mut field.kind {
        *value = if buffer.trim().is_empty() {
            None
        } else {
            Some(buffer.to_owned())
        };
    }
}

/// The height the inline edit input occupies for `buffer`: one line for a number,
/// or one line per text line, plus the input's vertical padding.
fn edit_input_height(ui: &egui::Ui, ty: Primitive, buffer: &str) -> f32 {
    let rows = if ty == Primitive::Number {
        1
    } else {
        buffer.lines().count().max(1)
    };
    let line = ui.text_style_height(&egui::TextStyle::Body);
    rows as f32 * line + 8.0
}

// --- Rendering: embedded records -------------------------------------------

/// The corner radius of an embedded-record widget: half the height of a
/// single-line widget, so a one-line record has semicircular ends. Kept static, so
/// a record that wraps to multiple lines grows taller and gains flat sides.
fn embed_radius(ui: &egui::Ui) -> f32 {
    skeleton_height(ui) * 0.5
}

/// The height of a single-line embedded-record widget (one text line plus padding).
fn skeleton_height(ui: &egui::Ui) -> f32 {
    embed_line_height(ui) + EMBED_PAD_Y * 2.0
}

/// The layout of an embedded record within `avail` width: the visible columns and
/// their field layout, plus the resulting widget size.
struct EmbedLayout<'a> {
    visible: Vec<(usize, &'a ColumnMetadata)>,
    layout: crate::field_layout::FieldLayout,
    line_h: f32,
    size: egui::Vec2,
}

/// Computes an embedded record's layout (and outer size) for the given columns and
/// available width, mirroring the query result-row field layout.
fn embed_layout<'a>(ui: &egui::Ui, columns: &'a [ColumnMetadata], avail: f32) -> EmbedLayout<'a> {
    let width = avail.max(embed_radius(ui) * 2.0);
    let content_w = (width - EMBED_PAD_X * 2.0).max(0.0);
    let visible: Vec<(usize, &ColumnMetadata)> = columns
        .iter()
        .enumerate()
        .filter(|(_, m)| !m.hide)
        .collect();
    let col_sizes: Vec<ColSize> = visible
        .iter()
        .map(|(_, m)| ColSize {
            min: m.min_width,
            max: m.max_width,
        })
        .collect();
    let layout = compute_field_layout(&col_sizes, content_w, EMBED_COL_GAP);
    let line_h = embed_line_height(ui);
    let widget_h = line_h * layout.line_count.max(1) as f32 + EMBED_PAD_Y * 2.0;
    EmbedLayout {
        visible,
        layout,
        line_h,
        size: egui::vec2(width, widget_h),
    }
}

/// The outer size of the embedded record for `columns` within `avail` width.
fn embed_size(ui: &egui::Ui, columns: &[ColumnMetadata], avail: f32) -> egui::Vec2 {
    embed_layout(ui, columns, avail).size
}

/// Returns `color` with its alpha channel replaced by `alpha`.
fn translucent(color: egui::Color32, alpha: u8) -> egui::Color32 {
    egui::Color32::from_rgba_unmultiplied(color.r(), color.g(), color.b(), alpha)
}

/// Paints an embedded-record widget's rounded surface (fill + faint border). By
/// default it's the same top-lit gradient (hover-shaded) as a query result row;
/// when `selected` it's the flat blue selection fill with the sheen layered on top
/// at reduced opacity — matching a selected query result row.
fn paint_embed_surface(
    ui: &egui::Ui,
    rect: egui::Rect,
    radius: f32,
    selected: bool,
    hovered: bool,
) {
    if selected {
        let v = ui.visuals();
        let base = if hovered {
            theme::shade(v, crate::results::SELECTED_ROW_BG.get(v), 20)
        } else {
            crate::results::SELECTED_ROW_BG.get(v)
        };
        paint_rounded_gradient(ui.painter(), rect, radius, base, base);
        let (top, bottom) = embed_gradient(ui, hovered);
        paint_rounded_gradient(
            ui.painter(),
            rect,
            radius,
            translucent(top, crate::results::SELECTED_ROW_GRADIENT_ALPHA),
            translucent(bottom, crate::results::SELECTED_ROW_GRADIENT_ALPHA),
        );
    } else {
        let (top, bottom) = embed_gradient(ui, hovered);
        paint_rounded_gradient(ui.painter(), rect, radius, top, bottom);
    }
    ui.painter().rect_stroke(
        rect,
        radius,
        egui::Stroke::new(1.0, EMBED_BORDER.get(ui.visuals())),
        egui::StrokeKind::Inside,
    );
}

/// Draws an embedded-record widget filling the remaining row width: a rounded rect
/// with the same top-lit gradient (and hover shading) as a query result row, a
/// faint border, and fields rendered like a result row but forced to small, light
/// text. When `selected`, the fill is the same blue as a selected query result row.
/// Returns the widget's [`egui::Response`] (for double-click to expand).
fn draw_embedded(
    ui: &mut egui::Ui,
    columns: &[ColumnMetadata],
    cells: &[CellValue],
    selected: bool,
) -> egui::Response {
    let el = embed_layout(ui, columns, ui.available_width());
    let radius = embed_radius(ui);

    let (rect, resp) = ui.allocate_exact_size(el.size, egui::Sense::CLICK);
    paint_embed_surface(ui, rect, radius, selected, resp.hovered());

    let color = ui.visuals().weak_text_color();
    let font = egui::FontId::proportional(EMBED_TEXT_SIZE);
    for (vis_idx, (col_idx, meta)) in el.visible.iter().enumerate() {
        let p = el.layout.placements[vis_idx];
        let cell_left = rect.left() + EMBED_PAD_X + p.x;
        let line_top = rect.top() + EMBED_PAD_Y + el.line_h * p.line as f32;
        let width = p.width.max(0.0);
        let value = match cells.get(*col_idx) {
            Some(CellValue::Single(s)) => s.clone(),
            Some(CellValue::List(items)) => items.join(", "),
            None => String::new(),
        };
        if value.is_empty() {
            continue;
        }
        let text = display_text(meta, &value);
        let mut job = LayoutJob::single_section(
            text,
            egui::TextFormat {
                font_id: font.clone(),
                color,
                ..Default::default()
            },
        );
        job.wrap = TextWrapping::truncate_at_width(width);
        let galley = ui.painter().layout_job(job);
        let y = line_top + (el.line_h - galley.size().y) * 0.5;
        ui.painter().galley(egui::pos2(cell_left, y), galley, color);
    }
    resp
}

/// Draws the embedded-record widget for a brand-new record being added: the same
/// bordered, rounded surface as a loaded record, but with "New" centered in
/// italics (we can't piece a real preview together from unsaved field values).
/// Returns the widget's response (for click/double-click to select/expand).
fn draw_new_embedded(ui: &mut egui::Ui, selected: bool) -> egui::Response {
    let avail = ui.available_width().max(embed_radius(ui) * 2.0);
    let radius = embed_radius(ui);
    let (rect, resp) =
        ui.allocate_exact_size(egui::vec2(avail, skeleton_height(ui)), egui::Sense::CLICK);
    paint_embed_surface(ui, rect, radius, selected, resp.hovered());
    let mut job = LayoutJob::single_section(
        "New".to_owned(),
        egui::TextFormat {
            font_id: egui::FontId::proportional(EMBED_TEXT_SIZE),
            color: ui.visuals().weak_text_color(),
            italics: true,
            ..Default::default()
        },
    );
    job.halign = egui::Align::Center;
    let galley = ui.painter().layout_job(job);
    let pos = egui::pos2(rect.center().x, rect.center().y - galley.size().y * 0.5);
    ui.painter()
        .galley(pos, galley, ui.visuals().weak_text_color());
    resp
}

/// Renders one modal-picker result as an embedded-record widget, filled blue when
/// `selected`. Reuses the same widget as scalar-link and multi-record previews so
/// picker rows read identically to embedded records elsewhere. Returns the widget's
/// click response.
pub(crate) fn render_picker_result(
    ui: &mut egui::Ui,
    columns: &[ColumnMetadata],
    cells: &[CellValue],
    selected: bool,
) -> egui::Response {
    draw_embedded(ui, columns, cells, selected)
}

/// Draws a not-yet-loaded embedded record as an empty skeleton widget filling the
/// remaining row width. Returns its rect (for the loading overlay).
fn draw_skeleton(ui: &mut egui::Ui) -> egui::Rect {
    let avail = ui.available_width().max(embed_radius(ui) * 2.0);
    let radius = embed_radius(ui);
    let (rect, _) =
        ui.allocate_exact_size(egui::vec2(avail, skeleton_height(ui)), egui::Sense::hover());
    ui.painter()
        .rect_filled(rect, radius, SKELETON_FILL.get(ui.visuals()));
    ui.painter().rect_stroke(
        rect,
        radius,
        egui::Stroke::new(1.0, EMBED_BORDER.get(ui.visuals())),
        egui::StrokeKind::Inside,
    );
    rect
}

/// The top/bottom colors of an embedded record's background gradient — the same
/// top-lit gradient as a query result row, nudged on hover to match.
fn embed_gradient(ui: &egui::Ui, hovered: bool) -> (egui::Color32, egui::Color32) {
    let v = ui.visuals();
    let (top, bottom) = (
        crate::results::ROW_BG_TOP.get(v),
        crate::results::ROW_BG_BOTTOM.get(v),
    );
    if hovered {
        (
            theme::shade(v, top, theme::HOVER_SHADE),
            theme::shade(v, bottom, theme::HOVER_SHADE),
        )
    } else {
        (top, bottom)
    }
}

/// The height of one line of embedded-record text.
fn embed_line_height(ui: &egui::Ui) -> f32 {
    embed_line_height_for(ui, EMBED_TEXT_SIZE)
}

/// The height of one line of proportional text at `size`, from a sample galley.
fn embed_line_height_for(ui: &egui::Ui, size: f32) -> f32 {
    ui.painter()
        .layout_no_wrap(
            "Xg".to_owned(),
            egui::FontId::proportional(size),
            egui::Color32::PLACEHOLDER,
        )
        .size()
        .y
}

/// Paints a vertical `top`→`bottom` gradient clipped to a rounded rect, so the
/// embedded record's gradient fill respects its rounded (semicircular) corners.
/// The rounded rect is convex, so it triangulates cleanly as a fan from its center.
fn paint_rounded_gradient(
    painter: &egui::Painter,
    rect: egui::Rect,
    radius: f32,
    top: egui::Color32,
    bottom: egui::Color32,
) {
    use std::f32::consts::{FRAC_PI_2, PI};

    /// Line segments used to approximate each rounded corner's quarter-arc.
    const SEG: usize = 6;

    let r = radius
        .min(rect.width() * 0.5)
        .min(rect.height() * 0.5)
        .max(0.0);
    let color_at = |y: f32| {
        let t = if rect.height() > 0.0 {
            ((y - rect.top()) / rect.height()).clamp(0.0, 1.0)
        } else {
            0.0
        };
        lerp_color(top, bottom, t)
    };

    // Perimeter points, clockwise from the top edge, rounding each corner.
    let arc = |center: egui::Pos2, start: f32, pts: &mut Vec<egui::Pos2>| {
        for i in 0..=SEG {
            let a = start + (i as f32 / SEG as f32) * FRAC_PI_2;
            pts.push(egui::pos2(center.x + r * a.cos(), center.y + r * a.sin()));
        }
    };
    let mut pts: Vec<egui::Pos2> = Vec::with_capacity((SEG + 1) * 4);
    arc(
        egui::pos2(rect.right() - r, rect.top() + r),
        -FRAC_PI_2,
        &mut pts,
    ); // top-right
    arc(
        egui::pos2(rect.right() - r, rect.bottom() - r),
        0.0,
        &mut pts,
    ); // bottom-right
    arc(
        egui::pos2(rect.left() + r, rect.bottom() - r),
        FRAC_PI_2,
        &mut pts,
    ); // bottom-left
    arc(egui::pos2(rect.left() + r, rect.top() + r), PI, &mut pts); // top-left

    let mut mesh = egui::Mesh::default();
    mesh.colored_vertex(rect.center(), color_at(rect.center().y));
    for p in &pts {
        mesh.colored_vertex(*p, color_at(p.y));
    }
    let n = pts.len() as u32;
    for i in 0..n {
        mesh.add_triangle(0, 1 + i, 1 + (i + 1) % n);
    }
    painter.add(mesh);
}

/// Linearly interpolates between two colors, per channel.
fn lerp_color(a: egui::Color32, b: egui::Color32, t: f32) -> egui::Color32 {
    let c = |x: u8, y: u8| (f32::from(x) + (f32::from(y) - f32::from(x)) * t).round() as u8;
    egui::Color32::from_rgba_unmultiplied(
        c(a.r(), b.r()),
        c(a.g(), b.g()),
        c(a.b(), b.b()),
        c(a.a(), b.a()),
    )
}

/// Paints the subtle loading overlay — a translucent wash in the panel color —
/// over `rect`, dimming whatever's beneath.
fn paint_overlay(ui: &egui::Ui, rect: egui::Rect) {
    let fill = ui.visuals().panel_fill;
    let wash = egui::Color32::from_rgba_unmultiplied(fill.r(), fill.g(), fill.b(), 150);
    ui.painter().rect_filled(rect, 0.0, wash);
}

/// Applies a column's formatter and prefix/suffix to one raw cell value. Mirrors
/// the result-row logic so embedded records format identically.
fn display_text(meta: &ColumnMetadata, value: &str) -> String {
    let formatted = match &meta.formatter {
        Some(f) => f.format(value).unwrap_or_else(|| value.to_string()),
        None => value.to_string(),
    };
    if meta.prefix.is_empty() && meta.suffix.is_empty() {
        formatted
    } else {
        format!("{}{}{}", meta.prefix, formatted, meta.suffix)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
        "tables": [
            { "name": "track", "unique_constraints": [["id"]], "columns": [
                { "name": "id", "type": "UUID", "nullable": false },
                { "name": "title", "type": "VARCHAR", "nullable": true },
                { "name": "album", "type": "UUID", "nullable": true },
                { "name": "track_number", "type": "INTEGER", "nullable": true }
            ] },
            { "name": "album", "unique_constraints": [["id"]], "columns": [
                { "name": "id", "type": "UUID", "nullable": false }
            ] },
            { "name": "credit", "unique_constraints": [["track", "artist"]], "columns": [
                { "name": "track", "type": "UUID", "nullable": false },
                { "name": "artist", "type": "UUID", "nullable": false }
            ] },
            { "name": "play", "unique_constraints": [["id"]], "columns": [
                { "name": "id", "type": "UUID", "nullable": false },
                { "name": "track", "type": "UUID", "nullable": false }
            ] }
        ],
        "links": []
    }"#;

    fn schema() -> Schema {
        Schema::parse(SAMPLE).unwrap()
    }

    #[test]
    fn structure_orders_columns_then_referencing_tables() {
        let form = RecordEditor::structure(&schema(), "track").unwrap();
        let names: Vec<&str> = form.fields.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(
            names,
            ["id", "title", "album", "track_number", "credit", "play"]
        );
    }

    #[test]
    fn structure_classifies_field_kinds() {
        let form = RecordEditor::structure(&schema(), "track").unwrap();
        let kind = |name: &str| &form.fields.iter().find(|f| f.name == name).unwrap().kind;
        assert!(matches!(
            kind("id"),
            FieldKind::Primitive {
                ty: Primitive::Id,
                ..
            }
        ));
        assert!(matches!(
            kind("track_number"),
            FieldKind::Primitive {
                ty: Primitive::Number,
                ..
            }
        ));
        assert!(matches!(
            kind("album"),
            FieldKind::ScalarLink { target, .. } if target == "album"
        ));
        assert!(matches!(
            kind("credit"),
            FieldKind::MultiRecord { link_column, .. } if link_column == "track"
        ));
    }

    #[test]
    fn structure_returns_none_for_unknown_table() {
        assert!(RecordEditor::structure(&schema(), "nonexistent").is_none());
    }

    #[test]
    fn without_column_hides_the_contextual_filter_field() {
        // A credit listed under its track hides the `track` field (the contextual
        // filter), keeping the rest.
        let form = RecordEditor::structure(&schema(), "credit")
            .unwrap()
            .without_column("track");
        let names: Vec<&str> = form.fields.iter().map(|f| f.name.as_str()).collect();
        assert!(
            !names.contains(&"track"),
            "track should be hidden: {names:?}"
        );
        assert!(names.contains(&"artist"));
    }

    #[test]
    fn primary_key_prefers_id_and_skips_composite_keys() {
        let s = schema();
        assert_eq!(primary_key(s.table("track").unwrap()), Some("id"));
        assert_eq!(primary_key(s.table("credit").unwrap()), None);
    }

    #[test]
    fn identifying_columns_use_composite_key_when_no_single_id() {
        let s = schema();
        assert_eq!(identifying_columns(s.table("track").unwrap()), ["id"]);
        assert_eq!(
            identifying_columns(s.table("credit").unwrap()),
            ["track", "artist"]
        );
    }

    #[test]
    fn with_key_seeds_primitive_field_values() {
        let form = RecordEditor::structure(&schema(), "track")
            .unwrap()
            .with_key(vec![("id".to_owned(), "abc".to_owned())]);
        assert_eq!(form.record_id(), Some("abc"));
        let id_field = form.fields.iter().find(|f| f.name == "id").unwrap();
        assert!(matches!(
            &id_field.kind,
            FieldKind::Primitive { value: Some(v), .. } if v == "abc"
        ));
    }

    #[test]
    fn numeric_type_detection_covers_parameterized_decimals() {
        assert!(is_numeric_type("DECIMAL(18,3)"));
        assert!(is_numeric_type("bigint"));
        assert!(!is_numeric_type("VARCHAR"));
        assert!(!is_numeric_type("UUID"));
    }

    #[test]
    fn values_query_compiles_to_sql() {
        // The generated values query must compile: filter by id, select each
        // column value and a count per referencing table.
        let form = RecordEditor::structure(&schema(), "track")
            .unwrap()
            .with_key(vec![("id".to_owned(), "abc-123".to_owned())]);
        let source = values_source(&form);
        // The compiler needs the convention-inferred links (which the app adds to
        // the stored schema) to resolve the referencing-table counts.
        let enriched = introspection::add_inferred_links(SAMPLE).unwrap();
        let compiled =
            compile::querydown_to_duckdb(&source, &enriched).expect("values query should compile");
        // One result column per field (4 columns + credit + play = 6).
        assert_eq!(compiled.columns.len(), 6);
        assert!(compiled.sql.to_lowercase().contains("select"));
    }

    #[test]
    fn key_filter_escapes_and_quotes() {
        let f = key_filter(&[("id".to_owned(), "a'b".to_owned())]);
        assert_eq!(f, "`id`:=='a\\'b'");
    }

    #[test]
    fn scalar_link_target_resolves_the_target_table() {
        let form = RecordEditor::structure(&schema(), "track").unwrap();
        let album_idx = form.fields.iter().position(|f| f.name == "album").unwrap();
        assert_eq!(
            form.scalar_link_target(&[FormStep::Field(album_idx)])
                .as_deref(),
            Some("album")
        );
        // A primitive field has no link target.
        let title_idx = form.fields.iter().position(|f| f.name == "title").unwrap();
        assert!(
            form.scalar_link_target(&[FormStep::Field(title_idx)])
                .is_none()
        );
    }

    #[test]
    fn add_new_linked_record_scaffolds_expanded_prefilled_editor() {
        // `credit.track` is a scalar link whose target (`track`) has an editable
        // `title` field to receive the prefill.
        let mut form = RecordEditor::structure(&schema(), "credit").unwrap();
        let track_idx = form.fields.iter().position(|f| f.name == "track").unwrap();
        form.add_new_linked_record(&[FormStep::Field(track_idx)], &schema(), "Bal".to_owned());

        let field = &form.fields[track_idx];
        // Scaffolding a new record is an unsaved change and makes the field expand.
        assert!(field.is_modified());
        assert!(field.kind.is_expandable());
        assert!(!field.collapsed);
        let FieldKind::ScalarLink { id, expanded, .. } = &field.kind else {
            panic!("track should stay a scalar link");
        };
        assert!(id.is_none(), "a new linked record has no id yet");
        let sub = expanded.as_ref().expect("nested editor scaffolded");
        // The first editable field (the track's title) is seeded with the prefill.
        let title = sub.fields.iter().find(|f| f.name == "title").unwrap();
        assert!(matches!(
            &title.kind,
            FieldKind::Primitive { value: Some(v), .. } if v == "Bal"
        ));
        // And it's activated for immediate typing.
        assert!(form.editing.is_some());
    }

    #[test]
    fn apply_picked_record_points_the_link_and_stashes_the_preview() {
        let mut form = RecordEditor::structure(&schema(), "track")
            .unwrap()
            .with_key(vec![("id".to_owned(), "t1".to_owned())]);
        let album_idx = form.fields.iter().position(|f| f.name == "album").unwrap();
        let display = RecordDisplay {
            columns: vec![ColumnMetadata::default()],
            rows: ResultRows::from_cells(&[vec![Some("The Balkan Club Night")]]),
        };
        form.apply_picked_record(
            &[FormStep::Field(album_idx)],
            Some("al-9".to_owned()),
            display,
        );

        let FieldKind::ScalarLink {
            id,
            embedded,
            expanded,
            ..
        } = &form.fields[album_idx].kind
        else {
            panic!("album should stay a scalar link");
        };
        assert_eq!(id.as_deref(), Some("al-9"));
        assert!(matches!(embedded, Load::Ready(_)), "preview stashed");
        assert!(expanded.is_none());
        // Pointing a previously-NULL link at a record is an unsaved change.
        assert!(form.fields[album_idx].is_modified());
    }
}

#[cfg(test)]
mod snapshot_tests {
    //! Headless snapshot tests for the record editor form, rendered in isolation
    //! (no app, no data loading) from a hand-built [`RecordEditor`] whose slots are
    //! pre-populated. Generate/refresh with `UPDATE_SNAPSHOTS=1 cargo test -p frontend`.

    use eframe::egui;

    use super::{
        FieldKind, FormEdit, FormField, FormSelection, FormStep, Load, MultiData, MultiEntry,
        Primitive, RecordDisplay, RecordEditor,
    };
    use crate::columns::ColumnMetadata;
    use crate::rows::ResultRows;
    use crate::snapshot_harness::{self, snapshot_dual};

    fn primitive(name: &str, ty: Primitive, value: &str) -> FormField {
        FormField {
            name: name.to_owned(),
            kind: FieldKind::Primitive {
                ty,
                value: Some(value.to_owned()),
                original: Some(value.to_owned()),
            },
            collapsed: true,
        }
    }

    fn text(name: &str, value: &str) -> FormField {
        primitive(name, Primitive::Text, value)
    }

    fn number(name: &str, value: &str) -> FormField {
        primitive(name, Primitive::Number, value)
    }

    fn id_field(name: &str, value: &str) -> FormField {
        primitive(name, Primitive::Id, value)
    }

    /// Marks a primitive field modified by giving it a differing original value, so
    /// its red modification star shows.
    fn with_original(mut field: FormField, original: Option<&str>) -> FormField {
        if let FieldKind::Primitive { original: o, .. } = &mut field.kind {
            *o = original.map(str::to_owned);
        }
        field
    }

    fn cols(n: usize) -> Vec<ColumnMetadata> {
        (0..n).map(|_| ColumnMetadata::default()).collect()
    }

    /// A collapsed scalar link with a loaded one-row preview.
    fn linked(name: &str, target: &str, preview: &[Option<&str>]) -> FormField {
        FormField {
            name: name.to_owned(),
            kind: FieldKind::ScalarLink {
                target: target.to_owned(),
                id: Some("x".to_owned()),
                original_id: Some("x".to_owned()),
                embedded: Load::Ready(RecordDisplay {
                    columns: cols(preview.len()),
                    rows: ResultRows::from_cells(&[preview.to_vec()]),
                }),
                expanded: None,
            },
            collapsed: true,
        }
    }

    /// A loaded (materialized) entry for a multi-record field.
    fn loaded_entry(
        row: usize,
        key: &[(&str, &str)],
        expanded: Option<RecordEditor>,
    ) -> MultiEntry {
        MultiEntry {
            key: key
                .iter()
                .map(|(c, v)| ((*c).into(), (*v).into()))
                .collect(),
            row: Some(row),
            is_new: false,
            collapsed: expanded.is_none(),
            expanded: expanded.map(Box::new),
            deleted: false,
        }
    }

    /// An expanded multi-record field named `name`, backed by loaded `data` and
    /// `entries`.
    fn multi(
        name: &str,
        count: usize,
        load: Load<MultiData>,
        entries: Vec<MultiEntry>,
    ) -> FormField {
        FormField {
            name: name.to_owned(),
            kind: FieldKind::MultiRecord {
                table: name.to_owned(),
                link_column: "track".to_owned(),
                parent_column: "id".to_owned(),
                count,
                original_count: count,
                load,
                entries,
            },
            collapsed: false,
        }
    }

    fn editor(base: &str, key: Vec<(String, String)>, fields: Vec<FormField>) -> RecordEditor {
        RecordEditor {
            base_table: base.to_owned(),
            key,
            values: Load::Ready(()),
            selection: None,
            editing: None,
            scroll_to_selection: false,
            fields,
        }
    }

    /// The rich scene: a track form with a loaded scalar link, and an expanded
    /// `credit` multi-record field whose middle record is itself expanded into a
    /// nested editor (a scalar link + primitives).
    fn nested_form() -> RecordEditor {
        // The nested editor for the expanded "Noha" credit record.
        let noha = editor(
            "credit",
            vec![
                ("track".to_owned(), "t".to_owned()),
                ("artist".to_owned(), "a2".to_owned()),
            ],
            vec![
                linked("artist", "artist", &[Some("Noha")]),
                text("role", "Remix by"),
                number("ord", "2"),
            ],
        );

        let credit_data = MultiData {
            columns: cols(4),
            // Columns: [track (key), artist (key), name, role].
            rows: ResultRows::from_cells(&[
                vec![Some("t"), Some("a1"), Some("Deladap"), None],
                vec![Some("t"), Some("a2"), Some("Noha"), Some("Remix by")],
                vec![Some("t"), Some("a3"), Some("17 Hippies"), Some("Featured")],
            ]),
            display_offset: 2,
        };
        let entries = vec![
            loaded_entry(0, &[("track", "t"), ("artist", "a1")], None),
            loaded_entry(1, &[("track", "t"), ("artist", "a2")], Some(noha)),
            loaded_entry(2, &[("track", "t"), ("artist", "a3")], None),
        ];

        editor(
            "track",
            vec![("id".to_owned(), "d289fa9e".to_owned())],
            vec![
                text("title", "Goldregen"),
                linked("album", "album", &[Some("The Balkan Club Night")]),
                multi("credit", 3, Load::Ready(credit_data), entries),
                id_field("id", "d289fa9e-8354-4e4b-9df3-5f8b64eb5304"),
            ],
        )
    }

    #[test]
    fn nested_records() {
        let mut form = nested_form();
        let mut harness = snapshot_harness::harness(egui::vec2(420.0, 420.0), move |ui| {
            form.show(ui);
        });
        harness.run();
        snapshot_dual(&mut harness, "record_editor/nested_records");
    }

    /// Loading states: an expanded multi-record field showing skeleton widgets under
    /// the dimming overlay, plus a scalar link whose preview is still loading.
    fn loading_form() -> RecordEditor {
        editor(
            "track",
            vec![("id".to_owned(), "d289fa9e".to_owned())],
            vec![
                text("title", "Goldregen"),
                FormField {
                    name: "album".to_owned(),
                    kind: FieldKind::ScalarLink {
                        target: "album".to_owned(),
                        id: Some("x".to_owned()),
                        original_id: Some("x".to_owned()),
                        embedded: Load::Loading(2),
                        expanded: None,
                    },
                    collapsed: true,
                },
                multi("credit", 3, Load::Loading(1), vec![]),
            ],
        )
    }

    #[test]
    fn loading_states() {
        let mut form = loading_form();
        let mut harness = snapshot_harness::harness(egui::vec2(420.0, 300.0), move |ui| {
            form.show(ui);
        });
        harness.run();
        snapshot_dual(&mut harness, "record_editor/loading_states");
    }

    /// A focused field label draws a tight blue border hugging its pill (here the
    /// nested `role` field within the expanded "Noha" credit record).
    #[test]
    fn focus_field_label() {
        let mut form = nested_form();
        // Path: credit (field 2) → Noha entry (1) → role (field 1).
        form.selection = Some(FormSelection::Single(vec![
            FormStep::Field(2),
            FormStep::Entry(1),
            FormStep::Field(1),
        ]));
        let mut harness = snapshot_harness::harness(egui::vec2(420.0, 420.0), move |ui| {
            form.show(ui);
        });
        harness.run();
        snapshot_dual(&mut harness, "record_editor/focus_field_label");
    }

    /// Multiple sibling embedded records selected within a multi-record field each
    /// take the same blue fill as a selected query result row (here the first and
    /// third `credit` records).
    #[test]
    fn selection_records() {
        let mut form = nested_form();
        form.selection = Some(FormSelection::Entries {
            parent: vec![FormStep::Field(2)],
            indices: [0, 2].into_iter().collect(),
            anchor: 0,
            lead: 2,
        });
        let mut harness = snapshot_harness::harness(egui::vec2(420.0, 420.0), move |ui| {
            form.show(ui);
        });
        harness.run();
        snapshot_dual(&mut harness, "record_editor/selection_records");
    }

    /// Modified fields show a red star that propagates up through collapsed
    /// sections: `title` is edited directly, and the nested `role` edit surfaces a
    /// star on the `credit` field and the "Noha" record above it.
    #[test]
    fn modified_fields() {
        let mut form = nested_form();
        form.fields[0] = with_original(text("title", "Sonnenregen"), Some("Goldregen"));
        if let FieldKind::MultiRecord { entries, .. } = &mut form.fields[2].kind
            && let Some(sub) = &mut entries[1].expanded
        {
            sub.fields[1] = with_original(text("role", "Producer"), Some("Remix by"));
        }
        let mut harness = snapshot_harness::harness(egui::vec2(420.0, 420.0), move |ui| {
            form.show(ui);
        });
        harness.run();
        snapshot_dual(&mut harness, "record_editor/modified_fields");
    }

    /// An activated field renders its value as a focused text input in place of the
    /// display text (here the top-level `title`).
    #[test]
    fn editing_field() {
        let mut form = nested_form();
        form.editing = Some(FormEdit {
            path: vec![FormStep::Field(0)],
            buffer: "Goldregen".to_owned(),
            focus: true,
        });
        let mut harness = snapshot_harness::harness(egui::vec2(420.0, 300.0), move |ui| {
            form.show(ui);
        });
        harness.run();
        snapshot_dual(&mut harness, "record_editor/editing_field");
    }

    /// A new record being added sits at the top of a multi-record field, expanded,
    /// its embedded widget reading "New" while its (empty) fields await input.
    #[test]
    fn new_record() {
        let empty = |name: &str, ty: Primitive| FormField {
            name: name.to_owned(),
            kind: FieldKind::Primitive {
                ty,
                value: None,
                original: None,
            },
            collapsed: true,
        };
        let new_sub = editor(
            "credit",
            Vec::new(),
            vec![
                empty("role", Primitive::Text),
                empty("ord", Primitive::Number),
            ],
        );
        let mut form = nested_form();
        if let FieldKind::MultiRecord { entries, .. } = &mut form.fields[2].kind {
            entries.insert(
                0,
                MultiEntry {
                    key: Vec::new(),
                    row: None,
                    is_new: true,
                    collapsed: false,
                    expanded: Some(Box::new(new_sub)),
                    deleted: false,
                },
            );
        }
        let mut harness = snapshot_harness::harness(egui::vec2(420.0, 480.0), move |ui| {
            form.show(ui);
        });
        harness.run();
        snapshot_dual(&mut harness, "record_editor/new_record");
    }

    /// A scalar-link field with a brand-new linked record being entered: its value
    /// area shows the italic "New" embedded widget and its (empty) nested editor is
    /// expanded below, the first field activated for typing.
    #[test]
    fn scalar_new_record() {
        let empty = |name: &str, ty: Primitive| FormField {
            name: name.to_owned(),
            kind: FieldKind::Primitive {
                ty,
                value: None,
                original: None,
            },
            collapsed: true,
        };
        let new_album = editor(
            "album",
            Vec::new(),
            vec![
                empty("title", Primitive::Text),
                empty("year", Primitive::Number),
            ],
        );
        let mut form = editor(
            "track",
            vec![("id".to_owned(), "d289fa9e".to_owned())],
            vec![
                text("title", "Goldregen"),
                FormField {
                    name: "album".to_owned(),
                    kind: FieldKind::ScalarLink {
                        target: "album".to_owned(),
                        id: None,
                        original_id: None,
                        embedded: Load::Idle,
                        expanded: Some(Box::new(new_album)),
                    },
                    collapsed: false,
                },
                id_field("id", "d289fa9e-8354-4e4b-9df3-5f8b64eb5304"),
            ],
        );
        form.editing = Some(FormEdit {
            path: vec![FormStep::Field(1), FormStep::Field(0)],
            buffer: "Bal".to_owned(),
            focus: true,
        });
        let mut harness = snapshot_harness::harness(egui::vec2(420.0, 360.0), move |ui| {
            form.show(ui);
        });
        harness.run();
        snapshot_dual(&mut harness, "record_editor/scalar_new_record");
    }
}
