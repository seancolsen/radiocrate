//! The sliding "organizer" side panel — a page switcher. It lists the saved
//! queries, lets the user create new ones and refresh the list, and switches
//! the displayed page on click.

use std::cmp::Reverse;
use std::sync::{Arc, Mutex};

use eframe::egui;
use uuid::Uuid;

use crate::icons;
use crate::menu_bar::{PageMenu, page_options_menu};
use crate::page::{QueryAction, inline_rename_field, query_actions_menu};
use crate::{
    App, ORGANIZER_DRAG_FRICTION, ORGANIZER_SWIPE_VELOCITY, ORGANIZER_WIDTH, Rename, RenameSurface,
    rpc,
};

/// Sliding "organizer" side panel state, including the in-progress drag gesture
/// and each section's collapsed state.
#[allow(clippy::struct_excessive_bools)]
#[derive(Default)]
pub(crate) struct Organizer {
    pub(crate) open: bool,
    pub(crate) dragging: bool,
    pub(crate) drag_dx: f32,
    pub(crate) drag_start_progress: f32,
    pub(crate) dragged_progress: f32,
    /// Whether the "Opened" section is collapsed (its rows hidden).
    pub(crate) opened_collapsed: bool,
    /// Whether the "Queries" section is collapsed (its rows hidden).
    pub(crate) queries_collapsed: bool,
}

/// One row in the "Opened" section: a currently-open tab (persisted or not).
#[allow(clippy::struct_excessive_bools)]
struct OpenedItem {
    id: Uuid,
    name: String,
    unsaved: bool,
    pinned: bool,
    // Per-item options-menu parameters, so a row's context menu matches the
    // toolbar/tab menu for *that* query.
    base_table: String,
    full_mode: bool,
    show_revert: bool,
}

/// One row in the "Queries" section: a saved query (open or not).
struct SavedItem {
    id: Uuid,
    name: String,
    /// Whether the query is open with unsaved edits (drives the marker + the
    /// "Revert changes" menu item).
    unsaved: bool,
}

/// Deferred outcomes of interacting with the explorer, applied after the UI
/// closure releases its borrow of `self`.
#[allow(clippy::struct_excessive_bools)]
#[derive(Default)]
struct ListActions {
    refresh: bool,
    /// A saved query row was clicked: open it (in a preview tab) and select it.
    open: Option<Uuid>,
    /// An open-tab row was clicked: select that tab.
    select: Option<Uuid>,
    /// An open-tab row's × was clicked: close that tab.
    close: Option<Uuid>,
    /// An open-tab row's pin toggle was clicked.
    pin_toggle: Option<Uuid>,
    rename_request: Option<Uuid>,
    revert_request: Option<Uuid>,
    duplicate_request: Option<Uuid>,
    delete_request: Option<Uuid>,
    rename_commit: bool,
    rename_cancel: bool,
    toggle_opened_collapsed: bool,
    toggle_queries_collapsed: bool,
    /// An "Opened" row's context menu produced a choice from the query options
    /// menu (the same one the toolbar and tab handles show).
    menu: Option<(Uuid, PageMenu)>,
}

/// Per-row outcome from `saved_row_widget`, folded into `ListActions`.
#[derive(Default)]
struct RowOutcome {
    clicked: bool,
    action: Option<QueryAction>,
    rename_commit: bool,
    rename_cancel: bool,
}

impl App {
    pub(crate) fn render_organizer(
        &mut self,
        ctx: &egui::Context,
        progress: f32,
        panel_fill: egui::Color32,
    ) {
        let viewport = ctx.viewport_rect();
        let organizer_offset = progress * ORGANIZER_WIDTH;

        // The scrim covers the full viewport; the organizer Area (Order::Foreground)
        // paints over it wherever the drawer currently is.
        let scrim_alpha = (progress * 120.0).clamp(0.0, 255.0) as u8;
        egui::Area::new(egui::Id::new("organizer_scrim"))
            .order(egui::Order::Middle)
            .fixed_pos(viewport.min)
            .constrain(false)
            .interactable(true)
            .show(ctx, |ui| {
                let (rect, resp) =
                    ui.allocate_exact_size(viewport.size(), egui::Sense::click_and_drag());
                ui.painter()
                    .rect_filled(rect, 0.0, egui::Color32::from_black_alpha(scrim_alpha));
                if resp.clicked() {
                    self.organizer.open = false;
                }
                self.handle_organizer_swipe(ctx, &resp, progress);
            });

        let organizer_x = organizer_offset - ORGANIZER_WIDTH;
        let screen_height = viewport.height();
        let opened = self.opened_items();
        let saved = self.saved_items();
        let current = self.current.query_id();
        let collapse = (
            self.organizer.opened_collapsed,
            self.organizer.queries_collapsed,
        );
        let schema = Arc::clone(&self.schema);
        let mut actions = ListActions::default();

        egui::Area::new(egui::Id::new("organizer"))
            .order(egui::Order::Foreground)
            .fixed_pos(egui::pos2(organizer_x, 0.0))
            .constrain(false)
            .interactable(true)
            .show(ctx, |ui| {
                let frame_rect = egui::Rect::from_min_size(
                    egui::pos2(organizer_x, 0.0),
                    egui::vec2(ORGANIZER_WIDTH, screen_height),
                );
                ui.set_min_size(egui::vec2(ORGANIZER_WIDTH, screen_height));
                // Cap the width so inner right-to-left layouts (e.g. the header's
                // "+" button) align to the sidebar's edge rather than the
                // viewport's. Without this the Area also expands its interactive
                // rect across the whole main area, swallowing the scrim's
                // click/swipe-to-close.
                ui.set_max_width(ORGANIZER_WIDTH);
                ui.painter().rect_filled(frame_rect, 0.0, panel_fill);

                // Low-priority swipe target underneath the controls, so taps on
                // the buttons and list rows aren't swallowed by the drag sense.
                let drag = ui.interact(
                    frame_rect,
                    egui::Id::new("organizer_drag"),
                    egui::Sense::drag(),
                );
                self.handle_organizer_swipe(ctx, &drag, progress);

                actions = draw_explorer(
                    ui,
                    &opened,
                    &saved,
                    current,
                    collapse,
                    &mut self.filter,
                    &mut self.rename,
                    &schema,
                );
            });

        // Selecting a query closes the modal drawer (it overlays the content);
        // the persistent panel stays open.
        self.apply_list_actions(ctx, actions, true);
    }

    /// Renders the organizer as a persistent left panel for wide screens. Unlike
    /// the modal drawer it reserves real layout space (the rest of the app lays
    /// out beside it), has no scrim or swipe-to-close, and stays open across
    /// selections — only the explorer button toggles it.
    pub(crate) fn render_persistent_organizer(
        &mut self,
        ui: &mut egui::Ui,
        panel_fill: egui::Color32,
    ) {
        let opened = self.opened_items();
        let saved = self.saved_items();
        let current = self.current.query_id();
        let collapse = (
            self.organizer.opened_collapsed,
            self.organizer.queries_collapsed,
        );
        let schema = Arc::clone(&self.schema);
        let mut actions = ListActions::default();

        egui::Panel::left("organizer_panel")
            .exact_size(ORGANIZER_WIDTH)
            .resizable(false)
            .frame(egui::Frame::new().fill(panel_fill))
            .show_animated_inside(ui, self.organizer.open, |ui| {
                actions = draw_explorer(
                    ui,
                    &opened,
                    &saved,
                    current,
                    collapse,
                    &mut self.filter,
                    &mut self.rename,
                    &schema,
                );
            });

        self.apply_list_actions(ui.ctx(), actions, false);
    }

    /// Applies the deferred outcomes of interacting with the query list, shared by
    /// the modal drawer and the persistent panel. `close_on_select` closes the
    /// organizer after navigating to a query (used by the modal drawer only).
    fn apply_list_actions(
        &mut self,
        ctx: &egui::Context,
        actions: ListActions,
        close_on_select: bool,
    ) {
        // Commit/cancel an in-progress rename before starting a new one, so
        // clicking "Rename" on another row first saves the current edit.
        if actions.rename_commit {
            self.commit_rename();
        }
        if actions.rename_cancel {
            self.cancel_rename();
        }
        if actions.toggle_opened_collapsed {
            self.organizer.opened_collapsed = !self.organizer.opened_collapsed;
        }
        if actions.toggle_queries_collapsed {
            self.organizer.queries_collapsed = !self.organizer.queries_collapsed;
        }
        // Navigating (opening a saved query or selecting an open tab) closes the
        // modal drawer; closing/pinning a tab leaves it open.
        if let Some(id) = actions.open {
            self.open_query(id);
            if close_on_select {
                self.organizer.open = false;
            }
        }
        if let Some(id) = actions.select {
            self.select_page(id);
            if close_on_select {
                self.organizer.open = false;
            }
        }
        if let Some(id) = actions.pin_toggle {
            self.toggle_pin(id);
        }
        if let Some(id) = actions.rename_request {
            self.begin_rename(id, RenameSurface::Sidebar);
        }
        if let Some(id) = actions.revert_request {
            self.revert_query(id);
        }
        if let Some(id) = actions.duplicate_request {
            self.duplicate_query(id);
        }
        if let Some(id) = actions.delete_request {
            self.request_delete(id);
        }
        if actions.refresh {
            rpc::list_queries(Arc::clone(&self.loaded_queries), ctx.clone());
        }
        // Applied last: closing a tab can change the current page.
        if let Some(id) = actions.close {
            self.close_tab(id);
        }
        if let Some((id, choice)) = actions.menu {
            self.apply_page_menu(choice, id, ctx);
        }
    }

    /// The "Opened" section rows: every open tab, in tab order — including a
    /// never-saved query (shown unsaved, since it has no last-saved version).
    fn opened_items(&self) -> Vec<OpenedItem> {
        self.pages
            .iter()
            .map(|p| OpenedItem {
                id: p.live.id,
                name: p.live.name.clone(),
                unsaved: p.unsaved(),
                pinned: p.pinned,
                base_table: p.live.definition.base.clone(),
                full_mode: p.live.definition.is_full(),
                show_revert: p.is_persisted() && p.unsaved(),
            })
            .collect()
    }

    /// The "Queries" section rows: every saved query, filtered by name and
    /// most-recently-created first. A query open with unsaved edits shows the
    /// unsaved marker.
    fn saved_items(&self) -> Vec<SavedItem> {
        let filter = self.filter.to_lowercase();
        let mut items: Vec<(i64, SavedItem)> = self
            .saved_queries
            .iter()
            .filter(|q| filter.is_empty() || q.name.to_lowercase().contains(&filter))
            .map(|q| {
                let unsaved = self
                    .pages
                    .iter()
                    .find(|p| p.live.id == q.id)
                    .is_some_and(crate::page::QueryPage::unsaved);
                (
                    q.created_at,
                    SavedItem {
                        id: q.id,
                        name: q.name.clone(),
                        unsaved,
                    },
                )
            })
            .collect();
        items.sort_by_key(|(created_at, _)| Reverse(*created_at));
        items.into_iter().map(|(_, item)| item).collect()
    }

    pub(crate) fn handle_organizer_swipe(
        &mut self,
        ctx: &egui::Context,
        resp: &egui::Response,
        current_progress: f32,
    ) {
        if resp.drag_started() {
            self.organizer.dragging = true;
            self.organizer.drag_dx = 0.0;
            self.organizer.drag_start_progress = current_progress;
            self.organizer.dragged_progress = current_progress;
        }
        if resp.dragged() {
            self.organizer.drag_dx += resp.drag_delta().x;
            let effective = static_friction(self.organizer.drag_dx, ORGANIZER_DRAG_FRICTION);
            self.organizer.dragged_progress =
                (self.organizer.drag_start_progress + effective / ORGANIZER_WIDTH).clamp(0.0, 1.0);
        }
        if resp.drag_stopped() {
            self.organizer.dragging = false;
            let velocity_x = ctx.input(|i| i.pointer.velocity().x);
            let effective = static_friction(self.organizer.drag_dx, ORGANIZER_DRAG_FRICTION);
            let flick = velocity_x <= -ORGANIZER_SWIPE_VELOCITY;
            let dragged_past_midpoint = effective <= -ORGANIZER_WIDTH / 2.0;
            if flick || dragged_past_midpoint {
                self.organizer.open = false;
            }
            self.organizer.drag_dx = 0.0;
        }
    }
}

/// Renders the explorer's two collapsible sections — "Opened" (the open tabs)
/// and "Queries" (all saved queries, with a name filter) — and returns the
/// deferred actions the caller should apply.
#[allow(clippy::too_many_arguments)]
fn draw_explorer(
    ui: &mut egui::Ui,
    opened: &[OpenedItem],
    saved: &[SavedItem],
    current: Option<Uuid>,
    collapse: (bool, bool),
    filter: &mut String,
    rename: &mut Option<Rename>,
    schema: &Arc<Mutex<Option<String>>>,
) -> ListActions {
    let (opened_collapsed, queries_collapsed) = collapse;
    let mut actions = ListActions::default();

    egui::ScrollArea::vertical()
        .auto_shrink([false, false])
        .show(ui, |ui| {
            // No vertical spacing between rows so adjacent listings butt together
            // and leave no dead (unclickable) gap.
            ui.spacing_mut().item_spacing.y = 0.0;

            // ---- Opened ----
            ui.add_space(8.0);
            let (toggle, _) = collapse_header(ui, "Opened", opened_collapsed, false);
            actions.toggle_opened_collapsed = toggle;
            if !opened_collapsed {
                if opened.is_empty() {
                    section_hint(ui, "No open queries");
                }
                for item in opened {
                    let out = opened_row_widget(ui, item, current == Some(item.id), schema);
                    if out.clicked {
                        actions.select = Some(item.id);
                    }
                    if out.close {
                        actions.close = Some(item.id);
                    }
                    if out.pin {
                        actions.pin_toggle = Some(item.id);
                    }
                    if let Some(choice) = out.menu {
                        actions.menu = Some((item.id, choice));
                    }
                }
            }

            // ---- Queries ----
            ui.add_space(10.0);
            let (toggle, refresh) = collapse_header(ui, "Queries", queries_collapsed, true);
            actions.toggle_queries_collapsed = toggle;
            actions.refresh = refresh;
            if !queries_collapsed {
                ui.add_space(4.0);
                ui.horizontal(|ui| {
                    ui.add_space(12.0);
                    crate::text_input::add(
                        ui,
                        egui::TextEdit::singleline(filter)
                            .hint_text("Filter")
                            .desired_width(ORGANIZER_WIDTH - 24.0),
                    );
                });
                ui.add_space(4.0);
                for item in saved {
                    let out = saved_row_widget(ui, item, current == Some(item.id), rename);
                    if out.clicked {
                        actions.open = Some(item.id);
                    }
                    if out.rename_commit {
                        actions.rename_commit = true;
                    }
                    if out.rename_cancel {
                        actions.rename_cancel = true;
                    }
                    match out.action {
                        Some(QueryAction::Rename) => actions.rename_request = Some(item.id),
                        Some(QueryAction::Revert) => actions.revert_request = Some(item.id),
                        Some(QueryAction::Duplicate) => actions.duplicate_request = Some(item.id),
                        Some(QueryAction::Delete) => actions.delete_request = Some(item.id),
                        Some(QueryAction::TogglePin) | None => {}
                    }
                }
            }
        });

    actions
}

/// A collapsible section heading (chevron + title), spanning the sidebar width
/// and toggling the section when clicked. When `with_refresh`, a reload button is
/// interacted at the right edge (on top, so its own click doesn't toggle the
/// section). Returns `(toggle_clicked, refresh_clicked)`.
fn collapse_header(
    ui: &mut egui::Ui,
    title: &str,
    collapsed: bool,
    with_refresh: bool,
) -> (bool, bool) {
    let height = 28.0;
    let (rect, resp) = ui.allocate_exact_size(
        egui::vec2(ui.available_width(), height),
        egui::Sense::click(),
    );

    let (hover_fill, text_color, weak) = {
        let v = ui.visuals();
        (
            crate::results::darken(v.panel_fill, crate::results::ROW_HOVER_DARKEN),
            v.text_color(),
            v.weak_text_color(),
        )
    };

    // Refresh button (interacted after allocating the header, so it sits on top).
    let refresh = with_refresh.then(|| {
        let r = egui::Rect::from_center_size(
            egui::pos2(rect.right() - 16.0, rect.center().y),
            egui::vec2(24.0, 24.0),
        );
        (
            r,
            ui.interact(r, egui::Id::new(("refresh", title)), egui::Sense::click()),
        )
    });

    if resp.hovered() {
        ui.painter().rect_filled(rect, 0.0, hover_fill);
    }
    let chevron = if collapsed {
        icons::EXPAND_CLOSED
    } else {
        icons::EXPAND_OPEN
    };
    ui.painter().text(
        egui::pos2(rect.left() + 10.0, rect.center().y),
        egui::Align2::LEFT_CENTER,
        chevron.codepoint,
        icons::font_id(18.0),
        weak,
    );
    ui.painter().text(
        egui::pos2(rect.left() + 32.0, rect.center().y),
        egui::Align2::LEFT_CENTER,
        title,
        egui::FontId::proportional(16.0),
        text_color,
    );
    let mut refresh_clicked = false;
    if let Some((r, resp)) = &refresh {
        ui.painter().text(
            r.center(),
            egui::Align2::CENTER_CENTER,
            icons::REFRESH.codepoint,
            icons::font_id(18.0),
            if resp.hovered() { text_color } else { weak },
        );
        refresh_clicked = resp.clicked();
    }
    (resp.clicked(), refresh_clicked)
}

/// A muted, indented hint shown in place of an empty section's rows.
fn section_hint(ui: &mut egui::Ui, text: &str) {
    let (rect, _) =
        ui.allocate_exact_size(egui::vec2(ui.available_width(), 26.0), egui::Sense::hover());
    let weak = ui.visuals().weak_text_color();
    ui.painter().text(
        egui::pos2(rect.left() + 32.0, rect.center().y),
        egui::Align2::LEFT_CENTER,
        text,
        egui::TextStyle::Body.resolve(ui.style()),
        weak,
    );
}

/// Shared row chrome (selection/hover background, no border between rows).
/// Returns the resolved text color for painting the row's content.
fn row_background(ui: &egui::Ui, rect: egui::Rect, selected: bool, hovered: bool) -> egui::Color32 {
    let v = ui.visuals();
    let text_color = v.text_color();
    if selected {
        let fill = if hovered {
            crate::results::darken(v.selection.bg_fill, 20)
        } else {
            v.selection.bg_fill
        };
        ui.painter().rect_filled(rect, 0.0, fill);
    } else if hovered {
        ui.painter().rect_filled(
            rect,
            0.0,
            crate::results::darken(v.panel_fill, crate::results::ROW_HOVER_DARKEN),
        );
    }
    text_color
}

/// Paints a row's leading query icon, aligned with the section header's chevron.
fn paint_row_icon(ui: &egui::Ui, rect: egui::Rect, color: egui::Color32) {
    ui.painter().text(
        egui::pos2(rect.left() + 10.0, rect.center().y),
        egui::Align2::LEFT_CENTER,
        icons::QUERY.codepoint,
        icons::font_id(14.0),
        color,
    );
}

/// Per-row outcome from `opened_row_widget`.
#[derive(Default)]
struct OpenedOutcome {
    clicked: bool,
    close: bool,
    pin: bool,
    /// A choice made from the row's right-click query options menu.
    menu: Option<PageMenu>,
}

/// A row in the "Opened" section: an open tab. Clicking the body selects it; an
/// always-visible × sits at the right, with a pin toggle beside it for an
/// unpinned tab only (a pinned tab shows no pin control). An unpinned tab's name
/// is shown italicized (matching its tab handle). Right-clicking the row opens
/// the same query options menu as the tab handle and toolbar.
#[allow(clippy::too_many_lines)]
fn opened_row_widget(
    ui: &mut egui::Ui,
    item: &OpenedItem,
    selected: bool,
    schema: &Arc<Mutex<Option<String>>>,
) -> OpenedOutcome {
    let mut outcome = OpenedOutcome::default();
    let height = ui.text_style_height(&egui::TextStyle::Body) + 12.0;
    let (rect, response) = ui.allocate_exact_size(
        egui::vec2(ui.available_width(), height),
        egui::Sense::click(),
    );
    let text_color = row_background(ui, rect, selected, response.hovered());
    let icon_color = icons::DEFAULT_COLOR;
    paint_row_icon(ui, rect, icon_color);

    // Close (×) at the far right, then — only when unpinned — a pin toggle to
    // its left.
    let close_rect = egui::Rect::from_center_size(
        egui::pos2(rect.right() - 16.0, rect.center().y),
        egui::vec2(22.0, 22.0),
    );
    let close = ui.interact(
        close_rect,
        egui::Id::new(("opened-close", item.id)),
        egui::Sense::click(),
    );
    let pin_rect = (!item.pinned).then(|| {
        egui::Rect::from_center_size(
            egui::pos2(close_rect.left() - 14.0, rect.center().y),
            egui::vec2(22.0, 22.0),
        )
    });
    let pin = pin_rect.map(|r| {
        ui.interact(
            r,
            egui::Id::new(("opened-pin", item.id)),
            egui::Sense::click(),
        )
    });

    // Name (indented under the section chevron), truncated to clear the buttons.
    let name_x = rect.left() + 32.0;
    let right_limit = pin_rect.map_or(close_rect.left(), |r| r.left()) - 4.0;
    let font_id = egui::TextStyle::Body.resolve(ui.style());
    let (name_galley, marker_galley) = crate::page::layout_query_name(
        ui,
        &item.name,
        item.unsaved,
        font_id,
        text_color,
        (right_limit - name_x).max(0.0),
    );
    let name_y = rect.center().y - name_galley.size().y / 2.0;
    if item.pinned {
        ui.painter()
            .galley(egui::pos2(name_x, name_y), name_galley.clone(), text_color);
    } else {
        crate::skew::paint_galley_skewed(
            ui.painter(),
            egui::pos2(name_x, name_y),
            &name_galley,
            crate::skew::ITALIC_SHEAR,
        );
    }
    if let Some(marker) = marker_galley {
        ui.painter().galley(
            egui::pos2(
                name_x + name_galley.size().x + crate::page::MARKER_GAP,
                name_y,
            ),
            marker,
            text_color,
        );
    }

    // Pin toggle (unpinned tabs only): faint at rest, darkening on hover.
    if let (Some(pin_rect), Some(pin)) = (pin_rect, pin.as_ref()) {
        ui.painter().text(
            pin_rect.center(),
            egui::Align2::CENTER_CENTER,
            icons::PIN.codepoint,
            icons::font_id(15.0),
            if pin.hovered() {
                text_color
            } else {
                ui.visuals().weak_text_color()
            },
        );
    }
    // Close ×.
    if close.hovered() {
        ui.painter().rect_filled(
            close_rect,
            3.0,
            crate::results::darken(ui.visuals().panel_fill, 20),
        );
    }
    ui.painter().text(
        close_rect.center(),
        egui::Align2::CENTER_CENTER,
        icons::CLOSE.codepoint,
        icons::font_id(15.0),
        if close.hovered() {
            text_color
        } else {
            icon_color
        },
    );

    outcome.menu = egui::Popup::context_menu(&response)
        .show(|ui| {
            page_options_menu(
                ui,
                &item.base_table,
                item.full_mode,
                item.show_revert,
                Some(item.pinned),
                schema,
            )
        })
        .and_then(|inner| inner.inner);

    outcome.close = close.clicked();
    outcome.pin = pin.is_some_and(|p| p.clicked());
    outcome.clicked = response.clicked();
    outcome
}

/// A row in the "Queries" section: a saved query. Clicking it opens the query;
/// the "⋮" actions button (shown on hover) and right-click both open the query's
/// options menu. Shows an inline rename field while the query is being renamed.
fn saved_row_widget(
    ui: &mut egui::Ui,
    item: &SavedItem,
    selected: bool,
    rename: &mut Option<Rename>,
) -> RowOutcome {
    let mut outcome = RowOutcome::default();
    let height = ui.text_style_height(&egui::TextStyle::Body) + 12.0;
    let (rect, response) = ui.allocate_exact_size(
        egui::vec2(ui.available_width(), height),
        egui::Sense::click(),
    );
    let text_color = row_background(ui, rect, selected, response.hovered());
    let weak_text = ui.visuals().weak_text_color();
    paint_row_icon(ui, rect, icons::DEFAULT_COLOR);

    // Inline rename in place of the name for this row.
    let editing = rename
        .as_mut()
        .filter(|r| r.surface == RenameSurface::Sidebar && r.id == item.id);
    if let Some(state) = editing {
        let field_rect = egui::Rect::from_min_max(
            egui::pos2(rect.left() + 32.0, rect.top() + 4.0),
            egui::pos2(rect.right() - 8.0, rect.bottom() - 4.0),
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
                    egui::Id::new(("sidebar-rename", item.id)),
                    field_rect.width(),
                )
            })
            .inner;
        outcome.rename_commit = res.commit;
        outcome.rename_cancel = res.cancel;
        return outcome;
    }

    let name_x = rect.left() + 32.0;

    // Interact the "⋮" button first so the name can reserve room for it.
    let btn_size = 24.0;
    let btn_rect = egui::Rect::from_center_size(
        egui::pos2(rect.right() - btn_size / 2.0 - 2.0, rect.center().y),
        egui::vec2(btn_size, btn_size),
    );
    let btn_resp = ui.interact(
        btn_rect,
        egui::Id::new(("query-menu", item.id)),
        egui::Sense::click(),
    );
    let show_button = response.hovered() || btn_resp.hovered();
    let right_limit = rect.right() - if show_button { 32.0 } else { 8.0 };

    let font_id = egui::TextStyle::Body.resolve(ui.style());
    // The unsaved marker is shown only on the tab handle and in the "Opened"
    // list, not here — so it's never requested regardless of `item.unsaved`.
    let (name_galley, _marker_galley) = crate::page::layout_query_name(
        ui,
        &item.name,
        false,
        font_id,
        text_color,
        (right_limit - name_x).max(0.0),
    );
    ui.painter().galley(
        egui::pos2(name_x, rect.center().y - name_galley.size().y / 2.0),
        name_galley,
        text_color,
    );

    // A saved query is persisted, so "Revert changes" is offered whenever it's
    // open with unsaved edits.
    outcome.action = saved_row_menu(
        ui, item, &response, btn_rect, &btn_resp, text_color, weak_text,
    );
    outcome.clicked = response.clicked();
    outcome
}

/// Paints the "⋮" actions button (on hover) and wires up its click-menu plus the
/// row's right-click context menu, returning the chosen action.
fn saved_row_menu(
    ui: &mut egui::Ui,
    item: &SavedItem,
    row: &egui::Response,
    btn_rect: egui::Rect,
    btn_resp: &egui::Response,
    text_color: egui::Color32,
    weak_text: egui::Color32,
) -> Option<QueryAction> {
    if row.hovered() || btn_resp.hovered() {
        ui.painter().text(
            btn_rect.center(),
            egui::Align2::CENTER_CENTER,
            icons::MORE.codepoint,
            icons::font_id(18.0),
            if btn_resp.hovered() {
                text_color
            } else {
                weak_text
            },
        );
    }
    let show_revert = item.unsaved;
    let mut action = None;
    if let Some(inner) = egui::Popup::menu(btn_resp)
        .align(egui::RectAlign::BOTTOM_END)
        .show(|ui| query_actions_menu(ui, show_revert))
        && inner.inner.is_some()
    {
        action = inner.inner;
    }
    if let Some(inner) =
        egui::Popup::context_menu(row).show(|ui| query_actions_menu(ui, show_revert))
        && inner.inner.is_some()
    {
        action = inner.inner;
    }
    action
}

/// Models a static-friction-like resistance to drag motion: near-zero response
/// for small `dx`, smoothly approaching 1:1 response (offset by `friction`) for
/// `|dx|` much larger than `friction`.
fn static_friction(dx: f32, friction: f32) -> f32 {
    if friction <= 0.0 {
        return dx;
    }
    dx - friction * (dx / friction).tanh()
}

/// Headless snapshot tests for the explorer sidebar, driving the real
/// [`App::render_persistent_organizer`] so the images track the actual layout.
/// They cover the "Opened" and "Queries" sections together, each section
/// collapsed on its own, and the empty-opened state — exercising pinned vs.
/// unpinned (faux-italic) rows, the unsaved marker, and the pin/close controls.
/// Generate/refresh with `UPDATE_SNAPSHOTS=1 cargo test -p frontend`.
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

    fn tab(id: u128, name: &str, pinned: bool, dirty: bool) -> QueryPage {
        let mut page = QueryPage::persisted(query(id, name));
        page.pinned = pinned;
        if dirty {
            page.live.definition.filter.custom = "edited".to_owned();
        }
        page
    }

    /// An app with three open tabs (pinned+selected, unpinned, pinned+unsaved)
    /// and a handful of saved queries in the library.
    fn populated() -> App {
        let pages = vec![
            tab(5, "Lemonade", true, false),
            tab(4, "Deep Cuts", false, false),
            tab(3, "Workout Mix", true, true),
        ];
        let current = crate::CurrentPage::Query(pages[0].live.id);
        let saved_queries = vec![
            query(5, "Lemonade"),
            query(4, "Deep Cuts"),
            query(3, "Workout Mix"),
            query(2, "Late Night Chill"),
            query(1, "Road Trip Mixtape"),
        ];
        App {
            pages,
            saved_queries,
            current,
            auto_selected_initial: true,
            schema_fetch_started: true,
            queries_fetch_started: true,
            presets_fetch_started: true,
            ..Default::default()
        }
    }

    fn snapshot(name: &str, mut app: App) {
        app.organizer.open = true;
        let fonts_ready = Cell::new(false);
        let mut harness = Harness::builder()
            .with_size(egui::vec2(212.0, 380.0))
            .with_pixels_per_point(PPP)
            .build_ui(move |ui| {
                if !fonts_ready.replace(true) {
                    crate::setup_fonts(ui.ctx());
                    ui.ctx()
                        .global_style_mut(|s| s.visuals.text_cursor.blink = false);
                    return;
                }
                let fill = ui.style().visuals.panel_fill;
                app.render_persistent_organizer(ui, fill);
            });
        harness.run();
        harness.snapshot(format!("explorer/{name}"));
    }

    #[test]
    fn both_sections() {
        snapshot("both_sections", populated());
    }

    #[test]
    fn opened_collapsed() {
        let mut app = populated();
        app.organizer.opened_collapsed = true;
        snapshot("opened_collapsed", app);
    }

    #[test]
    fn queries_collapsed() {
        let mut app = populated();
        app.organizer.queries_collapsed = true;
        snapshot("queries_collapsed", app);
    }

    #[test]
    fn no_open_tabs() {
        // No open tabs: the "Opened" section shows its empty hint; the library is
        // still listed under "Queries".
        let mut app = populated();
        app.pages.clear();
        app.current = crate::CurrentPage::Welcome;
        snapshot("no_open_tabs", app);
    }
}
