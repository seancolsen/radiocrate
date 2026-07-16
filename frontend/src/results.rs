//! The central panel: renders the current query page's result rows in a configurable
//! multi-column layout, and handles row selection and double-click-to-play.

use std::rc::Rc;

use eframe::egui;
use egui::emath::GuiRounding;
use egui::text::{LayoutJob, TextWrapping};

use crate::columns::{ColumnMetadata, FontColor, FontSize, TextAlign};
use crate::field_layout::{ColSize, FieldLayout, LayoutKey, Placement, compute_field_layout};
use crate::rows::CellValue;
use crate::theme;
use crate::{ACCENT_BLUE, App, QueryState};

/// Vertical padding above and below a row's content.
const ROW_PAD_Y: f32 = 6.0;
/// Horizontal padding on the left and right of a row's content.
const TEXT_PAD_X: f32 = 8.0;
/// Horizontal gap between adjacent columns on a line.
const COL_GAP: f32 = 16.0;

/// Background for the pills a list cell renders its elements as: a warm cream
/// (a deep warm brown on the dark theme) no other UI element uses.
const PILL_BG: theme::Duo = theme::Duo {
    light: egui::Color32::from_rgb(0xF8, 0xE4, 0xB2),
    dark: egui::Color32::from_rgb(0x5C, 0x4B, 0x1F),
};
/// Horizontal padding inside a pill, on each side of its text.
const PILL_PAD_X: f32 = 6.0;
/// Vertical padding inside a pill, above and below its text.
const PILL_PAD_Y: f32 = 2.0;
/// Horizontal gap between adjacent pills (and before the overflow bubble).
const PILL_GAP: f32 = 4.0;
/// Narrowest a truncated pill may get. When the last pill that would show can't
/// have even this much width, it is hidden and counted in the overflow bubble
/// instead — a "+N" bubble beats a sliver of a pill.
const PILL_MIN_WIDTH: f32 = 50.0;
/// Extra height a line gains when it holds a pill column: the pill's vertical
/// padding, plus a little air so adjacent rows' pills don't touch.
const PILL_LINE_EXTRA: f32 = PILL_PAD_Y * 2.0 + 2.0;
/// Padding inside the "+N" overflow bubble.
const BUBBLE_PAD: egui::Vec2 = egui::vec2(3.0, 1.0);

/// Top of an un-selected row's background gradient: white (a gray a couple of
/// steps above the dark panel fill on the dark theme — rows pop slightly
/// brighter than the surrounding chrome in both themes).
pub(crate) const ROW_BG_TOP: theme::Duo = theme::Duo {
    light: egui::Color32::WHITE,
    dark: egui::Color32::from_gray(0x30),
};
/// Bottom of an un-selected row's background gradient: slightly darker than the
/// top, giving each row a subtle top-lit sheen in both themes.
pub(crate) const ROW_BG_BOTTOM: theme::Duo = theme::Duo {
    light: egui::Color32::from_gray(0xF2),
    dark: egui::Color32::from_gray(0x26),
};

/// Background of a selected result row
const SELECTED_ROW_BG: theme::Duo = theme::Duo {
    light: egui::Color32::from_rgb(0xC8, 0xE4, 0xFF),
    dark: egui::Color32::from_rgb(0x28, 0x45, 0x63),
};
/// Opacity of the top-lit sheen gradient layered on top of a selected row's flat
/// fill, so the sheen reads without hiding the selection color underneath.
const SELECTED_ROW_GRADIENT_ALPHA: u8 = 90;

/// Text color for result-row cells while the current page's query is reloading:
/// a medium gray, applied uniformly (regardless of a column's own text color) so
/// stale-looking content reads as "loading" without hiding it.
const LOADING_TEXT_COLOR: egui::Color32 = egui::Color32::from_gray(0x90);

/// Returns `color` with its alpha channel replaced by `alpha`, leaving the RGB
/// channels untouched.
fn translucent(color: egui::Color32, alpha: u8) -> egui::Color32 {
    egui::Color32::from_rgba_unmultiplied(color.r(), color.g(), color.b(), alpha)
}

/// Fills `rect` with a vertical `top`→`bottom` color gradient.
fn paint_vertical_gradient(
    painter: &egui::Painter,
    rect: egui::Rect,
    top: egui::Color32,
    bottom: egui::Color32,
) {
    let mut mesh = egui::Mesh::default();
    mesh.colored_vertex(rect.left_top(), top);
    mesh.colored_vertex(rect.right_top(), top);
    mesh.colored_vertex(rect.left_bottom(), bottom);
    mesh.colored_vertex(rect.right_bottom(), bottom);
    mesh.add_triangle(0, 1, 2);
    mesh.add_triangle(2, 1, 3);
    painter.add(mesh);
}

impl App {
    /// Returns the memoized field layout for the given columns and width, recomputing
    /// only when the column set or available width changes.
    fn field_layout(&mut self, cols: &[ColSize], avail: f32) -> Rc<FieldLayout> {
        let key = LayoutKey::new(cols, avail, COL_GAP);
        if let Some((cached_key, layout)) = &self.field_layout_cache
            && *cached_key == key
        {
            return Rc::clone(layout);
        }
        let layout = Rc::new(compute_field_layout(cols, avail, COL_GAP));
        self.field_layout_cache = Some((key, Rc::clone(&layout)));
        layout
    }

    /// Computes the row-independent layout (visible columns, widths, line positions,
    /// fonts/colors, and the shared row height) for the current results.
    fn row_metrics(&mut self, ui: &egui::Ui, state: &QueryState) -> ResultMetrics {
        // One metadata entry per result column (defaults fill any gap), keeping only the
        // visible ones paired with their original cell index.
        let col_count = state.rows.col_count();
        let visible: Vec<(usize, ColumnMetadata)> = (0..col_count)
            .map(|i| (i, state.columns.get(i).cloned().unwrap_or_default()))
            .filter(|(_, meta)| !meta.hide)
            .collect();
        let col_sizes: Vec<ColSize> = visible
            .iter()
            .map(|(_, m)| ColSize {
                min: m.min_width,
                max: m.max_width,
            })
            .collect();

        let avail = (ui.available_width() - TEXT_PAD_X * 2.0).max(0.0);
        let layout = self.field_layout(&col_sizes, avail);

        // Per-line height = the tallest column on that line; the row's content height is
        // the sum, so every row shares one fixed height (the layout is the same for all
        // rows). Cumulative line tops drive vertical placement.
        let body_h = ui.text_style_height(&egui::TextStyle::Body);
        let small_h = ui.text_style_height(&egui::TextStyle::Small);
        let mut line_heights = vec![0.0_f32; layout.line_count];
        for (vis_idx, p) in layout.placements.iter().enumerate() {
            let (col_idx, meta) = &visible[vis_idx];
            let mut h = match meta.font_size {
                FontSize::Small => small_h,
                FontSize::Normal => body_h,
            };
            if state.rows.is_list_column(*col_idx) {
                h += PILL_LINE_EXTRA;
            }
            line_heights[p.line] = line_heights[p.line].max(h);
        }
        let mut line_tops = vec![0.0_f32; layout.line_count];
        let mut acc = 0.0;
        for (i, h) in line_heights.iter().enumerate() {
            line_tops[i] = acc;
            acc += h;
        }
        let content_h = if layout.line_count == 0 { body_h } else { acc };

        ResultMetrics {
            visible,
            layout,
            line_tops,
            line_heights,
            body_font: egui::TextStyle::Body.resolve(ui.style()),
            small_font: egui::TextStyle::Small.resolve(ui.style()),
            text_color: ui.visuals().text_color(),
            weak_color: ui.visuals().weak_text_color(),
            row_height: content_h + ROW_PAD_Y * 2.0,
        }
    }

    #[allow(clippy::too_many_lines)]
    pub(crate) fn render_results(&mut self, ui: &mut egui::Ui) {
        let Some(current_id) = self.current.query_id() else {
            return;
        };
        // Drop the panel's default inner margin so the result rows run edge to edge.
        let frame = egui::Frame::central_panel(ui.style()).inner_margin(0.0);
        let Some(results) = self.page_results(current_id) else {
            egui::CentralPanel::default()
                .frame(frame)
                .show_inside(ui, |_ui| {});
            return;
        };

        let ctx = ui.ctx().clone();
        // Whether this page has ever had a query dispatched, so a query that
        // simply hasn't run yet doesn't flash "No results" before it gets the
        // chance to.
        let fetched = self.current_page().is_some_and(|p| p.results_fetched);
        // The query's base table, used both for the "Edit {base}" context-menu
        // label and to build the record editor form when it's chosen.
        let base_table = self
            .current_page()
            .map(|p| p.live.definition.base.clone())
            .unwrap_or_default();
        egui::CentralPanel::default()
            .frame(frame)
            .show_inside(ui, |ui| {
                let state = results.lock().unwrap();

                if let Some(err) = &state.error {
                    ui.colored_label(egui::Color32::RED, err);
                }

                if state.rows.is_empty() {
                    if fetched && !state.running && state.error.is_none() {
                        ui.centered_and_justified(|ui| {
                            ui.weak("No results");
                        });
                    }
                    return;
                }

                let mut clicked: Option<(usize, egui::Modifiers)> = None;
                let mut double_clicked: Option<(usize, String)> = None;
                // A right-click that should (re)select a single row before its
                // context menu opens.
                let mut secondary_select: Option<usize> = None;
                // The row whose "Edit {base}" context-menu item was chosen, with
                // that row's record id (when the results carry one).
                let mut edit_record: Option<Option<String>> = None;

                let pending_scroll = self
                    .pending_scroll
                    .take()
                    .filter(|p| p.row < state.rows.len());
                // A "Locate"-style request (`select`) jump-selects the row; a
                // keyboard-navigation request leaves the already-updated selection
                // alone and only scrolls.
                if let Some(p) = pending_scroll
                    && p.select
                {
                    self.selection.clear();
                    self.selection.insert(p.row);
                    self.selection_anchor = Some(p.row);
                    self.selection_lead = Some(p.row);
                }
                let pending_locate = pending_scroll.map(|p| p.row);

                let metrics = self.row_metrics(ui, &state);
                let row_height = metrics.row_height;
                // While the page's query is reloading, the previous results stay
                // on screen but every column's text turns a uniform medium gray
                // (regardless of its own font color) to read as "loading".
                let (text_color, weak_color) = if state.running {
                    (LOADING_TEXT_COLOR, LOADING_TEXT_COLOR)
                } else {
                    (metrics.text_color, metrics.weak_color)
                };
                let row_layout = RowLayout {
                    visible: &metrics.visible,
                    placements: &metrics.layout.placements,
                    line_tops: &metrics.line_tops,
                    line_heights: &metrics.line_heights,
                    body_font: metrics.body_font.clone(),
                    small_font: metrics.small_font.clone(),
                    text_color,
                    weak_color,
                    row_height,
                };

                // Only highlight the now-playing row when it belongs to this page.
                let current_row = {
                    let ct = self.current_track.lock().unwrap();
                    ct.as_ref()
                        .filter(|c| c.source_page == current_id)
                        .and_then(|c| c.row_index)
                };
                let rows = &state.rows;
                let selection = &self.selection;
                let track_id_column = state.track_id_column;
                // The column identifying which record each row edits (the base
                // table's primary key) — may differ from the track-id column when
                // the query isn't track-based.
                let record_id_column = state.record_id_column;

                // Rows are drawn edge-to-edge with no inter-row spacing. `show_rows`
                // reads `item_spacing.y` *here* (before the callback) to size the
                // scrollable content, so it must be zeroed now — zeroing it only
                // inside the callback would leave the reserved height inflated by one
                // `item_spacing.y` per visible row, showing as a growing gap at the
                // bottom of the pane.
                ui.spacing_mut().item_spacing.y = 0.0;

                let mut scroll_area = egui::ScrollArea::vertical().auto_shrink([false, false]);
                if let Some(idx) = pending_locate {
                    let viewport_h = ui.available_height();
                    let target =
                        (idx as f32 * row_height) - (viewport_h - row_height).max(0.0) * 0.5;
                    scroll_area = scroll_area.vertical_scroll_offset(target.max(0.0));
                }
                scroll_area.show_rows(ui, row_height, rows.len(), |ui, range| {
                    ui.spacing_mut().item_spacing.y = 0.0;
                    for index in range {
                        let cells = rows.row_values(index);
                        let track_id = track_id_column.and_then(|i| cells.get(i)?.as_single());
                        let record_id = record_id_column.and_then(|i| cells.get(i)?.as_single());
                        let is_current = current_row == Some(index);
                        let resp = draw_row(
                            ui,
                            &row_layout,
                            &cells,
                            selection.contains(&index),
                            is_current,
                        );
                        if resp.double_clicked() {
                            if let Some(id) = track_id {
                                double_clicked = Some((index, id.to_string()));
                            }
                        } else if resp.clicked() {
                            let mods = ui.input(|i| i.modifiers);
                            clicked = Some((index, mods));
                        }

                        // The context menu is offered for a single row only: it's
                        // suppressed on a right-click that lands on one of several
                        // already-selected rows (no bulk edit yet). Any other
                        // right-click first selects that row alone, then opens.
                        let part_of_multi = selection.contains(&index) && selection.len() > 1;
                        if !part_of_multi {
                            if resp.secondary_clicked() {
                                secondary_select = Some(index);
                            }
                            let menu = egui::Popup::context_menu(&resp).show(|ui| {
                                ui.set_width(160.0);
                                crate::now_playing::menu_item(
                                    ui,
                                    crate::icons::EDIT,
                                    &format!("Edit {base_table}"),
                                    true,
                                    None,
                                )
                                .clicked()
                            });
                            if menu.is_some_and(|m| m.inner) {
                                edit_record = Some(record_id.map(str::to_string));
                            }
                        }
                    }
                });
                drop(state);

                // A right-click selects the targeted row (clearing others) before
                // its menu opens, matching the plan's single-row semantics.
                if let Some(index) = secondary_select {
                    self.selection.clear();
                    self.selection.insert(index);
                    self.selection_anchor = Some(index);
                    self.selection_lead = Some(index);
                    // Re-selecting a row for its context menu also re-points any
                    // open record editor at that row's record.
                    self.reconcile_record_editor_selection();
                }
                if let Some((index, mods)) = clicked {
                    self.handle_row_click(index, mods);
                    // A click changed the selection; keep any open record editor
                    // in step (re-point at the new record, or close on deselect).
                    self.reconcile_record_editor_selection();
                }
                if let Some((index, id)) = double_clicked {
                    self.play_track(current_id, index, &id, &ctx);
                }
                if let Some(record_id) = edit_record {
                    self.open_record_editor(&base_table, record_id);
                }
            });
    }

    pub(crate) fn handle_row_click(&mut self, index: usize, modifiers: egui::Modifiers) {
        if modifiers.shift {
            let anchor = self.selection_anchor.unwrap_or(index);
            let (lo, hi) = if anchor <= index {
                (anchor, index)
            } else {
                (index, anchor)
            };
            self.selection.clear();
            for i in lo..=hi {
                self.selection.insert(i);
            }
            self.selection_lead = Some(index);
        } else if modifiers.command || modifiers.ctrl {
            if !self.selection.remove(&index) {
                self.selection.insert(index);
            }
            self.selection_anchor = Some(index);
            self.selection_lead = Some(index);
        } else {
            self.selection.clear();
            self.selection.insert(index);
            self.selection_anchor = Some(index);
            self.selection_lead = Some(index);
        }
    }

    /// Moves the result-row selection one row down (`forward`) or up. With
    /// `extend`, grows the selection from the anchor to the new row (Shift+Arrow);
    /// otherwise selects just the new row. Clamps at the ends and scrolls the row
    /// into view. Backs the `results.select_*`/`results.extend_*` commands.
    pub(crate) fn select_row_delta(&mut self, forward: bool, extend: bool) {
        let Some(id) = self.current.query_id() else {
            return;
        };
        let Some(results) = self.page_results(id) else {
            return;
        };
        let len = results.lock().unwrap().rows.len();
        if len == 0 {
            return;
        }
        let last = len - 1;
        // Grow from the current lead (or anchor); with nothing selected yet, an
        // initial Down selects the first row and Up the last.
        let target = match self.selection_lead.or(self.selection_anchor) {
            Some(cur) if forward => (cur + 1).min(last),
            Some(cur) => cur.saturating_sub(1),
            None if forward => 0,
            None => last,
        };

        if extend {
            let anchor = self.selection_anchor.unwrap_or(target);
            self.selection_anchor = Some(anchor);
            let (lo, hi) = if anchor <= target {
                (anchor, target)
            } else {
                (target, anchor)
            };
            self.selection.clear();
            for i in lo..=hi {
                self.selection.insert(i);
            }
        } else {
            self.selection.clear();
            self.selection.insert(target);
            self.selection_anchor = Some(target);
        }
        self.selection_lead = Some(target);
        self.pending_scroll = Some(crate::PendingScroll {
            row: target,
            select: false,
        });
        // Keyboard navigation changed the selection; keep any open record editor
        // in step with the newly selected record.
        self.reconcile_record_editor_selection();
    }
}

/// Owned, row-independent layout data computed once per frame and borrowed by each row's
/// [`RowLayout`].
struct ResultMetrics {
    visible: Vec<(usize, ColumnMetadata)>,
    layout: Rc<FieldLayout>,
    line_tops: Vec<f32>,
    line_heights: Vec<f32>,
    body_font: egui::FontId,
    small_font: egui::FontId,
    text_color: egui::Color32,
    weak_color: egui::Color32,
    row_height: f32,
}

/// The row-independent layout shared by every result row: which columns go where, their
/// widths and line positions, and the fonts/colors to draw them with.
struct RowLayout<'a> {
    visible: &'a [(usize, ColumnMetadata)],
    placements: &'a [Placement],
    line_tops: &'a [f32],
    line_heights: &'a [f32],
    body_font: egui::FontId,
    small_font: egui::FontId,
    text_color: egui::Color32,
    weak_color: egui::Color32,
    row_height: f32,
}

#[allow(clippy::too_many_lines)]
fn draw_row(
    ui: &mut egui::Ui,
    layout: &RowLayout,
    cells: &[CellValue],
    selected: bool,
    is_current: bool,
) -> egui::Response {
    let desired = egui::vec2(ui.available_width(), layout.row_height);
    let (rect, response) = ui.allocate_exact_size(desired, egui::Sense::click());

    // Snap the row to the physical pixel grid before painting. Allocated rows sit at
    // fractional pixel positions, so without this the background fills (and the
    // separator) land on different subpixel offsets row-to-row, making the separators
    // render with inconsistent darkness/thickness. Consecutive rows share an exact edge,
    // so snapping keeps them gap-free.
    let ppp = ui.ctx().pixels_per_point();
    let rect = rect.round_to_pixels(ppp);

    let visuals = ui.visuals();
    let hovered = response.hovered();
    let (top, bottom) = if hovered {
        (
            theme::shade(visuals, ROW_BG_TOP.get(visuals), theme::HOVER_SHADE),
            theme::shade(visuals, ROW_BG_BOTTOM.get(visuals), theme::HOVER_SHADE),
        )
    } else {
        (ROW_BG_TOP.get(visuals), ROW_BG_BOTTOM.get(visuals))
    };
    if selected {
        // A flat blue fill (shaded a touch on hover) marks the selection, then
        // the same top-lit sheen every row gets is layered on top of it, at
        // reduced opacity so the blue still reads through.
        let base = if hovered {
            theme::shade(visuals, SELECTED_ROW_BG.get(visuals), 20)
        } else {
            SELECTED_ROW_BG.get(visuals)
        };
        ui.painter().rect_filled(rect, 0.0, base);
        paint_vertical_gradient(
            ui.painter(),
            rect,
            translucent(top, SELECTED_ROW_GRADIENT_ALPHA),
            translucent(bottom, SELECTED_ROW_GRADIENT_ALPHA),
        );
    } else {
        // Un-selected rows get a top-lit vertical gradient, nudged slightly on
        // hover so the effect stays subtle.
        paint_vertical_gradient(ui.painter(), rect, top, bottom);
    }

    if is_current && !selected {
        ui.painter().rect_filled(
            rect,
            0.0,
            egui::Color32::from_rgba_unmultiplied(46, 124, 246, 16),
        );
    }

    if is_current {
        let accent_rect =
            egui::Rect::from_min_size(rect.left_top(), egui::vec2(3.0, rect.height()));
        ui.painter()
            .rect_filled(accent_rect, 0.0, ACCENT_BLUE.get(ui.visuals()));
    }

    // Thin separator along the bottom of the row. Drawn as a pixel-aligned filled
    // rectangle (not a 1px line): the rect's edges land on physical pixel boundaries so
    // it renders crisply and identically on every row, and because it sits just *inside*
    // the row's bottom edge the next row's background fill cannot paint over it.
    // Soften the separator a touch by letting the row background show through.
    let sep_color = ui
        .visuals()
        .widgets
        .noninteractive
        .bg_stroke
        .color
        .gamma_multiply(0.5);
    let sep_h = 1.0_f32.round_to_pixels(ppp);
    let sep_rect = egui::Rect::from_min_max(
        egui::pos2(rect.left(), rect.bottom() - sep_h),
        rect.right_bottom(),
    );
    ui.painter().rect_filled(sep_rect, 0.0, sep_color);

    for (vis_idx, (col_idx, meta)) in layout.visible.iter().enumerate() {
        let placement = layout.placements[vis_idx];
        let font = match meta.font_size {
            FontSize::Small => layout.small_font.clone(),
            FontSize::Normal => layout.body_font.clone(),
        };
        let color = match meta.font_color {
            FontColor::Light => layout.weak_color,
            FontColor::Default => layout.text_color,
        };
        let cell_left = rect.left() + TEXT_PAD_X + placement.x;
        let line_top = rect.top() + ROW_PAD_Y + layout.line_tops[placement.line];
        let line_height = layout.line_heights[placement.line];

        if let Some(CellValue::List(items)) = cells.get(*col_idx) {
            let cell = Cell {
                meta,
                font,
                color,
                left: cell_left,
                width: placement.width.max(0.0),
                line_top,
                line_height,
            };
            draw_pills(ui, &cell, items);
            continue;
        }

        let value = cells
            .get(*col_idx)
            .and_then(CellValue::as_single)
            .unwrap_or("");
        let text = display_text(meta, value);
        let format = egui::TextFormat {
            font_id: font,
            color,
            ..Default::default()
        };
        let mut job = LayoutJob::single_section(text, format);
        job.wrap = TextWrapping::truncate_at_width(placement.width.max(0.0));
        let galley = ui.painter().layout_job(job);
        let size = galley.size();

        let slack = (placement.width - size.x).max(0.0);
        let x = match meta.text_align {
            TextAlign::Left => cell_left,
            TextAlign::Right => cell_left + slack,
            TextAlign::Center => cell_left + slack * 0.5,
        };
        let y = line_top + (line_height - size.y) * 0.5;
        ui.painter().galley(egui::pos2(x, y), galley, color);
    }

    response
}

/// Applies the column's formatter and prefix/suffix to one raw cell value.
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

/// One cell's resolved drawing parameters, shared by the pill-drawing helpers.
struct Cell<'a> {
    meta: &'a ColumnMetadata,
    font: egui::FontId,
    color: egui::Color32,
    left: f32,
    width: f32,
    line_top: f32,
    line_height: f32,
}

/// Decides how many pills fit into `width`: walks the count down from "all of
/// them", reserving overflow-bubble room whenever any are hidden, and truncating
/// the last visible pill into whatever width remains (but never below
/// [`PILL_MIN_WIDTH`] — a "+N" bubble beats a sliver of a pill). `natural` holds
/// each pill's untruncated width; `layout_bubble` lays out the "+N" text for a
/// hidden count. Returns the count shown, the last shown pill's (possibly
/// truncated) width, and the bubble galley when any pills are hidden.
fn fit_pills(
    width: f32,
    natural: &[f32],
    layout_bubble: &dyn Fn(usize) -> std::sync::Arc<egui::Galley>,
) -> (usize, f32, Option<std::sync::Arc<egui::Galley>>) {
    let mut shown = natural.len();
    while shown > 0 {
        let hidden = natural.len() - shown;
        let (bubble, bubble_w) = if hidden == 0 {
            (None, 0.0)
        } else {
            let g = layout_bubble(hidden);
            let w = g.size().x + BUBBLE_PAD.x * 2.0 + PILL_GAP;
            (Some(g), w)
        };
        let preceding: f32 =
            natural[..shown - 1].iter().sum::<f32>() + PILL_GAP * (shown - 1) as f32;
        let remaining = width - bubble_w - preceding;
        if remaining >= natural[shown - 1] {
            return (shown, natural[shown - 1], bubble);
        }
        if remaining >= PILL_MIN_WIDTH {
            return (shown, remaining, bubble);
        }
        shown -= 1;
    }
    (0, 0.0, Some(layout_bubble(natural.len())))
}

/// Draws a list cell's elements as a row of pills. Pills that don't fit are
/// summarized by a "+N" superscript bubble on the right; when the last visible
/// pill is too wide for its remaining space, its text truncates instead (down to
/// [`PILL_MIN_WIDTH`], below which the pill is dropped into the bubble's count).
fn draw_pills(ui: &egui::Ui, cell: &Cell, items: &[String]) {
    if items.is_empty() || cell.width <= 0.0 {
        return;
    }

    let format = egui::TextFormat {
        font_id: cell.font.clone(),
        color: cell.color,
        ..Default::default()
    };
    // Never paint outside the cell (a lone overflow bubble can still be wider
    // than a very narrow cell).
    let clip = egui::Rect::from_min_size(
        egui::pos2(cell.left, cell.line_top),
        egui::vec2(cell.width, cell.line_height),
    );
    let painter = ui.painter().with_clip_rect(clip);

    // Natural (untruncated) galley and pill width for each element.
    let texts: Vec<String> = items.iter().map(|i| display_text(cell.meta, i)).collect();
    let galleys: Vec<_> = texts
        .iter()
        .map(|t| painter.layout_job(LayoutJob::single_section(t.clone(), format.clone())))
        .collect();
    let natural: Vec<f32> = galleys
        .iter()
        .map(|g| g.size().x + PILL_PAD_X * 2.0)
        .collect();

    // The overflow bubble's galley and outer width (including its leading gap)
    // for a given hidden count.
    let bubble_font = egui::FontId {
        size: cell.font.size * 0.8,
        family: cell.font.family.clone(),
    };
    let layout_bubble = |hidden: usize| {
        let format = egui::TextFormat {
            font_id: bubble_font.clone(),
            color: cell.color,
            ..Default::default()
        };
        painter.layout_job(LayoutJob::single_section(format!("+{hidden}"), format))
    };

    let (shown, last_width, bubble) = fit_pills(cell.width, &natural, &layout_bubble);

    // Total width actually used, for text-align slack.
    let pills_w: f32 = natural[..shown.saturating_sub(1)].iter().sum::<f32>()
        + last_width
        + PILL_GAP * shown.saturating_sub(1) as f32;
    let bubble_w = bubble.as_ref().map_or(0.0, |g| {
        let gap = if shown == 0 { 0.0 } else { PILL_GAP };
        g.size().x + BUBBLE_PAD.x * 2.0 + gap
    });
    let slack = (cell.width - pills_w - bubble_w).max(0.0);
    let mut x = cell.left
        + match cell.meta.text_align {
            TextAlign::Left => 0.0,
            TextAlign::Right => slack,
            TextAlign::Center => slack * 0.5,
        };

    let font_h = galleys.iter().map(|g| g.size().y).fold(0.0, f32::max);
    let pill_h = font_h + PILL_PAD_Y * 2.0;
    let pill_top = cell.line_top + (cell.line_height - pill_h) * 0.5;
    for i in 0..shown {
        let w = if i == shown - 1 {
            last_width
        } else {
            natural[i]
        };
        let pill_rect = egui::Rect::from_min_size(egui::pos2(x, pill_top), egui::vec2(w, pill_h));
        painter.rect_filled(pill_rect, crate::button::RADIUS, PILL_BG.get(ui.visuals()));
        let galley = if w < natural[i] {
            let mut job = LayoutJob::single_section(texts[i].clone(), format.clone());
            job.wrap = TextWrapping::truncate_at_width((w - PILL_PAD_X * 2.0).max(0.0));
            painter.layout_job(job)
        } else {
            galleys[i].clone()
        };
        let y = pill_top + (pill_h - galley.size().y) * 0.5;
        painter.galley(egui::pos2(x + PILL_PAD_X, y), galley, cell.color);
        x += w + PILL_GAP;
    }

    if let Some(galley) = bubble {
        // Superscript: the bubble hugs the top of the line instead of centering.
        let size = galley.size() + BUBBLE_PAD * 2.0;
        let rect = egui::Rect::from_min_size(egui::pos2(x, cell.line_top), size);
        painter.rect_filled(
            rect,
            size.y * 0.5,
            theme::shade(ui.visuals(), PILL_BG.get(ui.visuals()), 30),
        );
        painter.galley(rect.min + BUBBLE_PAD, galley, cell.color);
    }
}
