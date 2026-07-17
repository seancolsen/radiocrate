//! The modal record picker: a search-as-you-type overlay for choosing (or
//! scaffolding) the record a scalar-link field points at.
//!
//! Opened from a scalar-link field (its pencil when NULL, or the "Pick a record"
//! menu item), it lists the target table's records — filtered by a Querydown
//! expression the user types — and, on pick, hands the whole loaded row back to the
//! form as an embedded preview so no follow-up request is needed. The display and
//! sort come from the same dynamic [`display_gen`] heuristic used for embedded
//! previews, so the picker needs no sort/display configuration UI.
//!
//! Like the command palette, the filter field keeps focus the whole time and the
//! picker handles its own Up/Down/Enter navigation (consumed before the field sees
//! them). Each keystroke dispatches a fresh query tagged with a monotonic
//! generation; only the latest generation's response is rendered, so stale
//! in-flight searches are ignored without any cancellation bookkeeping.

use std::sync::{Arc, Mutex};

use eframe::egui::{self, Key, Modifiers};
use introspection::Schema;

use crate::App;
use crate::button::Button;
use crate::columns::ColumnMetadata;
use crate::compile;
use crate::display_gen;
use crate::form::{self, FormPath, RecordDisplay};
use crate::http;
use crate::icons;
use crate::query_def::{CompileSource, QuerySections};
use crate::rows::CellValue;

/// A finished picker search, tagged with the generation it was dispatched for so a
/// superseded keystroke's response can be dropped on arrival.
struct PickerLoad {
    generation: u64,
    outcome: Result<(Vec<ColumnMetadata>, crate::rows::ResultRows), String>,
}

/// The modal record picker's state while open.
pub(crate) struct RecordPicker {
    /// Identifies the editor this picker belongs to ([`form::RecordEditor::key_string`]);
    /// a pick is discarded if the open editor no longer matches (the user switched
    /// records out from under the modal).
    editor_key: String,
    /// The scalar-link field the picked record flows into.
    field_path: FormPath,
    /// The target table being searched (e.g. `album`).
    target: String,
    /// The user's Querydown filter text.
    filter: String,
    /// The last filter text dispatched; `None` forces the initial query on open.
    last_dispatched: Option<String>,
    /// Monotonic search generation; the latest wins and older responses are ignored.
    generation: u64,
    /// The highlighted result row.
    selected: usize,
    /// The row last scrolled into view, so a settled modal doesn't repaint forever.
    scrolled_to: Option<usize>,
    /// The slot the async search writes its result into.
    result: Arc<Mutex<Option<PickerLoad>>>,
}

/// Owned, render-ready snapshot of the current search result, extracted from the
/// shared slot so the render doesn't hold the lock (nor borrow the picker through it).
enum RenderData {
    Loading,
    Empty,
    Error(String),
    Rows {
        columns: Vec<ColumnMetadata>,
        rows: Vec<Vec<CellValue>>,
    },
}

impl RenderData {
    fn len(&self) -> usize {
        match self {
            RenderData::Rows { rows, .. } => rows.len(),
            _ => 0,
        }
    }
}

impl App {
    /// Opens the modal record picker for the scalar-link field at `field_path`,
    /// searching records of `target`. `editor_key` pins it to the editor it was
    /// opened from.
    pub(crate) fn open_record_picker(
        &mut self,
        field_path: FormPath,
        target: String,
        editor_key: String,
    ) {
        self.record_picker = Some(RecordPicker {
            editor_key,
            field_path,
            target,
            filter: String::new(),
            last_dispatched: None,
            generation: 0,
            selected: 0,
            scrolled_to: None,
            result: Arc::new(Mutex::new(None)),
        });
    }

    /// Renders the modal record picker when open, running the search live as the
    /// user types, and on pick/new-record mutating the owning editor before closing.
    /// Escape, the backdrop, or the X close it leaving the form untouched.
    #[allow(clippy::too_many_lines)]
    pub(crate) fn render_record_picker_modal(&mut self, ctx: &egui::Context) {
        let Some(mut picker) = self.record_picker.take() else {
            return;
        };

        // Search as the user types: dispatch a fresh query whenever the filter text
        // changes (and once on open, when `last_dispatched` is `None`).
        if picker.last_dispatched.as_deref() != Some(picker.filter.as_str()) {
            picker.last_dispatched = Some(picker.filter.clone());
            self.dispatch_picker_search(&mut picker, ctx);
        }

        // Snapshot the (live-generation) result so the render never holds the lock.
        let render = {
            let guard = picker.result.lock().unwrap();
            match guard.as_ref() {
                Some(load) if load.generation == picker.generation => match &load.outcome {
                    Ok((_, rows)) if rows.is_empty() => RenderData::Empty,
                    Ok((columns, rows)) => RenderData::Rows {
                        columns: columns.clone(),
                        rows: (0..rows.len()).map(|r| rows.row_values(r)).collect(),
                    },
                    Err(e) => RenderData::Error(e.clone()),
                },
                _ => RenderData::Loading,
            }
        };
        let n = render.len();
        if picker.selected >= n {
            picker.selected = n.saturating_sub(1);
        }

        let mut chosen_row: Option<usize> = None;
        let mut new_record = false;
        let mut close = false;

        // Handle navigation before the filter field can see these keys, so Up/Down
        // move the highlight and Enter picks — without moving focus off the input.
        ctx.input_mut(|i| {
            if n > 0 && i.consume_key(Modifiers::NONE, Key::ArrowDown) {
                picker.selected = (picker.selected + 1) % n;
            }
            if n > 0 && i.consume_key(Modifiers::NONE, Key::ArrowUp) {
                picker.selected = (picker.selected + n - 1) % n;
            }
            if n > 0 && i.consume_key(Modifiers::NONE, Key::Enter) {
                chosen_row = Some(picker.selected);
            }
        });

        let scroll_to = (picker.scrolled_to != Some(picker.selected)).then_some(picker.selected);
        let modal = egui::Modal::new(egui::Id::new("record_picker")).show(ctx, |ui| {
            ui.set_width(520.0);

            // Title bar: "Pick {table}" with a close (X) on the right.
            ui.horizontal(|ui| {
                ui.heading(format!("Pick {}", picker.target));
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if Button::icon(icons::CLOSE).show(ui).clicked() {
                        close = true;
                    }
                });
            });
            ui.add_space(6.0);

            // Filter input: single-line (so no newlines), kept focused every frame.
            let output = crate::text_input::show(
                ui,
                egui::TextEdit::singleline(&mut picker.filter)
                    .hint_text("Filter…")
                    .desired_width(f32::INFINITY),
            );
            output.response.request_focus();
            ui.add_space(6.0);

            match &render {
                RenderData::Loading => {
                    ui.horizontal(|ui| {
                        ui.spinner();
                        ui.weak("Searching…");
                    });
                }
                RenderData::Empty => {
                    ui.weak("No matching records");
                }
                RenderData::Error(e) => {
                    ui.colored_label(egui::Color32::RED, e);
                }
                RenderData::Rows { columns, rows } => {
                    egui::ScrollArea::vertical()
                        .max_height(360.0)
                        .auto_shrink([false, true])
                        .show(ui, |ui| {
                            ui.spacing_mut().item_spacing.y = 3.0;
                            for (r, cells) in rows.iter().enumerate() {
                                let selected = r == picker.selected;
                                let resp = form::render_picker_result(ui, columns, cells, selected);
                                if selected && scroll_to == Some(r) {
                                    resp.scroll_to_me(Some(egui::Align::Center));
                                }
                                if resp.clicked() {
                                    chosen_row = Some(r);
                                } else if resp.hovered()
                                    && ctx.input(|i| i.pointer.velocity() != egui::Vec2::ZERO)
                                {
                                    picker.selected = r;
                                }
                            }
                        });
                }
            }

            ui.add_space(10.0);
            ui.separator();
            ui.add_space(4.0);
            if ui.button("New record").clicked() {
                new_record = true;
            }
        });
        picker.scrolled_to = Some(picker.selected);

        if modal.should_close() {
            close = true;
        }

        if let Some(row) = chosen_row {
            self.apply_picked_record(&picker, row);
            close = true;
        } else if new_record {
            self.picker_new_record(&picker);
            close = true;
        }

        // Leaving `picker` dropped keeps the modal closed.
        if !close {
            self.record_picker = Some(picker);
        }
    }

    /// Compiles and streams the picker's search: the user's filter combined with the
    /// dynamically-generated display (with the record's `id` prepended so a pick
    /// carries its key) and sort for `target`. Tags the response with the current
    /// generation.
    fn dispatch_picker_search(&mut self, picker: &mut RecordPicker, ctx: &egui::Context) {
        picker.generation += 1;
        let generation = picker.generation;
        let result = Arc::clone(&picker.result);

        let schema_json = self.schema.lock().unwrap().clone();
        let compiled = match schema_json
            .as_deref()
            .and_then(|json| Schema::parse(json).ok().map(|schema| (json, schema)))
        {
            Some((json, schema)) => {
                let generated = display_gen::generate(&schema, &picker.target, None);
                let source = CompileSource::Sections(QuerySections {
                    base: picker.target.clone(),
                    filter: picker.filter.clone(),
                    sort: generated.sort,
                    display: format!("$id {}", generated.display),
                });
                compile::querydown_to_duckdb(&source, json)
            }
            None => Err("Schema not loaded yet. Please try again in a moment.".to_string()),
        };

        match compiled {
            Ok(compiled) => {
                let columns = compiled.columns;
                let ctx = ctx.clone();
                http::load_rows(compiled.sql, move |res| {
                    *result.lock().unwrap() = Some(PickerLoad {
                        generation,
                        outcome: res.map(|rows| (columns, rows)),
                    });
                    ctx.request_repaint();
                });
            }
            Err(e) => {
                *result.lock().unwrap() = Some(PickerLoad {
                    generation,
                    outcome: Err(e),
                });
            }
        }
    }

    /// Submits the picked result `row` into the owning editor's scalar-link field:
    /// its `id` (from the prepended id column) points the link, and the single loaded
    /// row becomes the embedded preview (id column hidden). A no-op if the open
    /// editor no longer matches the one the picker was opened from.
    fn apply_picked_record(&mut self, picker: &RecordPicker, row: usize) {
        let chosen = {
            let guard = picker.result.lock().unwrap();
            match guard.as_ref() {
                Some(load) if load.generation == picker.generation => match &load.outcome {
                    Ok((columns, rows)) => {
                        let id = rows.cell_text(row, 0);
                        let mut columns = columns.clone();
                        // The prepended id column carries the key but isn't shown.
                        if let Some(first) = columns.first_mut() {
                            first.hide = true;
                        }
                        Some((
                            id,
                            RecordDisplay {
                                columns,
                                rows: rows.single_row(row),
                            },
                        ))
                    }
                    Err(_) => None,
                },
                _ => None,
            }
        };
        let Some((id, display)) = chosen else {
            return;
        };
        if let Some(editor) = self
            .current_page_mut()
            .and_then(|p| p.record_editor.as_mut())
            .filter(|e| e.key_string() == picker.editor_key)
        {
            editor.apply_picked_record(&picker.field_path, id, display);
        }
    }

    /// Scaffolds a brand-new linked record in the owning editor's scalar-link field,
    /// copying the picker's filter text into its first editable field. A no-op if the
    /// schema isn't loaded or the open editor no longer matches.
    fn picker_new_record(&mut self, picker: &RecordPicker) {
        let Some(schema_json) = self.schema.lock().unwrap().clone() else {
            return;
        };
        let Ok(schema) = Schema::parse(&schema_json) else {
            return;
        };
        if let Some(editor) = self
            .current_page_mut()
            .and_then(|p| p.record_editor.as_mut())
            .filter(|e| e.key_string() == picker.editor_key)
        {
            editor.add_new_linked_record(&picker.field_path, &schema, picker.filter.clone());
        }
    }
}
