//! The tab bar: VS Code-style editor tabs for the open query pages.
//!
//! Laid out left to right as the explorer toggle, the tab handles, and a "+"
//! button that opens a new unsaved query. Each handle shows (for an unpinned tab)
//! a pin button, then a query icon, the query name, an unsaved marker, and an
//! always-visible close button. Handles size to their content but shrink — widest
//! first, truncating the name — when the row runs out of room. They can be
//! renamed (double-click), closed (middle-click or the ×), reordered (drag), and
//! carry the same context menu as the toolbar's options menu.

use std::sync::{Arc, Mutex};

use eframe::egui;
use uuid::Uuid;

use crate::button::Button;
use crate::icons;
use crate::menu_bar::{PageMenu, page_options_menu};
use crate::page::{explorer_button, inline_rename_field};
use crate::results::darken;
use crate::skew::{ITALIC_SHEAR, paint_galley_skewed};
use crate::{App, Rename, RenameSurface};

/// Height of the tab bar (and thus of a full-height tab handle).
const TAB_BAR_HEIGHT: f32 = 34.0;
/// Padding inside a tab handle: left of the first item, right of the close button.
const PAD_L: f32 = 8.0;
const PAD_R: f32 = 6.0;
/// Gap between the query icon and the name.
const ICON_GAP: f32 = 5.0;
/// Gap between the other adjacent items (pin↔icon, name↔close).
const ITEM_GAP: f32 = 4.0;
/// Square hit/paint area for the pin and close buttons.
const PIN_W: f32 = 16.0;
const CLOSE_W: f32 = 18.0;
/// Width reserved for the query icon glyph.
const ICON_W: f32 = 16.0;
/// Smallest name area a tab shrinks to before it stops shrinking (enough for a
/// character or two plus the ellipsis).
const MIN_NAME: f32 = 26.0;
/// Icon glyph point size inside a handle.
const GLYPH_SIZE: f32 = 15.0;

/// Tab-bar interaction state that must persist across frames.
#[derive(Default)]
pub(crate) struct TabBar {
    /// The in-progress drag-to-reorder, if any.
    drag: Option<TabDrag>,
}

/// A tab handle being dragged to a new position.
struct TabDrag {
    /// The dragged tab's query id.
    id: Uuid,
    /// Pointer x minus the handle's left edge at grab time, so the handle tracks
    /// the pointer without jumping to it.
    grab_offset: f32,
}

/// Everything the tab strip needs to render one handle, snapshotted from the
/// page so the draw closure doesn't borrow `self`.
#[allow(clippy::struct_excessive_bools)]
struct TabInfo {
    id: Uuid,
    name: String,
    pinned: bool,
    unsaved: bool,
    // Per-tab options-menu parameters, so a handle's context menu matches the
    // toolbar menu for *that* query.
    base_table: String,
    full_mode: bool,
    show_revert: bool,
}

/// Deferred outcomes of a tab-bar frame, applied after its draw closure releases
/// its borrow of `self`.
#[allow(clippy::struct_excessive_bools)]
#[derive(Default)]
struct TabActions {
    toggle_explorer: bool,
    add: bool,
    select: Option<Uuid>,
    close: Option<Uuid>,
    pin_toggle: Option<Uuid>,
    rename: Option<Uuid>,
    rename_commit: bool,
    rename_cancel: bool,
    reorder: Option<(Uuid, usize)>,
    menu: Option<(Uuid, PageMenu)>,
    drag_start: Option<(Uuid, f32)>,
    drag_end: bool,
}

impl App {
    /// Renders the tab bar as a top panel above the query toolbar. It spans the
    /// area right of the explorer sidebar (which is added first and reserves its
    /// own column), never over it.
    pub(crate) fn render_tab_bar(&mut self, ui: &mut egui::Ui) {
        let panel_fill = ui.style().visuals.panel_fill;
        let bar_fill = darken(panel_fill, 10);
        let organizer_open = self.organizer.open;
        let current = self.current.query_id();
        let schema = Arc::clone(&self.schema);

        let tabs: Vec<TabInfo> = self
            .pages
            .iter()
            .map(|p| TabInfo {
                id: p.live.id,
                name: p.live.name.clone(),
                pinned: p.pinned,
                unsaved: p.unsaved(),
                base_table: p.live.definition.base.clone(),
                full_mode: p.live.definition.is_full(),
                show_revert: p.is_persisted() && p.unsaved(),
            })
            .collect();

        // Snapshot the drag so the closure can lay out without borrowing `self`.
        let drag = self.tab_bar.drag.as_ref().map(|d| DragSnapshot {
            id: d.id,
            grab_offset: d.grab_offset,
        });
        let rename = &mut self.rename;
        let mut actions = TabActions::default();

        egui::Panel::top("tab_bar")
            .exact_size(TAB_BAR_HEIGHT)
            .show_separator_line(false)
            .frame(
                egui::Frame::new()
                    .fill(bar_fill)
                    .inner_margin(egui::Margin::same(0)),
            )
            .show_inside(ui, |ui| {
                ui.with_layout(egui::Layout::left_to_right(egui::Align::Center), |ui| {
                    ui.spacing_mut().item_spacing.x = 0.0;
                    ui.add_space(6.0);
                    if explorer_button(ui, organizer_open) {
                        actions.toggle_explorer = true;
                    }
                    ui.add_space(4.0);

                    // The strip takes the room between the explorer toggle and the
                    // "+" button; the tabs lay out (and shrink) inside it. Sized to
                    // the tabs' natural total width (so the "+" button sits right
                    // after the last handle) unless that exceeds the available
                    // room, in which case it fills the room and the handles shrink.
                    let avail = (ui.available_width() - crate::button::SIZE - 6.0).max(0.0);
                    let font = egui::TextStyle::Body.resolve(ui.style());
                    let natural_total: f32 = tabs
                        .iter()
                        .map(|info| fixed_width(info) + natural_name_width(ui, info, &font))
                        .sum();
                    let strip_w = natural_total.min(avail);
                    let (strip_rect, _) = ui.allocate_exact_size(
                        egui::vec2(strip_w, TAB_BAR_HEIGHT),
                        egui::Sense::hover(),
                    );
                    draw_tab_strip(
                        ui,
                        strip_rect,
                        &tabs,
                        current,
                        rename,
                        drag,
                        panel_fill,
                        bar_fill,
                        &schema,
                        &mut actions,
                    );

                    ui.add_space(2.0);
                    if Button::icon(icons::ADD).show(ui).clicked() {
                        actions.add = true;
                    }
                });
            });

        self.apply_tab_actions(actions, ui.ctx());
    }

    fn apply_tab_actions(&mut self, actions: TabActions, ctx: &egui::Context) {
        // Commit/cancel an in-progress rename before starting another one.
        if actions.rename_commit {
            self.commit_rename();
        }
        if actions.rename_cancel {
            self.cancel_rename();
        }
        if actions.toggle_explorer {
            self.organizer.open = !self.organizer.open;
        }
        if actions.add {
            self.add_query_page();
        }
        if let Some(id) = actions.select {
            self.select_page(id);
        }
        if let Some(id) = actions.pin_toggle {
            self.toggle_pin(id);
        }
        if let Some(id) = actions.rename {
            self.begin_rename(id, RenameSurface::Tab);
        }
        if let Some((id, to)) = actions.reorder {
            self.move_tab(id, to);
            // Dragging a tab to reorder it is a deliberate "keep this open" act,
            // like pinning; an unpinned (preview) tab wouldn't survive being
            // replaced by the next opened query otherwise.
            self.pin_tab(id);
        }
        if let Some((id, offset)) = actions.drag_start {
            self.tab_bar.drag = Some(TabDrag {
                id,
                grab_offset: offset,
            });
        }
        if actions.drag_end {
            self.tab_bar.drag = None;
        }
        // Applied last: closing may drop the current tab and change navigation.
        if let Some(id) = actions.close {
            self.close_tab(id);
        }
        if let Some((id, choice)) = actions.menu {
            self.apply_page_menu(choice, id, ctx);
        }
    }
}

/// The subset of [`TabDrag`] the draw closure needs.
struct DragSnapshot {
    id: Uuid,
    grab_offset: f32,
}

/// The non-name ("fixed") width of a handle: everything but the query name.
fn fixed_width(info: &TabInfo) -> f32 {
    let pin = if info.pinned { 0.0 } else { PIN_W + ITEM_GAP };
    PAD_L + pin + ICON_W + ICON_GAP + ITEM_GAP + CLOSE_W + PAD_R
}

/// The natural width of the name area (full name plus, when unsaved, the trailing
/// marker), laid out without truncation.
fn natural_name_width(ui: &egui::Ui, info: &TabInfo, font: &egui::FontId) -> f32 {
    let mut job = egui::text::LayoutJob::single_section(
        info.name.clone(),
        egui::TextFormat {
            font_id: font.clone(),
            ..Default::default()
        },
    );
    job.wrap = egui::text::TextWrapping::no_max_width();
    let mut w = ui.painter().layout_job(job).size().x;
    if info.unsaved {
        w += crate::page::MARKER_GAP + crate::page::UNSAVED_MARKER_SIZE;
    }
    w
}

/// Distributes `avail` across tabs whose natural widths are `naturals`, shrinking
/// the widest first: tabs keep their natural width until the total exceeds
/// `avail`, at which point every tab is capped at the largest width `c` for which
/// `Σ min(natural, c) ≤ avail`. Narrow tabs are untouched; only tabs wider than
/// the cap shrink (and get truncated). Returns one width per tab, in order.
fn tab_widths(naturals: &[f32], avail: f32) -> Vec<f32> {
    let total: f32 = naturals.iter().sum();
    if naturals.is_empty() || total <= avail {
        return naturals.to_vec();
    }
    let max = naturals.iter().copied().fold(0.0_f32, f32::max);
    let (mut lo, mut hi) = (0.0_f32, max);
    for _ in 0..40 {
        let cap = 0.5 * (lo + hi);
        let sum: f32 = naturals.iter().map(|n| n.min(cap)).sum();
        if sum > avail {
            hi = cap;
        } else {
            lo = cap;
        }
    }
    naturals.iter().map(|n| n.min(lo)).collect()
}

/// Lays out and draws the tab handles inside `strip_rect`, folding every
/// interaction into `actions`.
#[allow(clippy::too_many_arguments, clippy::needless_pass_by_value)]
fn draw_tab_strip(
    ui: &mut egui::Ui,
    strip_rect: egui::Rect,
    tabs: &[TabInfo],
    current: Option<Uuid>,
    rename: &mut Option<Rename>,
    drag: Option<DragSnapshot>,
    panel_fill: egui::Color32,
    bar_fill: egui::Color32,
    schema: &Arc<Mutex<Option<String>>>,
    actions: &mut TabActions,
) {
    if tabs.is_empty() {
        return;
    }
    let font = egui::TextStyle::Body.resolve(ui.style());

    // Water-fill the handle widths to the strip, flooring each at its minimum.
    let fixed: Vec<f32> = tabs.iter().map(fixed_width).collect();
    let naturals: Vec<f32> = tabs
        .iter()
        .zip(&fixed)
        .map(|(info, f)| f + natural_name_width(ui, info, &font))
        .collect();
    let mut widths = tab_widths(&naturals, strip_rect.width());
    for (w, f) in widths.iter_mut().zip(&fixed) {
        *w = w.max(f + MIN_NAME);
    }

    // Slot x-positions in tab order.
    let mut slot_x = Vec::with_capacity(tabs.len());
    let mut x = strip_rect.left();
    for w in &widths {
        slot_x.push(x);
        x += w;
    }

    let dragged = drag
        .as_ref()
        .and_then(|d| tabs.iter().position(|t| t.id == d.id));

    // Keep painting within the strip so an overflowing/dragged handle can't spill
    // over the "+" button or the explorer toggle.
    let clip = ui.clip_rect();
    ui.set_clip_rect(strip_rect.intersect(clip));

    // Draw the settled (non-dragged) handles first, then the dragged one on top.
    for (i, info) in tabs.iter().enumerate() {
        if Some(i) == dragged {
            continue;
        }
        let rect = egui::Rect::from_min_size(
            egui::pos2(slot_x[i], strip_rect.top()),
            egui::vec2(widths[i], strip_rect.height()),
        );
        draw_one_tab(
            ui,
            info,
            rect,
            fixed[i],
            current == Some(info.id),
            false,
            rename,
            panel_fill,
            bar_fill,
            schema,
            actions,
        );
    }

    if let (Some(d), Some(snap)) = (dragged, drag.as_ref()) {
        let w = widths[d];
        // Follow the pointer, clamped so the handle stays within the strip.
        let pointer_x = ui
            .input(|i| i.pointer.interact_pos())
            .map_or(slot_x[d], |p| p.x);
        let left = (pointer_x - snap.grab_offset).clamp(
            strip_rect.left(),
            (strip_rect.right() - w).max(strip_rect.left()),
        );
        let rect = egui::Rect::from_min_size(
            egui::pos2(left, strip_rect.top()),
            egui::vec2(w, strip_rect.height()),
        );
        draw_one_tab(
            ui,
            &tabs[d],
            rect,
            fixed[d],
            current == Some(tabs[d].id),
            true,
            rename,
            panel_fill,
            bar_fill,
            schema,
            actions,
        );

        // Reorder: place the dragged handle where its center now sits among the
        // other handles (computed on the reflowed layout without it).
        let center = left + w / 2.0;
        let mut target = 0;
        let mut cx = strip_rect.left();
        for (i, wi) in widths.iter().enumerate() {
            if i == d {
                continue;
            }
            if center > cx + wi / 2.0 {
                target += 1;
            }
            cx += wi;
        }
        if target != d {
            actions.reorder = Some((tabs[d].id, target));
        }
    }

    ui.set_clip_rect(clip);
}

/// Draws a single tab handle in `rect` and folds its interactions into `actions`.
#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
fn draw_one_tab(
    ui: &mut egui::Ui,
    info: &TabInfo,
    rect: egui::Rect,
    fixed: f32,
    selected: bool,
    dragged: bool,
    rename: &mut Option<Rename>,
    panel_fill: egui::Color32,
    bar_fill: egui::Color32,
    schema: &Arc<Mutex<Option<String>>>,
    actions: &mut TabActions,
) {
    // Body interaction underneath the pin/close buttons (interacted after, so
    // they sit on top and steal their own clicks).
    let body = ui.interact(
        rect,
        egui::Id::new(("tab", info.id)),
        egui::Sense::click_and_drag(),
    );

    // Only the top corners are rounded (matching the app's buttons), so the
    // handle still sits flush against the tab bar below and its neighbors beside.
    let top_radius = crate::button::RADIUS as u8;
    let corner = egui::CornerRadius {
        nw: top_radius,
        ne: top_radius,
        sw: 0,
        se: 0,
    };

    // Background: the active tab is filled like the editor (it "connects" to the
    // content below); inactive tabs sit in the bar color, darkening on hover.
    let fill = if selected {
        panel_fill
    } else if body.hovered() {
        darken(bar_fill, 8)
    } else {
        bar_fill
    };
    ui.painter().rect_filled(rect, corner, fill);
    if selected {
        // A blue top edge marks the active tab, like an editor's active tab.
        // Rounded to match the handle's top corners, so it doesn't square them
        // off again.
        ui.painter().rect_filled(
            egui::Rect::from_min_size(rect.left_top(), egui::vec2(rect.width(), 4.0)),
            corner,
            crate::HOVER_BLUE,
        );
    }
    if dragged {
        // Lift the dragged handle with a hairline outline so it reads as floating.
        ui.painter().rect_stroke(
            rect,
            corner,
            egui::Stroke::new(1.0, crate::HOVER_BLUE),
            egui::StrokeKind::Inside,
        );
    }
    // Right-edge separator between handles.
    ui.painter().line_segment(
        [rect.right_top(), rect.right_bottom()],
        egui::Stroke::new(1.0, darken(bar_fill, 22)),
    );

    // Inactive tabs read as secondary: their icon and name dim to the weak text
    // color. Hover feedback on the pin/close buttons always uses full-strength
    // text, regardless of the tab's active state.
    let icon_color = if selected {
        icons::DEFAULT_COLOR
    } else {
        ui.visuals().weak_text_color()
    };
    let text_color = if selected {
        ui.visuals().text_color()
    } else {
        ui.visuals().weak_text_color()
    };
    let hover_color = ui.visuals().text_color();
    let mut cursor = rect.left() + PAD_L;

    // Unpinned tabs get a pin button at the far left (click to keep the tab).
    if !info.pinned {
        let pin_rect = egui::Rect::from_center_size(
            egui::pos2(cursor + PIN_W / 2.0, rect.center().y),
            egui::vec2(PIN_W, PIN_W),
        );
        let pin = ui.interact(
            pin_rect,
            egui::Id::new(("tab-pin", info.id)),
            egui::Sense::click(),
        );
        let tint = if pin.hovered() {
            crate::HOVER_BLUE
        } else {
            icon_color
        };
        ui.painter().text(
            pin_rect.center(),
            egui::Align2::CENTER_CENTER,
            icons::PIN.codepoint,
            icons::font_id(GLYPH_SIZE - 1.0),
            tint,
        );
        if pin.clicked() {
            actions.pin_toggle = Some(info.id);
        }
        cursor += PIN_W + ITEM_GAP;
    }

    // Query icon.
    ui.painter().text(
        egui::pos2(cursor, rect.center().y),
        egui::Align2::LEFT_CENTER,
        icons::QUERY.codepoint,
        icons::font_id(GLYPH_SIZE),
        icon_color,
    );
    cursor += ICON_W + ICON_GAP;

    // Close button hugs the right edge.
    let close_rect = egui::Rect::from_center_size(
        egui::pos2(rect.right() - PAD_R - CLOSE_W / 2.0, rect.center().y),
        egui::vec2(CLOSE_W, CLOSE_W),
    );
    let close = ui.interact(
        close_rect,
        egui::Id::new(("tab-close", info.id)),
        egui::Sense::click(),
    );
    if close.hovered() {
        ui.painter().rect_filled(close_rect, 3.0, darken(fill, 16));
    }
    ui.painter().text(
        close_rect.center(),
        egui::Align2::CENTER_CENTER,
        icons::CLOSE.codepoint,
        icons::font_id(GLYPH_SIZE - 1.0),
        if close.hovered() {
            hover_color
        } else {
            icon_color
        },
    );

    // The name occupies whatever is between the icon and the close button.
    let name_left = cursor;
    let name_right = close_rect.left() - ITEM_GAP;
    let name_avail = (name_right - name_left).max(0.0);
    let _ = fixed; // fixed width already reflected in `rect`/`name_avail`.

    // Inline rename in place of the name when this tab is being renamed.
    let editing = rename
        .as_mut()
        .filter(|r| r.surface == RenameSurface::Tab && r.id == info.id);
    if let Some(state) = editing {
        let field_rect = egui::Rect::from_min_max(
            egui::pos2(name_left, rect.top() + 5.0),
            egui::pos2(name_right, rect.bottom() - 5.0),
        );
        let builder = egui::UiBuilder::new()
            .max_rect(field_rect)
            .layout(egui::Layout::left_to_right(egui::Align::Center));
        let res = ui
            .scope_builder(builder, |ui| {
                inline_rename_field(
                    ui,
                    &mut state.buffer,
                    &mut state.take_focus,
                    egui::Id::new(("tab-rename", info.id)),
                    field_rect.width(),
                )
            })
            .inner;
        actions.rename_commit |= res.commit;
        actions.rename_cancel |= res.cancel;
    } else {
        let (name_galley, marker_galley) = crate::page::layout_query_name(
            ui,
            &info.name,
            info.unsaved,
            font_body(ui),
            text_color,
            name_avail,
        );
        let name_y = rect.center().y - name_galley.size().y / 2.0;
        let name_pos = egui::pos2(name_left, name_y);
        if info.pinned {
            ui.painter()
                .galley(name_pos, name_galley.clone(), text_color);
        } else {
            // Unpinned (preview) tabs render their name in faux-italic.
            paint_galley_skewed(ui.painter(), name_pos, &name_galley, ITALIC_SHEAR);
        }
        if let Some(marker) = marker_galley {
            ui.painter().galley(
                egui::pos2(
                    name_left + name_galley.size().x + crate::page::MARKER_GAP,
                    name_y,
                ),
                marker,
                text_color,
            );
        }
    }

    // Context menu: identical to the toolbar's options menu, for this query.
    if let Some(inner) = egui::Popup::context_menu(&body)
        .show(|ui| {
            page_options_menu(
                ui,
                &info.base_table,
                info.full_mode,
                info.show_revert,
                Some(info.pinned),
                schema,
            )
        })
        .and_then(|i| i.inner)
    {
        actions.menu = Some((info.id, inner));
    }

    // Fold in the body gestures. Close/pin already claimed their own clicks.
    if close.clicked() || body.clicked_by(egui::PointerButton::Middle) {
        actions.close = Some(info.id);
    } else if body.double_clicked() {
        actions.rename = Some(info.id);
    } else if body.clicked() {
        actions.select = Some(info.id);
    }
    if body.drag_started() {
        let grab = ui
            .input(|i| i.pointer.interact_pos())
            .map_or(0.0, |p| p.x - rect.left());
        actions.drag_start = Some((info.id, grab));
    }
    if body.drag_stopped() {
        actions.drag_end = true;
    }
}

/// The resolved body font id (a small helper to keep call sites tidy).
fn font_body(ui: &egui::Ui) -> egui::FontId {
    egui::TextStyle::Body.resolve(ui.style())
}

#[cfg(test)]
mod tests {
    use super::tab_widths;

    #[test]
    fn widths_untouched_when_they_fit() {
        let nat = [80.0, 120.0, 60.0];
        let w = tab_widths(&nat, 400.0);
        assert_eq!(w, nat);
    }

    #[test]
    fn shrinks_widest_first() {
        // Total 240 > 150. The narrow tab (40) is untouched; the wide one (200)
        // absorbs the whole shortfall down to 110.
        let w = tab_widths(&[40.0, 200.0], 150.0);
        assert!((w[0] - 40.0).abs() < 0.5, "narrow kept: {w:?}");
        assert!((w[1] - 110.0).abs() < 0.5, "wide shrank: {w:?}");
        assert!((w.iter().sum::<f32>() - 150.0).abs() < 0.5);
    }

    #[test]
    fn equal_tabs_share_evenly() {
        let w = tab_widths(&[100.0, 100.0, 100.0], 150.0);
        for x in &w {
            assert!((x - 50.0).abs() < 0.5, "even share: {w:?}");
        }
    }
}

/// Headless snapshot tests for the tab bar, driving the real
/// [`App::render_tab_bar`] so the images track the actual layout code. They
/// exercise the states a tab can be in — pinned vs. unpinned (faux-italic with a
/// pin button), an unsaved marker, truncation under a narrow bar, a hovered
/// handle, and a hovered close button. Generate/refresh with
/// `UPDATE_SNAPSHOTS=1 cargo test -p frontend`.
#[cfg(test)]
mod snapshot_tests {
    use std::cell::Cell;

    use eframe::egui;
    use egui_kittest::Harness;
    use uuid::Uuid;

    use crate::App;
    use crate::page::QueryPage;
    use crate::query_def::QueryDefinition;
    use crate::rpc::Query;

    const PPP: f32 = 2.0;

    /// Builds a query with a distinct base so an edited copy reads as unsaved.
    fn query(id: u128, name: &str) -> Query {
        Query {
            id: Uuid::from_u128(id),
            name: name.to_owned(),
            created_at: id as i64,
            modified_at: 0,
            last_play: 0,
            definition: QueryDefinition {
                base: "track".to_owned(),
                ..Default::default()
            },
        }
    }

    /// A persisted tab with an explicit pin state.
    fn tab(id: u128, name: &str, pinned: bool) -> QueryPage {
        let mut page = QueryPage::persisted(query(id, name));
        page.pinned = pinned;
        page
    }

    /// A persisted tab carrying an unsaved edit (so it shows the red marker).
    fn dirty_tab(id: u128, name: &str, pinned: bool) -> QueryPage {
        let mut page = tab(id, name, pinned);
        page.live.definition.filter.custom = "edited".to_owned();
        page
    }

    /// Renders the tab bar for `app` at width `w`, aims the pointer at
    /// `hover` (logical points, if any), and writes `tabs/<name>`.
    fn snapshot(name: &str, w: f32, mut app: App, hover: Option<egui::Pos2>) {
        app.schema_fetch_started = true;
        app.queries_fetch_started = true;
        app.presets_fetch_started = true;
        app.auto_selected_initial = true;

        let fonts_ready = Cell::new(false);
        let mut harness = Harness::builder()
            .with_size(egui::vec2(w, 60.0))
            .with_pixels_per_point(PPP)
            .build_ui(move |ui| {
                if !fonts_ready.replace(true) {
                    crate::setup_fonts(ui.ctx());
                    ui.ctx()
                        .global_style_mut(|s| s.visuals.text_cursor.blink = false);
                    return;
                }
                app.render_tab_bar(ui);
            });

        harness.run();
        if let Some(pos) = hover {
            harness
                .input_mut()
                .events
                .push(egui::Event::PointerMoved(pos));
            harness.run();
            harness.run();
        }
        // Crop to the painted bar (34pt tall) rather than the whole container.
        harness.fit_contents();
        harness.snapshot(format!("tabs/{name}"));
    }

    /// An app whose current tab is the first page.
    fn app(pages: Vec<QueryPage>) -> App {
        let current = crate::CurrentPage::Query(pages[0].live.id);
        App {
            pages,
            current,
            ..Default::default()
        }
    }

    #[test]
    fn mixed_states() {
        // Pinned + selected, an unpinned (faux-italic) preview tab with its pin
        // button, and a pinned tab with an unsaved marker.
        let pages = vec![
            tab(1, "Lemonade", true),
            tab(2, "Discography", false),
            dirty_tab(3, "Untitled draft", true),
        ];
        snapshot("mixed_states", 620.0, app(pages), None);
    }

    #[test]
    fn truncated() {
        // Six equal-ish handles in a narrow bar: they shrink and the names
        // ellipsize to fit.
        let pages = vec![
            tab(1, "Lemonade (Deluxe Edition)", true),
            tab(2, "Beyoncé — Complete Discography", true),
            tab(3, "Workout Bangers 2016", true),
            tab(4, "Late Night Chill Vibes", true),
            tab(5, "Road Trip Mixtape", true),
            tab(6, "Rainy Day Acoustic", true),
        ];
        snapshot("truncated", 620.0, app(pages), None);
    }

    #[test]
    fn tab_hovered() {
        // Hover the body of the second (inactive) handle → hover background.
        let pages = vec![
            tab(1, "Lemonade", true),
            tab(2, "Discography", true),
            tab(3, "Workout", true),
        ];
        snapshot(
            "tab_hovered",
            620.0,
            app(pages),
            Some(egui::pos2(230.0, 17.0)),
        );
    }

    #[test]
    fn close_hovered() {
        // Hover the active handle's close button → the × highlights.
        let pages = vec![tab(1, "Lemonade", true), tab(2, "Discography", true)];
        snapshot(
            "close_hovered",
            620.0,
            app(pages),
            Some(egui::pos2(148.0, 17.0)),
        );
    }
}
