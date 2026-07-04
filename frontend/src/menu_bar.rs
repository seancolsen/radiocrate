//! The query toolbar: a Save button (shown while there are unsaved changes),
//! the run button, the query options ("build") menu — which also holds the
//! Base-table selector as a submenu — the builder toggles (Filter/Sort/
//! Display, or a single "Querydown" toggle in full-querydown mode), and — at
//! the far right — the result count. The explorer toggle and the query name
//! live in the tab bar above this toolbar, not here.

use std::sync::{Arc, Mutex};

use eframe::egui;
use uuid::Uuid;

use crate::App;
use crate::RenameSurface;
use crate::button::{Button, SplitButton};
use crate::icons::{self, MaterialIcon};
use crate::now_playing::menu_item;
use crate::page::{DELETE_RED, QueryAction, QueryPage};
use crate::query_def::Section;

/// At or below this query-page width, the menu bar switches to its compact
/// layout: the Filter/Sort/Display buttons drop their text labels and the
/// run/filter separator is hidden.
const COMPACT_MENU_BAR_WIDTH: f32 = 500.0;

/// An item chosen from the query page's options ("build") menu.
pub(crate) enum PageMenu {
    Action(QueryAction),
    Base(String),
    /// Switch the query into full-querydown mode (from the Base submenu's
    /// "Full query" item or the "Convert to full query" action).
    ConvertToFull,
    /// Open the manage-all-presets modal.
    ManagePresets,
    /// Open the "View SQL" modal showing the compiled query SQL.
    ViewSql,
}

/// A choice from the Base submenu: a specific base table, or full-querydown mode.
enum BaseChoice {
    Table(String),
    Full,
}

impl App {
    // One linear pass over the bar's widgets followed by the application of
    // their collected actions; splitting it up would just scatter the flags.
    #[allow(clippy::too_many_lines)]
    pub(crate) fn render_menu_bar(&mut self, ui: &mut egui::Ui) {
        let panel_fill = ui.style().visuals.panel_fill;
        // On a narrow query page, drop the section buttons' text labels (and the
        // run/filter separator) to keep the bar's controls from crowding.
        let compact = ui.available_width() <= COMPACT_MENU_BAR_WIDTH;
        let current_id = self.current.query_id();
        if current_id.is_none() {
            return;
        }
        let base_table = self
            .current_page()
            .map_or(String::new(), |p| p.live.definition.base.clone());
        let full_mode = self
            .current_page()
            .is_some_and(|p| p.live.definition.is_full());
        let full_editor_open = self.full_editor_open;
        let running = self
            .current_page()
            .is_some_and(|p| p.results.lock().unwrap().running);
        let unsaved = self.current_page().is_some_and(QueryPage::unsaved);
        // "Revert changes" is offered only for a saved query with unsaved edits.
        let show_revert = unsaved && self.current_page().is_some_and(QueryPage::is_persisted);
        let pinned = self.current_page().map(|p| p.pinned);
        let builder_section = self.builder_section;
        let schema = Arc::clone(&self.schema);
        let row_count = self
            .current_page()
            .map(|p| p.results.lock().unwrap().rows.len());

        let mut section_clicked = None;
        let mut section_menu_anchor = None;
        let mut toggle_full_editor = false;
        let mut run_now = false;
        let mut save_now = false;
        let mut menu_choice = None;

        egui::Panel::top("menu_bar")
            .exact_size(30.0)
            .show_separator_line(false)
            .frame(
                egui::Frame::new()
                    .fill(panel_fill)
                    .inner_margin(egui::Margin::same(0)),
            )
            .show_inside(ui, |ui| {
                ui.with_layout(egui::Layout::left_to_right(egui::Align::Center), |ui| {
                    ui.add_space(8.0);
                    // Left-aligned controls: Save (while unsaved), Run, the query
                    // options ("build") menu trigger, then the builder toggles.
                    if unsaved && Button::icon(icons::SAVE).show(ui).clicked() {
                        save_now = true;
                    }
                    if Button::icon(icons::RUN)
                        .enabled(!running)
                        .spin(running)
                        .show(ui)
                        .clicked()
                    {
                        run_now = true;
                    }
                    // The query options ("build") menu trigger sits right after the
                    // run button.
                    let build = Button::icon(icons::BUILD).show(ui);
                    menu_choice = egui::Popup::menu(&build)
                        .align(egui::RectAlign::BOTTOM_START)
                        .show(|ui| {
                            page_options_menu(
                                ui,
                                &base_table,
                                full_mode,
                                show_revert,
                                pinned,
                                &schema,
                            )
                        })
                        .and_then(|inner| inner.inner);
                    if !compact {
                        ui.separator();
                    }
                    // Full mode replaces the Filter/Sort/Display section toggles
                    // with a single, menu-less "Querydown" toggle.
                    if full_mode {
                        toggle_full_editor = draw_querydown_button(ui, full_editor_open, compact);
                    } else {
                        let sections = draw_section_buttons(ui, builder_section, compact);
                        section_clicked = sections.clicked;
                        section_menu_anchor = sections.menu;
                    }
                    // The result count sits at the far right of the toolbar.
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.add_space(8.0);
                        if let Some(n) = row_count {
                            ui.label(
                                egui::RichText::new(result_count_label(n))
                                    .small()
                                    .color(ui.visuals().weak_text_color()),
                            );
                        }
                    });
                });
            });

        // Hand the active section's menu trigger to the builder panel (rendered
        // just below this bar, in the same frame) so it can anchor that section's
        // options popup to the toolbar button.
        self.section_menu_anchor = section_menu_anchor;

        // The section buttons are toggles: clicking the open one closes the builder.
        // Opening (or switching to) a section flags the builder to focus its input.
        if let Some(section) = section_clicked {
            // Expansion is ephemeral to the open builder area, so any section
            // toggle (open, close, or switch) discards it. In-progress edits live
            // in `preset_edits` and intentionally survive this.
            self.expanded_preset = None;
            if self.builder_section == Some(section) {
                self.builder_section = None;
            } else {
                self.builder_section = Some(section);
                self.builder_focus = true;
            }
        }
        // The "Querydown" button is a toggle for the full-query editor panel.
        if toggle_full_editor {
            self.full_editor_open = !self.full_editor_open;
        }
        if run_now {
            self.run_query(ui.ctx());
        }
        if save_now {
            self.save_current();
        }
        if let (Some(choice), Some(id)) = (menu_choice, current_id) {
            self.apply_page_menu(choice, id, ui.ctx());
        }
    }

    /// Applies a choice from the query options ("build") menu to the query `id`.
    /// Shared by the toolbar's own menu and a tab's context menu (which carries
    /// the same items), so both behave identically. Selecting the tab first keeps
    /// menu items that act on "the current query" (Base, View SQL, Convert to
    /// full) pointed at the query the menu was opened for.
    pub(crate) fn apply_page_menu(&mut self, choice: PageMenu, id: Uuid, ctx: &egui::Context) {
        self.select_page(id);
        match choice {
            PageMenu::Base(table) => {
                if self
                    .current_page()
                    .is_some_and(|p| p.live.definition.base != table)
                {
                    // Changing the base invalidates the existing filter/sort/display
                    // (presets are scoped to a base table and custom code references
                    // its columns), so reset them, seeding the new base's defaults.
                    let definition = self.definition_for_base(table);
                    if let Some(page) = self.current_page_mut() {
                        page.live.definition = definition;
                    }
                    self.run_query(ctx);
                }
            }
            PageMenu::ConvertToFull => self.convert_current_to_full(),
            PageMenu::ManagePresets => self.manage_presets = true,
            PageMenu::ViewSql => self.open_view_sql(),
            PageMenu::Action(QueryAction::Rename) => self.begin_rename(id, RenameSurface::Tab),
            PageMenu::Action(QueryAction::Revert) => self.revert_query(id),
            PageMenu::Action(QueryAction::Duplicate) => self.duplicate_query(id),
            PageMenu::Action(QueryAction::Delete) => self.request_delete(id),
            PageMenu::Action(QueryAction::TogglePin) => self.toggle_pin(id),
        }
    }
}

/// The body of the query options ("build") menu: the Base-table submenu and the
/// Manage-presets / Rename / Revert / Duplicate / View-SQL / Pin / Delete
/// actions. "Revert changes" is shown only when `show_revert` (a saved query
/// with unsaved edits). `pinned` — when `Some` — adds a Pin/Unpin toggle
/// reflecting the tab's current pin state. Shared verbatim by the toolbar's menu
/// and a tab handle's context menu so the two stay identical. Returns the chosen
/// item, if any.
pub(crate) fn page_options_menu(
    ui: &mut egui::Ui,
    base_table: &str,
    full_mode: bool,
    show_revert: bool,
    pinned: Option<bool>,
    schema: &Arc<Mutex<Option<String>>>,
) -> Option<PageMenu> {
    ui.set_width(210.0);
    let mut chosen = None;
    match base_submenu(ui, base_table, full_mode, schema) {
        Some(BaseChoice::Table(table)) => chosen = Some(PageMenu::Base(table)),
        Some(BaseChoice::Full) => chosen = Some(PageMenu::ConvertToFull),
        None => {}
    }
    if menu_item(ui, icons::MANAGE_PRESETS, "Manage presets", true, None).clicked() {
        chosen = Some(PageMenu::ManagePresets);
    }
    if let Some(pinned) = pinned {
        let label = if pinned { "Unpin tab" } else { "Pin tab" };
        if menu_item(ui, icons::PIN, label, true, None).clicked() {
            chosen = Some(PageMenu::Action(QueryAction::TogglePin));
        }
    }
    if menu_item(ui, icons::RENAME, "Rename", true, None).clicked() {
        chosen = Some(PageMenu::Action(QueryAction::Rename));
    }
    if show_revert && menu_item(ui, icons::REVERT, "Revert changes", true, None).clicked() {
        chosen = Some(PageMenu::Action(QueryAction::Revert));
    }
    if menu_item(ui, icons::DUPLICATE, "Duplicate", true, None).clicked() {
        chosen = Some(PageMenu::Action(QueryAction::Duplicate));
    }
    if menu_item(ui, icons::VIEW_SQL, "View SQL", true, None).clicked() {
        chosen = Some(PageMenu::ViewSql);
    }
    if menu_item(ui, icons::DELETE, "Delete", true, Some(DELETE_RED)).clicked() {
        chosen = Some(PageMenu::Action(QueryAction::Delete));
    }
    chosen
}

/// The "Base ▶" submenu listing every table in the schema, followed (below a
/// separator) by the "Full query" option that switches the query into
/// full-querydown mode. The current selection is highlighted: a table in
/// sectioned mode, or the full-query option in `full_mode`. Returns the chosen
/// item, if any.
fn base_submenu(
    ui: &mut egui::Ui,
    base_table: &str,
    full_mode: bool,
    schema: &Arc<Mutex<Option<String>>>,
) -> Option<BaseChoice> {
    let label = format!("{}  Change base", icons::BASE.codepoint);
    let (_, inner) = egui::containers::menu::SubMenuButton::new(label).ui(ui, |ui| {
        ui.set_min_width(170.0);
        let tables = schema
            .lock()
            .unwrap()
            .as_deref()
            .map(table_names)
            .unwrap_or_default();
        if tables.is_empty() {
            ui.weak("Loading schema…");
            return None;
        }
        let mut choice = None;
        for table in tables {
            let label = format!("{}  {table}", icons::TABLE.codepoint);
            // No table is the active base while in full mode.
            if ui
                .selectable_label(!full_mode && table == base_table, label)
                .clicked()
            {
                choice = Some(BaseChoice::Table(table));
            }
        }
        ui.separator();
        let label = format!("{}  Full query", icons::QUERYDOWN.codepoint);
        if ui.selectable_label(full_mode, label).clicked() {
            choice = Some(BaseChoice::Full);
        }
        choice
    });
    inner.and_then(|i| i.inner)
}

/// The icon for a section's button.
fn section_icon(section: Section) -> MaterialIcon {
    match section {
        Section::Filter => icons::FILTER,
        Section::Sort => icons::SORT,
        Section::Display => icons::DISPLAY,
    }
}

/// The outcome of drawing the Filter/Sort/Display toggle buttons.
struct SectionButtons {
    /// The section whose main area was clicked (toggles the builder), if any.
    clicked: Option<Section>,
    /// The active section's embedded "⋮" menu trigger, to anchor its options
    /// popup. At most one section is active, so at most one trigger exists.
    menu: Option<egui::Response>,
}

/// Draws the Filter/Sort/Display toggle buttons in the `ui`'s layout direction.
/// Each is a [`SplitButton`]: its main area toggles the builder section, and
/// while active it shows a menu trigger for that section's options. When
/// `compact`, the buttons drop their text labels (keeping their icons and, while
/// active, their menu triggers) to save room on a narrow bar.
fn draw_section_buttons(ui: &mut egui::Ui, open: Option<Section>, compact: bool) -> SectionButtons {
    let mut out = SectionButtons {
        clicked: None,
        menu: None,
    };
    let mut sections = [Section::Filter, Section::Sort, Section::Display];
    if ui.layout().main_dir() == egui::Direction::RightToLeft {
        sections.reverse();
    }
    for section in sections {
        let resp = SplitButton::new(section_icon(section), section.label())
            .active(open == Some(section))
            .show_label(!compact)
            .show(ui);
        if resp.main.clicked() {
            out.clicked = Some(section);
        }
        if let Some(menu) = resp.menu {
            out.menu = Some(menu);
        }
    }
    out
}

/// Draws the full-querydown mode's single "Querydown" toggle button (a menu-less
/// [`SplitButton`]), which opens/closes the full-query editor panel. When
/// `compact`, drops the text label to save room. Returns `true` when clicked.
fn draw_querydown_button(ui: &mut egui::Ui, open: bool, compact: bool) -> bool {
    SplitButton::new(icons::QUERYDOWN, "Querydown")
        .active(open)
        .show_label(!compact)
        .show_menu(false)
        .show(ui)
        .main
        .clicked()
}

/// A human label for the result count shown at the toolbar's far right, with
/// thousands grouped for readability ("1,362 results" / "1 result").
fn result_count_label(n: usize) -> String {
    let noun = if n == 1 { "result" } else { "results" };
    format!("{} {noun}", group_thousands(n))
}

/// Groups `n`'s digits into thousands with `,` separators (e.g. `1362` ->
/// `"1,362"`).
fn group_thousands(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// The table names from the Querydown schema JSON.
fn table_names(schema_json: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(schema_json) else {
        return Vec::new();
    };
    let Some(tables) = value.get("tables").and_then(|t| t.as_array()) else {
        return Vec::new();
    };
    tables
        .iter()
        .filter_map(|t| t.get("name").and_then(|n| n.as_str()))
        .map(str::to_string)
        .collect()
}
