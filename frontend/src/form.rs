//! The record editor form: a dynamic, introspection-driven form for editing one
//! record from a base table.
//!
//! # This is the render-only foundation
//!
//! The full feature (see `plans/2026-07-dml-ui-form/plan.md`) is a large,
//! interactive tree form. This module is the first slice of it: it renders the
//! form in its **initial, fully-collapsed state** and handles only one
//! interaction — closing the sidebar via *Cancel*. Deliberately deferred to
//! later sessions: expand/collapse, edit mode and mutation, embedded-record
//! widgets (for now a scalar-linked field shows its raw id value in place),
//! long-vs-short text handling, selection, keyboard shortcuts, and the record
//! picker.
//!
//! # Decoupled from data loading
//!
//! Rendering is driven entirely by an in-memory [`RecordEditor`] value — a flat
//! list of [`FormField`]s. [`RecordEditor::structure`] derives that list from the
//! introspection [`Schema`] (which columns become which kind of field, in what
//! order); the field *values* are filled in separately (from a query, eventually).
//! Keeping the model free of any HTTP/async lets the snapshot tests construct a
//! form directly and exercise the rendering in isolation.

use eframe::egui;
use egui::text::LayoutJob;
use introspection::Schema;

use crate::icons::{self, MaterialIcon};
use crate::theme::Duo;

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

/// What a form field represents, along with the data needed to render it in the
/// collapsed initial state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FieldKind {
    /// A plain column value. `value` is the display text; `None` means `NULL`.
    Primitive {
        ty: Primitive,
        value: Option<String>,
    },
    /// A foreign-key column referencing a single record in `target` table. Until
    /// embedded records are implemented, `id` (the raw foreign-key value, or
    /// `None` for `NULL`) is shown in the value area.
    ScalarLink { target: String, id: Option<String> },
    /// The set of records in `table` that reference this record. `count` is how
    /// many there are (loaded up front; the records themselves are not).
    MultiRecord { table: String, count: usize },
}

impl FieldKind {
    /// Whether this kind can be expanded/collapsed (has, or can load, children).
    /// Scalar-linked and multi-record fields are collapsible; primitives are not.
    pub(crate) fn is_collapsible(&self) -> bool {
        matches!(
            self,
            FieldKind::ScalarLink { .. } | FieldKind::MultiRecord { .. }
        )
    }
}

/// One field in the form.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FormField {
    /// The label shown in the field's pill — a column name, or a referencing
    /// table's name for a multi-record field.
    pub(crate) name: String,
    pub(crate) kind: FieldKind,
    /// Whether a collapsible field is collapsed. Always `true` in this
    /// render-only slice (expansion isn't wired up yet), but modeled so the
    /// rendering already branches on it.
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

/// A record editor form: the fields of one record from `base_table`, in display
/// order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RecordEditor {
    /// The base table whose record is being edited (drives the toolbar title).
    pub(crate) base_table: String,
    pub(crate) fields: Vec<FormField>,
    /// The primary-key value of the record being edited, once seeded (see
    /// [`set_record_id`](Self::set_record_id)). Held separately from the fields
    /// so the app can tell whether a newly selected result row is a *different*
    /// record without re-deriving which field is the key.
    pub(crate) record_id: Option<String>,
}

impl RecordEditor {
    /// Builds the form *structure* for editing a record from `base` — which
    /// fields exist, of which kind, in what order — from the introspected
    /// `schema`. Field values are left empty (`NULL`); a later step fills them in
    /// from a data query. Returns `None` if `base` isn't a table in the schema.
    ///
    /// Order follows the plan: the base table's own columns first, in
    /// introspection order, then one multi-record field per table that references
    /// the base, listed alphabetically. A base column that is an inferred foreign
    /// key becomes a scalar-linked field; otherwise it's a primitive typed by its
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
                        },
                    )
                } else {
                    FormField::primitive(col.name.clone(), primitive_type(col), None)
                }
            })
            .collect();

        // Referencing tables become multi-record fields, alphabetical by table.
        // A table may reference the base through more than one column; each such
        // link is its own field (deduped by table+column and sorted for
        // stability).
        let mut incoming: Vec<(&str, &str)> = schema
            .incoming_links(base)
            .map(|l| (l.from_table.as_str(), l.from_column.as_str()))
            .collect();
        incoming.sort_unstable();
        incoming.dedup();
        for (table_name, _column) in incoming {
            fields.push(FormField::collapsible(
                table_name.to_owned(),
                FieldKind::MultiRecord {
                    table: table_name.to_owned(),
                    count: 0,
                },
            ));
        }

        Some(Self {
            base_table: base.to_owned(),
            fields,
            record_id: None,
        })
    }

    /// Populates the primary-key field (`pk_column`) with the record's id, so a
    /// freshly opened form shows which record it's editing even before the other
    /// field values are loaded. Also records the id on [`record_id`](Self::record_id)
    /// so the app can compare it against the current selection.
    pub(crate) fn set_record_id(&mut self, pk_column: &str, id: String) {
        for field in &mut self.fields {
            if field.name == pk_column {
                if let FieldKind::Primitive { value, .. } = &mut field.kind {
                    *value = Some(id.clone());
                }
                break;
            }
        }
        self.record_id = Some(id);
    }
}

/// The column that identifies a single record in `table`, by Collectune's
/// convention: a non-null, single-column UNIQUE / PRIMARY KEY constraint,
/// preferring one named `id` when a table has several. Returns `None` for a
/// table keyed only by a composite constraint (e.g. `credit (track, artist)`),
/// which has no single id column to seed the form or match against a result row.
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
    // Match the family by prefix so parameterized types like `DECIMAL(18,3)` are
    // caught too.
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

// --- Rendering -------------------------------------------------------------

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

/// Icon + text color inside a label pill. The pill fills are pale on light /
/// deep on dark, so a near-black (light) / near-white (dark) foreground reads on
/// both.
const LABEL_FG: Duo = Duo {
    light: egui::Color32::from_gray(0x22),
    dark: egui::Color32::from_gray(0xEC),
};

/// Background of a multi-record field's count badge.
const COUNT_BG: Duo = Duo {
    light: egui::Color32::from_gray(0xE3),
    dark: egui::Color32::from_gray(0x3A),
};

/// Color of the hierarchy tree lines drawn down the left gutter connecting the
/// sibling fields — a light gray that reads as quiet structure in either theme.
const TREE_LINE: Duo = Duo {
    light: egui::Color32::from_gray(0xC8),
    dark: egui::Color32::from_gray(0x50),
};

/// Corner radius of a field-label pill (rounder than the app's buttons, per the
/// mockup).
const PILL_RADIUS: f32 = 6.0;
/// Horizontal padding inside a label pill.
const PILL_PAD_X: f32 = 7.0;
/// Vertical padding inside a label pill.
const PILL_PAD_Y: f32 = 2.0;
/// Icon glyph size inside a label pill.
const PILL_ICON_SIZE: f32 = 14.0;
/// Label text size inside a label pill.
const PILL_TEXT_SIZE: f32 = 13.0;
/// Gap between a pill's icon and its text.
const PILL_ICON_GAP: f32 = 5.0;
/// Width of the gutter reserved on the left of every field for the expansion
/// chevron (empty for non-collapsible fields, so their pills still align).
const CHEVRON_GUTTER: f32 = 18.0;
/// Chevron glyph size.
const CHEVRON_SIZE: f32 = 16.0;
/// Gap between a field's label pill and its value.
const VALUE_GAP: f32 = 8.0;
/// Vertical space between successive field rows.
const ROW_SPACING: f32 = 5.0;
/// Diameter/height of the count-badge pill and the value-size of the count text.
const COUNT_TEXT_SIZE: f32 = 12.0;
/// Value text size (scalar values shown to the right of a label).
const VALUE_TEXT_SIZE: f32 = 14.0;

/// The outcome of showing a [`RecordEditor`]: whether the user asked to close it.
#[derive(Default)]
pub(crate) struct FormResponse {
    /// The user clicked *Cancel* (the toolbar's close action).
    pub(crate) cancel: bool,
}

impl RecordEditor {
    /// Renders the whole form (toolbar then fields) into `ui`. Used by the
    /// snapshot tests to drive the form standalone; the app's sidebar pins the
    /// toolbar and scrolls the body via [`toolbar`](Self::toolbar) /
    /// [`body`](Self::body) instead.
    #[allow(dead_code)]
    pub(crate) fn show(&self, ui: &mut egui::Ui) -> FormResponse {
        let resp = self.toolbar(ui);
        ui.add_space(6.0);
        self.body(ui);
        resp
    }

    /// The toolbar: the "Edit {table}" title on the left and the Cancel/Save
    /// actions on the right. Save is always disabled in this slice (no mutation
    /// yet). Returns whether Cancel was clicked.
    pub(crate) fn toolbar(&self, ui: &mut egui::Ui) -> FormResponse {
        let mut resp = FormResponse::default();
        ui.horizontal(|ui| {
            ui.add_space(2.0);
            ui.label(
                egui::RichText::new(format!("Edit {}", self.base_table))
                    .size(13.0)
                    .color(ui.visuals().weak_text_color()),
            );
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                // Save has nothing to save yet, so it renders disabled.
                labeled_button(ui, icons::SAVE, "Save", false);
                if labeled_button(ui, icons::REVERT, "Cancel", true).clicked() {
                    resp.cancel = true;
                }
            });
        });
        resp
    }

    /// The form body: one row per field, with hierarchy tree lines connecting
    /// the sibling fields down the left gutter.
    pub(crate) fn body(&self, ui: &mut egui::Ui) {
        if self.fields.is_empty() {
            return;
        }
        // Reserve a shape slot up front so the tree lines paint *behind* the rows
        // (a collapsible field's chevron sits on the vertical spine). We fill it
        // in once every row's geometry is known.
        let tree_idx = ui.painter().add(egui::Shape::Noop);

        // Per row: (spine x, label-pill left edge, row vertical center).
        let mut ticks: Vec<(f32, f32, f32)> = Vec::with_capacity(self.fields.len());
        for (i, field) in self.fields.iter().enumerate() {
            if i > 0 {
                ui.add_space(ROW_SPACING);
            }
            let rect = draw_field(ui, field);
            let spine_x = (rect.left() + CHEVRON_GUTTER * 0.5).round();
            let pill_left = rect.left() + CHEVRON_GUTTER;
            ticks.push((spine_x, pill_left, rect.center().y.round()));
        }

        let stroke = egui::Stroke::new(1.0, TREE_LINE.get(ui.visuals()));
        let spine_x = ticks[0].0;
        let mut shapes: Vec<egui::Shape> = Vec::with_capacity(ticks.len() + 1);
        // The vertical spine runs from the first sibling's center to the last's.
        shapes.push(egui::Shape::line_segment(
            [
                egui::pos2(spine_x, ticks.first().unwrap().2),
                egui::pos2(spine_x, ticks.last().unwrap().2),
            ],
            stroke,
        ));
        // A horizontal tick joins the spine to each field's label pill.
        for (tx, pill_left, cy) in &ticks {
            shapes.push(egui::Shape::line_segment(
                [egui::pos2(*tx, *cy), egui::pos2(*pill_left, *cy)],
                stroke,
            ));
        }
        ui.painter().set(tree_idx, egui::Shape::Vec(shapes));
    }
}

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

/// Draws one field row: the chevron gutter, the label pill, then the value.
/// Returns the row's rect so the caller can route the tree lines through the
/// gutter.
fn draw_field(ui: &mut egui::Ui, field: &FormField) -> egui::Rect {
    ui.horizontal(|ui| {
        // Manage the row's inter-element gaps explicitly (below) so the tree-line
        // tick lands exactly on the label pill's left edge.
        ui.spacing_mut().item_spacing.x = 0.0;
        // Chevron gutter — a right-pointing chevron for a collapsed collapsible
        // field, empty otherwise (keeping every pill's left edge aligned).
        let (gutter, _) =
            ui.allocate_exact_size(egui::vec2(CHEVRON_GUTTER, 1.0), egui::Sense::hover());
        if field.kind.is_collapsible() {
            // `collapsed` is always true here, but branch on it so the glyph is
            // already correct once expansion lands.
            let glyph = if field.collapsed {
                icons::EXPAND_CLOSED
            } else {
                icons::EXPAND_OPEN
            };
            ui.painter().text(
                gutter.center(),
                egui::Align2::CENTER_CENTER,
                glyph.codepoint,
                icons::font_id(CHEVRON_SIZE),
                ui.visuals().weak_text_color(),
            );
        }

        let (bg, icon) = kind_style(&field.kind);
        draw_label_pill(ui, icon, &field.name, bg);

        ui.add_space(VALUE_GAP);
        draw_value(ui, &field.kind);
    })
    .response
    .rect
}

/// Draws a rounded, colored label pill containing `icon` and `name`.
fn draw_label_pill(ui: &mut egui::Ui, icon: MaterialIcon, name: &str, bg: Duo) {
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
    let galley = ui.painter().layout_job(job);
    let size = galley.size() + egui::vec2(PILL_PAD_X * 2.0, PILL_PAD_Y * 2.0);
    let (rect, _) = ui.allocate_exact_size(size, egui::Sense::hover());
    ui.painter()
        .rect_filled(rect, PILL_RADIUS, bg.get(ui.visuals()));
    ui.painter()
        .galley(rect.min + egui::vec2(PILL_PAD_X, PILL_PAD_Y), galley, fg);
}

/// Draws a field's value area to the right of its label.
fn draw_value(ui: &mut egui::Ui, kind: &FieldKind) {
    match kind {
        FieldKind::Primitive {
            ty: Primitive::Id,
            value: Some(v),
        } => draw_scalar(ui, v, ui.visuals().weak_text_color()),
        FieldKind::Primitive { value: Some(v), .. } => {
            draw_scalar(ui, v, ui.visuals().text_color());
        }
        // A scalar-linked field shows its raw foreign-key id (embedded records
        // aren't rendered yet); its label color/icon already mark it as a link.
        FieldKind::ScalarLink { id: Some(id), .. } => {
            draw_scalar(ui, id, ui.visuals().weak_text_color());
        }
        // A NULL (or absent) primitive or scalar link shows the pencil
        // affordance, like the mockup — non-interactive in this slice.
        FieldKind::Primitive { value: None, .. } | FieldKind::ScalarLink { id: None, .. } => {
            draw_pencil(ui);
        }
        FieldKind::MultiRecord { count, .. } => draw_count(ui, *count),
    }
}

/// Draws a scalar value as plain text in `color`.
fn draw_scalar(ui: &mut egui::Ui, text: &str, color: egui::Color32) {
    ui.label(egui::RichText::new(text).size(VALUE_TEXT_SIZE).color(color));
}

/// Draws the pencil affordance shown for a `NULL`/empty field.
fn draw_pencil(ui: &mut egui::Ui) {
    let (rect, _) =
        ui.allocate_exact_size(egui::vec2(PILL_ICON_SIZE + 4.0, 1.0), egui::Sense::hover());
    ui.painter().text(
        rect.center(),
        egui::Align2::CENTER_CENTER,
        icons::EDIT.codepoint,
        icons::font_id(PILL_ICON_SIZE),
        ui.visuals().weak_text_color(),
    );
}

/// Draws a multi-record field's value: a rounded count badge followed by the
/// (non-interactive) "add record" plus glyph.
fn draw_count(ui: &mut egui::Ui, count: usize) {
    let weak = ui.visuals().weak_text_color();
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
    let (plus, _) =
        ui.allocate_exact_size(egui::vec2(PILL_ICON_SIZE + 4.0, 1.0), egui::Sense::hover());
    ui.painter().text(
        plus.center(),
        egui::Align2::CENTER_CENTER,
        icons::ADD.codepoint,
        icons::font_id(PILL_ICON_SIZE + 2.0),
        weak,
    );
}

/// A small toolbar button: an icon glyph plus a label. Rendered through
/// `add_enabled` so a disabled button (e.g. Save with nothing to save) reads as
/// grayed-out.
fn labeled_button(
    ui: &mut egui::Ui,
    icon: MaterialIcon,
    label: &str,
    enabled: bool,
) -> egui::Response {
    let color = if enabled {
        ui.visuals().text_color()
    } else {
        ui.visuals().weak_text_color()
    };
    let icon_color = if enabled {
        icons::DEFAULT_COLOR.get(ui.visuals())
    } else {
        ui.visuals().weak_text_color()
    };
    let mut job = LayoutJob::default();
    job.append(
        icon.codepoint,
        0.0,
        egui::TextFormat {
            font_id: icons::font_id(15.0),
            color: icon_color,
            valign: egui::Align::Center,
            ..Default::default()
        },
    );
    job.append(
        label,
        5.0,
        egui::TextFormat {
            font_id: egui::FontId::proportional(13.0),
            color,
            valign: egui::Align::Center,
            ..Default::default()
        },
    );
    let galley = ui.painter().layout_job(job);
    ui.add_enabled(enabled, egui::Button::new(galley))
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

    #[test]
    fn structure_orders_columns_then_referencing_tables() {
        let schema = Schema::parse(SAMPLE).unwrap();
        let form = RecordEditor::structure(&schema, "track").unwrap();
        let names: Vec<&str> = form.fields.iter().map(|f| f.name.as_str()).collect();
        // Intrinsic columns in introspection order, then referencing tables
        // alphabetically (credit, play).
        assert_eq!(
            names,
            ["id", "title", "album", "track_number", "credit", "play"]
        );
    }

    #[test]
    fn structure_classifies_field_kinds() {
        let schema = Schema::parse(SAMPLE).unwrap();
        let form = RecordEditor::structure(&schema, "track").unwrap();
        let kind = |name: &str| &form.fields.iter().find(|f| f.name == name).unwrap().kind;

        assert!(matches!(
            kind("id"),
            FieldKind::Primitive {
                ty: Primitive::Id,
                ..
            }
        ));
        assert!(matches!(
            kind("title"),
            FieldKind::Primitive {
                ty: Primitive::Text,
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
        // `album` is a UUID column named after the `album` table -> scalar link.
        assert!(matches!(
            kind("album"),
            FieldKind::ScalarLink { target, .. } if target == "album"
        ));
        assert!(matches!(kind("credit"), FieldKind::MultiRecord { .. }));
        assert!(matches!(kind("play"), FieldKind::MultiRecord { .. }));
    }

    #[test]
    fn structure_returns_none_for_unknown_table() {
        let schema = Schema::parse(SAMPLE).unwrap();
        assert!(RecordEditor::structure(&schema, "nonexistent").is_none());
    }

    #[test]
    fn primary_key_prefers_id_and_skips_composite_keys() {
        let schema = Schema::parse(SAMPLE).unwrap();
        // Single-column `id` constraint -> `id`.
        assert_eq!(primary_key(schema.table("track").unwrap()), Some("id"));
        assert_eq!(primary_key(schema.table("album").unwrap()), Some("id"));
        // `credit` is keyed only by the composite `(track, artist)` -> no single key.
        assert_eq!(primary_key(schema.table("credit").unwrap()), None);
    }

    #[test]
    fn numeric_type_detection_covers_parameterized_decimals() {
        assert!(is_numeric_type("DECIMAL(18,3)"));
        assert!(is_numeric_type("bigint"));
        assert!(!is_numeric_type("VARCHAR"));
        assert!(!is_numeric_type("UUID"));
    }
}

#[cfg(test)]
mod snapshot_tests {
    //! Headless snapshot tests for the record editor form, rendered in isolation
    //! (no app, no data loading) from a hand-built [`RecordEditor`]. Each renders
    //! one scene to a PNG under `tests/snapshots/record_editor/` — eyeballed
    //! against the mockup and, once correct, committed as a regression baseline.
    //! Generate/refresh with `UPDATE_SNAPSHOTS=1 cargo test -p frontend`.

    use eframe::egui;

    use super::{FieldKind, FormField, Primitive, RecordEditor};
    use crate::snapshot_harness::{self, snapshot_dual};

    fn text(name: &str, value: Option<&str>) -> FormField {
        FormField {
            name: name.to_owned(),
            kind: FieldKind::Primitive {
                ty: Primitive::Text,
                value: value.map(str::to_owned),
            },
            collapsed: true,
        }
    }

    fn number(name: &str, value: Option<&str>) -> FormField {
        FormField {
            name: name.to_owned(),
            kind: FieldKind::Primitive {
                ty: Primitive::Number,
                value: value.map(str::to_owned),
            },
            collapsed: true,
        }
    }

    fn id_field(name: &str, value: Option<&str>) -> FormField {
        FormField {
            name: name.to_owned(),
            kind: FieldKind::Primitive {
                ty: Primitive::Id,
                value: value.map(str::to_owned),
            },
            collapsed: true,
        }
    }

    fn link(name: &str, target: &str, id: Option<&str>) -> FormField {
        FormField {
            name: name.to_owned(),
            kind: FieldKind::ScalarLink {
                target: target.to_owned(),
                id: id.map(str::to_owned),
            },
            collapsed: true,
        }
    }

    fn multi(name: &str, count: usize) -> FormField {
        FormField {
            name: name.to_owned(),
            kind: FieldKind::MultiRecord {
                table: name.to_owned(),
                count,
            },
            collapsed: true,
        }
    }

    /// A representative track form covering every field kind and value state:
    /// text, number, a NULL primitive (pencil), a NULL and a populated scalar
    /// link, a UUID id, and two multi-record fields.
    fn sample_form() -> RecordEditor {
        RecordEditor {
            base_table: "track".to_owned(),
            record_id: Some("d289fa9e-8354-4e4b-9df3-5f8b64eb5304".to_owned()),
            fields: vec![
                text("title", Some("Goldregen")),
                link("album", "album", None),
                number("track_number", Some("13")),
                number("disc_number", None),
                link("file", "file", Some("e2b1c0d4-5a6f-4b8e-9c0d-1a2b3c4d5e6f")),
                text(
                    "lyrics",
                    Some("Keca ne kale balengi taje sukare jakhengi joj temerau"),
                ),
                id_field("id", Some("d289fa9e-8354-4e4b-9df3-5f8b64eb5304")),
                multi("credit", 3),
                multi("play", 19),
            ],
        }
    }

    #[test]
    fn full_form() {
        let form = sample_form();
        let mut harness = snapshot_harness::harness(egui::vec2(380.0, 340.0), move |ui| {
            form.show(ui);
        });
        harness.run();
        snapshot_dual(&mut harness, "record_editor/full_form");
    }

    #[test]
    fn field_kinds() {
        // Just the body (no toolbar), one field of each kind/value state, cropped
        // tight to the fields so the kinds' styling is easy to compare.
        let form = RecordEditor {
            base_table: "track".to_owned(),
            record_id: None,
            fields: vec![
                text("title", Some("Goldregen")),
                number("track_number", Some("13")),
                id_field("id", Some("d289fa9e-8354-4e4b-9df3-5f8b64eb5304")),
                link("album", "album", None),
                link("file", "file", Some("e2b1c0d4-5a6f-4b8e-9c0d-1a2b3c4d5e6f")),
                multi("credit", 3),
            ],
        };
        let mut harness = snapshot_harness::harness(egui::vec2(420.0, 260.0), move |ui| {
            form.body(ui);
        });
        harness.run();
        harness.fit_contents();
        snapshot_dual(&mut harness, "record_editor/field_kinds");
    }
}
