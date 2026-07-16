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

/// The loaded contents of a multi-record field: the display columns, the related
/// rows, and per-row UI state.
#[derive(Debug)]
pub(crate) struct MultiData {
    pub(crate) columns: Vec<ColumnMetadata>,
    pub(crate) rows: ResultRows,
    /// Number of leading columns that carry the row's identifying key (prepended
    /// to the query so each record can be re-fetched on expand); skipped when
    /// drawing the embedded widget.
    pub(crate) display_offset: usize,
    /// One entry per row, parallel to `rows`.
    pub(crate) entries: Vec<MultiEntry>,
}

/// UI state for one record within a multi-record field.
#[derive(Debug)]
pub(crate) struct MultiEntry {
    /// Column/value pairs identifying this record, for re-fetching its full form.
    pub(crate) key: Vec<(String, String)>,
    pub(crate) collapsed: bool,
    /// The nested editor for this record, built when first expanded.
    pub(crate) expanded: Option<Box<RecordEditor>>,
    /// Set when the user has ephemerally deleted this record within the form; a
    /// deleted entry is skipped when rendering, navigating, and counting.
    pub(crate) deleted: bool,
}

/// What a form field represents, plus the state needed to render and load it.
#[derive(Debug)]
pub(crate) enum FieldKind {
    /// A plain column value. `value` is the display text; `None` means `NULL`.
    Primitive {
        ty: Primitive,
        value: Option<String>,
    },
    /// A foreign-key column referencing a single record in `target`. `id` is the
    /// raw key value (`None` for `NULL`); `embedded` is the collapsed-preview data
    /// (loaded even while collapsed); `expanded` is the nested editor built when
    /// the user drills in.
    ScalarLink {
        target: String,
        id: Option<String>,
        embedded: Load<RecordDisplay>,
        expanded: Option<Box<RecordEditor>>,
    },
    /// The set of records in `table` referencing this record through
    /// `link_column`. `count` is loaded up front; `data` (the records themselves)
    /// only once the field is expanded.
    MultiRecord {
        table: String,
        /// The column in `table` that references this record.
        link_column: String,
        /// The referenced column on this record's table (the link target, usually
        /// `id`) — the value the child rows filter against.
        parent_column: String,
        count: usize,
        data: Load<MultiData>,
    },
}

impl FieldKind {
    /// Whether this field currently has anything to expand into. A collapsible
    /// field is *not* expandable when it's empty — a scalar link with a `NULL`
    /// target, or a multi-record field with no related records — so no expansion
    /// toggle is shown for it.
    pub(crate) fn is_expandable(&self) -> bool {
        match self {
            FieldKind::ScalarLink { id, .. } => id.is_some(),
            FieldKind::MultiRecord { count, .. } => *count > 0,
            FieldKind::Primitive { .. } => false,
        }
    }
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
            kind: FieldKind::Primitive { ty, value },
            collapsed: true,
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

/// The current selection within a record editor form. Field labels and embedded
/// records in scalar-link fields are single-selection; sibling embedded records
/// within one multi-record field support multi-selection.
#[derive(Debug, Clone)]
pub(crate) enum FormSelection {
    /// A single selected element: a field label, or a single embedded record.
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
/// the render (so selection updates don't fight the borrow of the tree).
#[derive(Default)]
pub(crate) struct FormOutput {
    /// A selectable element was primary-clicked, with the modifiers then held.
    pub(crate) clicked: Option<(FormPath, egui::Modifiers)>,
}

/// The selection state threaded through the recursive render: the current
/// selection to highlight against, whether to scroll the lead into view this
/// frame, and the output accumulator for click interactions.
struct SelCtx<'a> {
    sel: Option<&'a FormSelection>,
    scroll: bool,
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
    /// Set when the selection changed via keyboard so the next render scrolls the
    /// lead element into view; cleared once consumed.
    pub(crate) scroll_to_selection: bool,
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
                    data: Load::Idle,
                },
            ));
        }

        Some(Self {
            base_table: base.to_owned(),
            key: Vec::new(),
            fields,
            values: Load::Idle,
            selection: None,
            scroll_to_selection: false,
        })
    }

    /// Sets this editor's identifying key, seeding the corresponding primitive
    /// fields with their values so the form shows which record it edits before its
    /// data loads.
    pub(crate) fn with_key(mut self, key: Vec<(String, String)>) -> Self {
        for (col, val) in &key {
            for field in &mut self.fields {
                if field.name == *col
                    && let FieldKind::Primitive { value, .. } = &mut field.kind
                {
                    *value = Some(val.clone());
                }
            }
        }
        self.key = key;
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
                FieldKind::MultiRecord { data, .. } => {
                    if data.token() == Some(token) {
                        *data = match slot.take().unwrap() {
                            Ok(FormPayload::Multi(d)) => Load::Ready(d),
                            Ok(_) => Load::Failed("unexpected payload".to_owned()),
                            Err(e) => Load::Failed(e),
                        };
                        return;
                    }
                    if let Load::Ready(d) = data {
                        for entry in &mut d.entries {
                            if let Some(sub) = &mut entry.expanded {
                                sub.deliver(token, slot);
                                if slot.is_none() {
                                    return;
                                }
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
                FieldKind::Primitive { value, .. } => {
                    *value = cell.filter(|s| !s.is_empty());
                }
                FieldKind::ScalarLink { id, .. } => {
                    *id = cell.filter(|s| !s.is_empty());
                }
                FieldKind::MultiRecord { count, .. } => {
                    *count = cell.and_then(|s| s.parse().ok()).unwrap_or(0);
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
        FieldKind::MultiRecord { count, data, .. } => {
            *count = 0;
            *data = Load::Idle;
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
                FieldKind::MultiRecord {
                    data: Load::Ready(d),
                    ..
                } => {
                    for (j, entry) in d.entries.iter().enumerate() {
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
                    (
                        FieldKind::MultiRecord {
                            data: Load::Ready(d),
                            ..
                        },
                        (FormStep::Entry(ej), erest),
                    ) => d.entries.get(*ej)?.expanded.as_ref()?.field_at(erest),
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
                    (
                        FieldKind::MultiRecord {
                            data: Load::Ready(d),
                            ..
                        },
                        (FormStep::Entry(ej), erest),
                    ) => {
                        let entry = d.entries.get_mut(*ej)?;
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
                kind:
                    FieldKind::MultiRecord {
                        data: Load::Ready(d),
                        ..
                    },
                ..
            }) => d
                .entries
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
            // A field label (or scalar-link embedded record): single selection only.
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
                    && let FieldKind::MultiRecord {
                        count,
                        data: Load::Ready(d),
                        ..
                    } = &mut f.kind
                {
                    for i in &indices {
                        if let Some(e) = d.entries.get_mut(*i) {
                            e.deleted = true;
                            e.expanded = None;
                        }
                    }
                    *count = d.entries.iter().filter(|e| !e.deleted).count();
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

/// A finished form query, ready to be applied to the tree by [`RecordEditor::apply`].
#[derive(Debug)]
pub(crate) enum FormPayload {
    /// One row of the record's own column values and referencing counts.
    Values(ResultRows),
    /// The single linked record for a scalar-link preview.
    Embedded(RecordDisplay),
    /// The related records for an expanded multi-record field.
    Multi(MultiData),
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
                    let entries = (0..rows.len())
                        .map(|r| MultiEntry {
                            key: key_columns
                                .iter()
                                .enumerate()
                                .map(|(i, name)| {
                                    (name.clone(), rows.cell_text(r, i).unwrap_or_default())
                                })
                                .collect(),
                            collapsed: true,
                            expanded: None,
                            deleted: false,
                        })
                        .collect();
                    FormPayload::Multi(MultiData {
                        columns,
                        rows,
                        display_offset,
                        entries,
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
/// Focus ring drawn around a selected form element: its outward inset and width.
const SELECT_RING_INSET: f32 = 1.5;
const SELECT_RING_WIDTH: f32 = 1.5;
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
                ui.add_enabled_ui(false, |ui| {
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
        let mut out = FormOutput::default();
        let mut sc = SelCtx {
            sel: sel.as_ref(),
            scroll,
            out: &mut out,
        };
        let toolbar_border = ui.cursor().top();
        ui.add_space(BODY_HEADROOM);
        render_record(ui, ctx, self, 0, Some(toolbar_border), &[], &mut sc);
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
    let (bg, icon) = kind_style(&field.kind);
    let galley = layout_pill(ui, icon, &field.name);
    let pill_size = pill_size(&galley);

    // Width left for the value area, matching what `draw_value` sees once the
    // chevron gutter, pill and gaps are consumed — so a dynamic embedded widget's
    // height can be measured to size the row before anything is drawn.
    let value_left = indent + CHEVRON_GUTTER + TICK_EXTRA + pill_size.x + VALUE_GAP;
    let value_avail = (ui.available_width() - value_left).max(0.0);
    let row_h = pill_size.y.max(value_height(ui, &field.kind, value_avail));

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
                field.collapsed = !field.collapsed;
            }
        }

        ui.add_space(TICK_EXTRA);
        // The label pill selects the field on click; its ring shows the selection.
        let pill_resp = paint_pill(ui, galley, pill_size, bg, selected);
        sc.click(path, &pill_resp);
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
            let Some(id) = id.clone() else { return };
            // Build the nested editor lazily on first expand.
            if expanded.is_none()
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
            data,
        } => {
            // Dispatch the related-records query on first expand.
            if data.is_idle()
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
                *data =
                    Load::Loading(ctx.load_multi(table, link_column, &parent_value, &key_columns));
            }
            render_multi(
                ui,
                ctx,
                table,
                *count,
                data,
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
    count: usize,
    data: &mut Load<MultiData>,
    depth: usize,
    parent_bottom: f32,
    path: &[FormStep],
    sc: &mut SelCtx,
) {
    let indent = depth as f32 * INDENT;
    match data {
        Load::Ready(d) => {
            let cols = d.columns.clone();
            let offset = d.display_offset;
            let tree_idx = ui.painter().add(egui::Shape::Noop);
            let mut ticks: Vec<Tick> = Vec::with_capacity(d.entries.len());
            let mut first = true;
            for (i, entry) in d.entries.iter_mut().enumerate() {
                // Ephemerally-deleted records leave the list entirely.
                if entry.deleted {
                    continue;
                }
                if !first {
                    ui.add_space(ROW_SPACING);
                }
                first = false;
                let cells = d.rows.row_values(i);
                let entry_path = child(path, FormStep::Entry(i));
                let rect = render_entry(
                    ui,
                    ctx.as_deref_mut(),
                    &cols,
                    &cells,
                    offset,
                    entry,
                    table,
                    depth,
                    indent,
                    &entry_path,
                    sc,
                );
                let (spine_x, tick_end) = tick_anchors(rect.left(), indent);
                ticks.push((spine_x, tick_end, rect.center().y.round()));
            }
            if !ticks.is_empty() {
                draw_tree(ui, tree_idx, &ticks, Some(parent_bottom));
            }
        }
        Load::Loading(_) | Load::Idle => {
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
        Load::Failed(e) => {
            ui.horizontal(|ui| {
                ui.add_space(indent + CHEVRON_GUTTER + TICK_EXTRA);
                ui.colored_label(egui::Color32::RED, e.as_str());
            });
        }
    }
}

/// Renders one embedded record within a multi-record field: a chevron plus the
/// embedded widget (vertically centered together), and (when expanded) its nested
/// editor beneath. Returns the header row's rect (for the parent's tree ticks).
#[allow(clippy::too_many_arguments)]
fn render_entry(
    ui: &mut egui::Ui,
    mut ctx: Option<&mut FormCtx>,
    columns: &[ColumnMetadata],
    cells: &[CellValue],
    offset: usize,
    entry: &mut MultiEntry,
    table: &str,
    depth: usize,
    indent: f32,
    path: &[FormStep],
    sc: &mut SelCtx,
) -> egui::Rect {
    let value_avail = (ui.available_width() - indent - CHEVRON_GUTTER - TICK_EXTRA).max(0.0);
    let row_h = embed_size(ui, &columns[offset..], value_avail).y;
    let selected = sc.selected(path);

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
        // siblings) and toggles expand on double click.
        let widget = draw_embedded(ui, &columns[offset..], &cells[offset..]);
        if selected {
            paint_embed_ring(ui, widget.rect);
        }
        if sc.scroll && sc.is_lead(path) {
            ui.scroll_to_rect(widget.rect, None);
        }
        sc.click(path, &widget);
        if gutter_resp.clicked() || widget.double_clicked() {
            entry.collapsed = !entry.collapsed;
        }
    });

    if !entry.collapsed {
        if entry.expanded.is_none()
            && let Some(ctx) = ctx.as_deref_mut()
            && let Some(sub) = RecordEditor::structure(ctx.schema, table)
        {
            entry.expanded = Some(Box::new(sub.with_key(entry.key.clone())));
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
/// icon-and-name galley inside. The pill senses clicks (to select its field) and,
/// when `selected`, is wrapped in a focus ring. Returns its click response.
fn paint_pill(
    ui: &mut egui::Ui,
    galley: Arc<egui::Galley>,
    size: egui::Vec2,
    bg: Duo,
    selected: bool,
) -> egui::Response {
    let fg = LABEL_FG.get(ui.visuals());
    // `CLICK` (not `click()`) so the pill senses clicks without becoming
    // keyboard-focusable — form selection is app state, and a focused egui widget
    // would suppress the plain-arrow selection commands.
    let (rect, resp) = ui.allocate_exact_size(size, egui::Sense::CLICK);
    ui.painter()
        .rect_filled(rect, PILL_RADIUS, bg.get(ui.visuals()));
    ui.painter()
        .galley(rect.min + egui::vec2(PILL_PAD_X, PILL_PAD_Y), galley, fg);
    if selected {
        paint_selection_ring(ui, rect, PILL_RADIUS);
    }
    resp
}

/// Draws a focus ring just outside `rect` (with matching rounded corners), marking
/// a selected form element.
fn paint_selection_ring(ui: &egui::Ui, rect: egui::Rect, radius: f32) {
    let color = ui.visuals().selection.stroke.color;
    ui.painter().rect_stroke(
        rect.expand(SELECT_RING_INSET),
        radius + SELECT_RING_INSET,
        egui::Stroke::new(SELECT_RING_WIDTH, color),
        egui::StrokeKind::Outside,
    );
}

/// Draws the focus ring for a selected embedded-record widget, matching its
/// (semicircular) corner radius.
fn paint_embed_ring(ui: &egui::Ui, rect: egui::Rect) {
    paint_selection_ring(ui, rect, embed_radius(ui));
}

/// The static height of a field's value area (everything but a dynamic embedded
/// widget), used to size the row before drawing. `value_avail` is the width the
/// value has, needed to measure an embedded record's wrapped height.
fn value_height(ui: &egui::Ui, kind: &FieldKind, value_avail: f32) -> f32 {
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

/// Draws a field's value area to the right of its label. `path`/`sc` let a
/// scalar-link's embedded record participate in selection (clicking it selects the
/// field, same as clicking the label).
fn draw_value(
    ui: &mut egui::Ui,
    ctx: Option<&mut FormCtx>,
    field: &mut FormField,
    path: &[FormStep],
    sc: &mut SelCtx,
) {
    match &mut field.kind {
        FieldKind::Primitive {
            ty: Primitive::Id,
            value: Some(v),
        } => draw_uuid(ui, v),
        FieldKind::Primitive { value: Some(v), .. } => {
            draw_scalar(ui, v, ui.visuals().text_color());
        }
        FieldKind::Primitive { value: None, .. } => draw_pencil(ui),
        FieldKind::ScalarLink {
            target,
            id,
            embedded,
            ..
        } => draw_scalar_link(ui, ctx, target, id.as_deref(), embedded, path, sc),
        FieldKind::MultiRecord { count, .. } => draw_count(ui, *count),
    }
}

/// Draws a scalar-linked field's value: the pencil affordance when `NULL`,
/// otherwise the embedded-record widget (a skeleton while its preview loads).
/// Dispatches the preview query once the id is known. A click on the embedded
/// record selects the field (`path`).
#[allow(clippy::too_many_arguments)]
fn draw_scalar_link(
    ui: &mut egui::Ui,
    ctx: Option<&mut FormCtx>,
    target: &str,
    id: Option<&str>,
    embedded: &mut Load<RecordDisplay>,
    path: &[FormStep],
    sc: &mut SelCtx,
) {
    let Some(id) = id else {
        draw_pencil(ui);
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
            let widget = draw_embedded(ui, &d.columns, &cells);
            sc.click(path, &widget);
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

/// Draws a scalar value as text in `color`, truncated with an ellipsis.
fn draw_scalar(ui: &mut egui::Ui, text: &str, color: egui::Color32) {
    draw_truncated(ui, text, color, egui::FontId::proportional(VALUE_TEXT_SIZE));
}

/// Draws a UUID field value in small monospace, weak color, truncated to fit.
fn draw_uuid(ui: &mut egui::Ui, text: &str) {
    draw_truncated(
        ui,
        text,
        ui.visuals().weak_text_color(),
        egui::FontId::monospace(UUID_TEXT_SIZE),
    );
}

/// Lays out `text` truncated with an ellipsis to the row's remaining width.
fn draw_truncated(ui: &mut egui::Ui, text: &str, color: egui::Color32, font: egui::FontId) {
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
    let (rect, _) = ui.allocate_exact_size(galley.size(), egui::Sense::hover());
    ui.painter().galley(rect.min, galley, color);
}

/// Draws the pencil affordance shown for a `NULL`/empty field.
fn draw_pencil(ui: &mut egui::Ui) {
    Button::icon(icons::EDIT).show(ui);
}

/// Draws a multi-record field's value: a rounded count badge followed by the
/// "add record" button.
fn draw_count(ui: &mut egui::Ui, count: usize) {
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
    Button::icon(icons::ADD).show(ui);
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

/// Draws an embedded-record widget filling the remaining row width: a rounded rect
/// with the same top-lit gradient (and hover shading) as a query result row, a
/// faint border, and fields rendered like a result row but forced to small, light
/// text. Returns the widget's [`egui::Response`] (for double-click to expand).
fn draw_embedded(
    ui: &mut egui::Ui,
    columns: &[ColumnMetadata],
    cells: &[CellValue],
) -> egui::Response {
    let el = embed_layout(ui, columns, ui.available_width());
    let radius = embed_radius(ui);

    let (rect, resp) = ui.allocate_exact_size(el.size, egui::Sense::CLICK);
    let (top, bottom) = embed_gradient(ui, resp.hovered());
    paint_rounded_gradient(ui.painter(), rect, radius, top, bottom);
    ui.painter().rect_stroke(
        rect,
        radius,
        egui::Stroke::new(1.0, EMBED_BORDER.get(ui.visuals())),
        egui::StrokeKind::Inside,
    );

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
}

#[cfg(test)]
mod snapshot_tests {
    //! Headless snapshot tests for the record editor form, rendered in isolation
    //! (no app, no data loading) from a hand-built [`RecordEditor`] whose slots are
    //! pre-populated. Generate/refresh with `UPDATE_SNAPSHOTS=1 cargo test -p frontend`.

    use eframe::egui;

    use super::{
        FieldKind, FormField, FormSelection, FormStep, Load, MultiData, MultiEntry, Primitive,
        RecordDisplay, RecordEditor,
    };
    use crate::columns::ColumnMetadata;
    use crate::rows::ResultRows;
    use crate::snapshot_harness::{self, snapshot_dual};

    fn text(name: &str, value: &str) -> FormField {
        FormField {
            name: name.to_owned(),
            kind: FieldKind::Primitive {
                ty: Primitive::Text,
                value: Some(value.to_owned()),
            },
            collapsed: true,
        }
    }

    fn number(name: &str, value: &str) -> FormField {
        FormField {
            name: name.to_owned(),
            kind: FieldKind::Primitive {
                ty: Primitive::Number,
                value: Some(value.to_owned()),
            },
            collapsed: true,
        }
    }

    fn id_field(name: &str, value: &str) -> FormField {
        FormField {
            name: name.to_owned(),
            kind: FieldKind::Primitive {
                ty: Primitive::Id,
                value: Some(value.to_owned()),
            },
            collapsed: true,
        }
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
                embedded: Load::Ready(RecordDisplay {
                    columns: cols(preview.len()),
                    rows: ResultRows::from_cells(&[preview.to_vec()]),
                }),
                expanded: None,
            },
            collapsed: true,
        }
    }

    /// An expanded multi-record field named `name`, backed by `data`.
    fn multi(name: &str, count: usize, data: Load<MultiData>) -> FormField {
        FormField {
            name: name.to_owned(),
            kind: FieldKind::MultiRecord {
                table: name.to_owned(),
                link_column: "track".to_owned(),
                parent_column: "id".to_owned(),
                count,
                data,
            },
            collapsed: false,
        }
    }

    /// The rich scene: a track form with a loaded scalar link, and an expanded
    /// `credit` multi-record field whose middle record is itself expanded into a
    /// nested editor (a scalar link + primitives).
    fn nested_form() -> RecordEditor {
        // The nested editor for the expanded "Noha" credit record.
        let noha = RecordEditor {
            base_table: "credit".to_owned(),
            key: vec![
                ("track".to_owned(), "t".to_owned()),
                ("artist".to_owned(), "a2".to_owned()),
            ],
            values: Load::Ready(()),
            selection: None,
            scroll_to_selection: false,
            fields: vec![
                linked("artist", "artist", &[Some("Noha")]),
                text("role", "Remix by"),
                number("ord", "2"),
            ],
        };

        let credit_data = MultiData {
            columns: cols(4),
            // Columns: [track (key), artist (key), name, role].
            rows: ResultRows::from_cells(&[
                vec![Some("t"), Some("a1"), Some("Deladap"), None],
                vec![Some("t"), Some("a2"), Some("Noha"), Some("Remix by")],
                vec![Some("t"), Some("a3"), Some("17 Hippies"), Some("Featured")],
            ]),
            display_offset: 2,
            entries: vec![
                MultiEntry {
                    key: vec![("track".into(), "t".into()), ("artist".into(), "a1".into())],
                    collapsed: true,
                    expanded: None,
                    deleted: false,
                },
                MultiEntry {
                    key: vec![("track".into(), "t".into()), ("artist".into(), "a2".into())],
                    collapsed: false,
                    expanded: Some(Box::new(noha)),
                    deleted: false,
                },
                MultiEntry {
                    key: vec![("track".into(), "t".into()), ("artist".into(), "a3".into())],
                    collapsed: true,
                    expanded: None,
                    deleted: false,
                },
            ],
        };

        RecordEditor {
            base_table: "track".to_owned(),
            key: vec![("id".to_owned(), "d289fa9e".to_owned())],
            values: Load::Ready(()),
            selection: None,
            scroll_to_selection: false,
            fields: vec![
                text("title", "Goldregen"),
                linked("album", "album", &[Some("The Balkan Club Night")]),
                multi("credit", 3, Load::Ready(credit_data)),
                id_field("id", "d289fa9e-8354-4e4b-9df3-5f8b64eb5304"),
            ],
        }
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
        RecordEditor {
            base_table: "track".to_owned(),
            key: vec![("id".to_owned(), "d289fa9e".to_owned())],
            values: Load::Ready(()),
            selection: None,
            scroll_to_selection: false,
            fields: vec![
                text("title", "Goldregen"),
                FormField {
                    name: "album".to_owned(),
                    kind: FieldKind::ScalarLink {
                        target: "album".to_owned(),
                        id: Some("x".to_owned()),
                        embedded: Load::Loading(2),
                        expanded: None,
                    },
                    collapsed: true,
                },
                multi("credit", 3, Load::Loading(1)),
            ],
        }
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

    /// A selected field label draws a focus ring around its pill (here the nested
    /// `role` field within the expanded "Noha" credit record).
    #[test]
    fn selection_field_label() {
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
        snapshot_dual(&mut harness, "record_editor/selection_field_label");
    }

    /// Multiple sibling embedded records selected within a multi-record field each
    /// draw a focus ring (here the first and third `credit` records).
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
}
