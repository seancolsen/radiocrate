use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use eframe::egui;
use eframe::egui::emath::TSTransform;
use uuid::Uuid;

#[cfg(test)]
mod app_snapshot;
mod audio;
mod builder;
mod button;
mod columns;
mod commands;
mod compile;
mod field_layout;
mod form;
mod format;
mod http;
mod icons;
mod lineage;
mod menu_bar;
mod now_playing;
mod organizer;
mod page;
mod palette;
mod query_def;
mod results;
mod rows;
mod rpc;
mod shortcuts_tab;
mod skew;
#[cfg(test)]
mod snapshot_harness;
mod tabs;
mod text_input;
mod theme;
#[cfg(target_arch = "wasm32")]
mod web;
mod welcome;

use audio::AudioPlayer;
use builder::{PresetEdit, PresetSave};
use columns::ColumnMetadata;
use commands::{CommandId, Keymap};
use field_layout::FieldLayout;
use now_playing::CurrentTrack;
use organizer::Organizer;
use page::{CurrentPage, Page, QueryPage};
use query_def::{QueryDefinition, Section, SectionContent};
use rows::ResultRows;

pub(crate) const ORGANIZER_WIDTH: f32 = 200.0;
const ORGANIZER_ANIM_TIME: f32 = 0.1;
/// At or above this viewport width the organizer becomes a persistent left panel
/// (reserving its own space) instead of a modal drawer that overlays the content.
pub(crate) const PERSISTENT_ORGANIZER_MIN_WIDTH: f32 = 500.0;
/// Leftward pointer velocity (px/s) that counts as a swipe-to-close flick,
/// even if the cumulative drag distance is small.
pub(crate) const ORGANIZER_SWIPE_VELOCITY: f32 = 400.0;
/// Static-friction scale for the drawer drag. Small finger movements (well
/// below this) produce ~no drawer motion, so vertical scroll gestures inside
/// the drawer aren't mistaken for a close-swipe. Past a few times this value,
/// the drawer tracks the finger 1:1 (offset by a constant amount).
pub(crate) const ORGANIZER_DRAG_FRICTION: f32 = 16.0;

/// The app's soft blue accent: button hover outlines, the played part of the
/// now-playing timeline, the now-playing row's edge marker. The dark variant
/// is dimmed so the accent stays as quiet against dark panels as the pale blue
/// is against light ones.
pub(crate) const ACCENT_BLUE: theme::Duo = theme::Duo {
    light: egui::Color32::from_rgb(0xBC, 0xD0, 0xEA),
    dark: egui::Color32::from_rgb(0x6E, 0x8F, 0xB5),
};
/// The app's strong blue: focused input borders, active tab/row markers, and
/// hover tints. A mid-lightness blue that reads as an accent on either theme's
/// background, so both variants are the same.
pub(crate) const HOVER_BLUE: theme::Duo = theme::Duo {
    light: egui::Color32::from_rgb(0x77, 0xA5, 0xCE),
    dark: egui::Color32::from_rgb(0x77, 0xA5, 0xCE),
};

/// Margin kept on each side between the "View SQL" modal and the viewport edges,
/// so the modal shrinks to fit small windows instead of touching the edges.
const VIEW_SQL_VIEWPORT_MARGIN: f32 = 24.0;
/// Height reserved below the "View SQL" modal's scroll area for its footer — the
/// button row plus the gap above it — so the footer stays pinned just under the
/// SQL at a constant height while the scroll area absorbs any viewport shrinkage.
const VIEW_SQL_FOOTER_HEIGHT: f32 = 40.0;

/// One-time context setup shared by every target: the bundled fonts plus the
/// light/dark theme palettes.
pub fn setup_context(ctx: &egui::Context) {
    setup_fonts(ctx);
    theme::install(ctx);
}

fn setup_fonts(ctx: &egui::Context) {
    let mut fonts = egui::FontDefinitions::default();

    // Bundle our own faces so the UI doesn't depend on system-installed fonts:
    // Noto Sans for proportional text, Noto Sans Mono for monospace. Insert each
    // at the front of its family so it's the primary face while keeping egui's
    // default fallbacks (emoji/CJK coverage) behind it.
    fonts.font_data.insert(
        "noto-sans".into(),
        egui::FontData::from_static(include_bytes!("../fonts/NotoSans-Regular.ttf")).into(),
    );
    fonts.font_data.insert(
        "noto-sans-mono".into(),
        egui::FontData::from_static(include_bytes!("../fonts/NotoSansMono-Regular.ttf")).into(),
    );
    fonts
        .families
        .entry(egui::FontFamily::Proportional)
        .or_default()
        .insert(0, "noto-sans".into());
    fonts
        .families
        .entry(egui::FontFamily::Monospace)
        .or_default()
        .insert(0, "noto-sans-mono".into());

    ctx.set_fonts(fonts);

    // Register the Material Symbols outline font (adds it as a named family and
    // as a low-priority fallback on the proportional family).
    egui_material_icons::initialize(ctx);
}

#[allow(clippy::struct_excessive_bools)]
#[derive(Default)]
pub(crate) struct QueryState {
    pub(crate) rows: ResultRows,
    /// Resolved display metadata for each result column, positionally aligned with each
    /// row's cells. Empty until the query is (re)compiled.
    pub(crate) columns: Vec<ColumnMetadata>,
    pub(crate) error: Option<String>,
    pub(crate) running: bool,
    /// Set when a run starts and cleared on its first batch (or on completion
    /// with none): while set, `rows` still holds the *previous* run's results,
    /// kept on screen (dimmed — see `results::render_results`) instead of being
    /// cleared up front, so a reload doesn't blank the pane while it loads.
    pub(crate) awaiting_first_batch: bool,
    pub(crate) track_id_column: Option<usize>,
    /// The result column carrying the query base table's primary key, detected by
    /// lineage (see [`lineage::detect_id_columns`]). Identifies which record each
    /// result row edits, so the record editor can be opened for and kept in sync
    /// with the selection. `None` until lineage resolves it (or if none is found).
    pub(crate) record_id_column: Option<usize>,
    pub(crate) lineage_done: bool,
    pub(crate) needs_revalidation: bool,
}

/// Which surface initiated an in-progress rename. Both surfaces edit the same
/// query name, but only the initiating one renders the inline field, so the two
/// can't fight over focus.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum RenameSurface {
    /// The query's row in the organizer sidebar.
    Sidebar,
    /// The query's tab handle in the tab bar.
    Tab,
}

/// An in-progress inline rename of a query.
pub(crate) struct Rename {
    pub(crate) id: Uuid,
    pub(crate) buffer: String,
    pub(crate) surface: RenameSurface,
    /// Set on the first frame so the field grabs focus and selects its text once.
    pub(crate) take_focus: bool,
}

/// A request to bring a result row into view, optionally selecting it. Keyboard
/// row navigation sets `select: false` (the selection is already updated), while
/// the now-playing "Locate" action sets `select: true` to jump-select the track.
#[derive(Clone, Copy)]
pub(crate) struct PendingScroll {
    pub(crate) row: usize,
    pub(crate) select: bool,
}

/// A delete awaiting confirmation in the modal dialog.
pub(crate) struct PendingDelete {
    pub(crate) id: Uuid,
    pub(crate) name: String,
    pub(crate) unsaved: bool,
}

// Several independent one-shot startup/UI flags; grouping them into a sub-struct
// wouldn't make any of them clearer.
#[allow(clippy::struct_excessive_bools)]
pub struct App {
    /// The open tabs, in display (tab-bar) order. Each is a [`Page`] — a query
    /// page (live/saved definition + cached results) or the singleton keyboard-
    /// shortcuts editor. In-memory only; the tab set is never persisted.
    pub(crate) pages: Vec<Page>,
    /// Metadata for every saved query in the backend (whether or not it's open
    /// in a tab). Drives the explorer's "Queries" section; kept in sync as
    /// queries are saved, renamed, and deleted.
    pub(crate) saved_queries: Vec<rpc::Query>,
    /// Tab-bar interaction state (the in-progress tab drag-to-reorder).
    pub(crate) tab_bar: tabs::TabBar,
    /// The currently displayed page.
    pub(crate) current: CurrentPage,
    /// Whether the one-time, on-open auto-selection of the most-recent query has
    /// happened yet. Keeps later list refreshes from hijacking the current page.
    pub(crate) auto_selected_initial: bool,
    /// Organizer name filter (in-memory only; issues no requests).
    pub(crate) filter: String,
    /// Inbox for an in-flight `query.list`; drained into `pages` on the next frame.
    pub(crate) loaded_queries: Arc<Mutex<Option<Vec<rpc::Query>>>>,
    pub(crate) queries_fetch_started: bool,
    pub(crate) selection: HashSet<usize>,
    pub(crate) selection_anchor: Option<usize>,
    /// The moving end of a keyboard row selection (the row an extend grows from);
    /// tracks the anchor for mouse selection. Drives `select_row_delta`.
    pub(crate) selection_lead: Option<usize>,
    pub(crate) organizer: Organizer,
    /// The in-progress inline rename, if any.
    pub(crate) rename: Option<Rename>,
    /// The query whose deletion is awaiting confirmation in the modal, if any.
    pub(crate) pending_delete: Option<PendingDelete>,
    /// Which query-builder section (filter/sort/display) is open, if any. Applies
    /// to sectioned mode only.
    pub(crate) builder_section: Option<Section>,
    /// Whether the full-querydown editor panel is open. Applies to full-querydown
    /// mode only (the "Querydown" toolbar toggle).
    pub(crate) full_editor_open: bool,
    /// The active section button's embedded "⋮" menu trigger, captured each
    /// frame by the menu bar so the builder panel (rendered just after) can
    /// anchor that section's options popup to the toolbar button.
    pub(crate) section_menu_anchor: Option<egui::Response>,
    /// Last measured natural height of the query-builder content, used to size
    /// the builder panel to fit its contents (see `render_builder_panel`).
    /// `None` until the first frame has measured it.
    pub(crate) builder_content_height: Option<f32>,
    /// All saved presets (every table and section), fetched at startup and kept
    /// in sync locally as the user adds/edits/deletes them.
    pub(crate) presets: Vec<rpc::Preset>,
    /// Inbox for an in-flight `preset.list`; drained into `presets` on the next frame.
    pub(crate) loaded_presets: Arc<Mutex<Option<Vec<rpc::Preset>>>>,
    pub(crate) presets_fetch_started: bool,
    /// The in-progress "save as preset" naming dialog, if any.
    pub(crate) preset_save: Option<PresetSave>,
    /// In-progress inline edits of presets, keyed by preset id. An entry exists
    /// once a preset has been expanded for editing, and persists thereafter (even
    /// when the preset is collapsed, the builder is closed, or the user navigates
    /// to a different query) so unsaved changes are never silently dropped. A
    /// preset is "dirty" when its entry differs from the saved preset.
    pub(crate) preset_edits: HashMap<Uuid, PresetEdit>,
    /// Which preset is currently expanded for editing in the builder, if any.
    /// Only one expands at a time. This expanded state is ephemeral to the open
    /// builder area: it is cleared whenever a builder section is opened, closed,
    /// or switched.
    pub(crate) expanded_preset: Option<Uuid>,
    /// Set when a builder section is (re)opened, so the builder focuses the right
    /// input once. Consumed on the next builder frame.
    pub(crate) builder_focus: bool,
    /// Whether the manage-presets modal is open.
    pub(crate) manage_presets: bool,
    /// Which preset is expanded for inline editing in the manage-presets modal,
    /// if any. Only one expands at a time. Independent of [`App::expanded_preset`]
    /// (the builder's expansion) so the two don't fight while the modal floats
    /// above the builder.
    pub(crate) manage_expanded: Option<Uuid>,
    /// The contents of the "View SQL" modal when open: either the pretty-printed
    /// SQL the current query would send to the query API, or a compile-error
    /// message to show in its place. `None` when the modal is closed.
    pub(crate) view_sql: Option<String>,
    pub(crate) current_track: Arc<Mutex<Option<CurrentTrack>>>,
    pub(crate) audio: Box<dyn AudioPlayer>,
    /// The `(id, title, artists)` last pushed to the OS media session, so we
    /// only update lock-screen metadata when the current track's details change.
    pub(crate) media_metadata_key: Option<(String, Option<String>, Vec<String>)>,
    /// A request to scroll a result row into view (and, when `select`, select it).
    /// Consumed by `render_results`.
    pub(crate) pending_scroll: Option<PendingScroll>,
    /// The resolved keyboard-shortcut map: built-in defaults with the user's
    /// persisted overrides layered on top.
    pub(crate) keymap: Keymap,
    /// The command palette's state when open (`None` when closed).
    pub(crate) palette: Option<palette::PaletteState>,
    /// Recently-used commands, most-recent first (session-only; not persisted).
    /// Drives the palette's default ordering.
    pub(crate) command_mru: Vec<CommandId>,
    /// Transient UI state for the keyboard-shortcuts editor tab.
    pub(crate) shortcuts: shortcuts_tab::ShortcutsUi,
    /// Inbox for an in-flight `keybinding.list`; drained into `keymap` next frame.
    pub(crate) loaded_keybindings: Arc<Mutex<Option<Vec<rpc::Keybinding>>>>,
    pub(crate) keybindings_fetch_started: bool,
    /// Database schema JSON, fetched once at startup and used to compile Querydown.
    pub(crate) schema: Arc<Mutex<Option<String>>>,
    pub(crate) schema_fetch_started: bool,
    /// Memoized result-row field layout, reused across rows and frames until the column
    /// set or available width changes.
    pub(crate) field_layout_cache: Option<(field_layout::LayoutKey, Rc<FieldLayout>)>,
    /// Inbox for finished record-editor data loads, each tagged with the token of
    /// the tree slot it belongs to; drained each frame into the open editor(s).
    pub(crate) form_inbox: Arc<Mutex<Vec<form::FormLoadMsg>>>,
    /// Monotonic source of form-load tokens (see [`form::FormCtx`]).
    pub(crate) form_load_seq: u64,
}

impl Default for App {
    fn default() -> Self {
        Self {
            pages: Vec::new(),
            saved_queries: Vec::new(),
            tab_bar: tabs::TabBar::default(),
            current: CurrentPage::default(),
            auto_selected_initial: false,
            filter: String::new(),
            loaded_queries: Arc::new(Mutex::new(None)),
            queries_fetch_started: false,
            selection: HashSet::new(),
            selection_anchor: None,
            selection_lead: None,
            organizer: Organizer::default(),
            rename: None,
            pending_delete: None,
            builder_section: None,
            full_editor_open: false,
            section_menu_anchor: None,
            builder_content_height: None,
            presets: Vec::new(),
            loaded_presets: Arc::new(Mutex::new(None)),
            presets_fetch_started: false,
            preset_save: None,
            preset_edits: HashMap::new(),
            expanded_preset: None,
            builder_focus: false,
            manage_presets: false,
            manage_expanded: None,
            view_sql: None,
            current_track: Arc::new(Mutex::new(None)),
            audio: audio::new_player(),
            media_metadata_key: None,
            pending_scroll: None,
            keymap: Keymap::default(),
            palette: None,
            command_mru: Vec::new(),
            shortcuts: shortcuts_tab::ShortcutsUi::default(),
            loaded_keybindings: Arc::new(Mutex::new(None)),
            keybindings_fetch_started: false,
            schema: Arc::new(Mutex::new(None)),
            schema_fetch_started: false,
            field_layout_cache: None,
            form_inbox: Arc::new(Mutex::new(Vec::new())),
            form_load_seq: 0,
        }
    }
}

impl eframe::App for App {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        self.render_root(ui);
    }
}

impl App {
    /// Renders the whole app into `ui`. Split out of [`eframe::App::ui`] (which
    /// just delegates here) so snapshot tests can drive the entire UI without
    /// constructing an [`eframe::Frame`], which `ui` never uses anyway.
    pub(crate) fn render_root(&mut self, ui: &mut egui::Ui) {
        let ctx = ui.ctx().clone();
        self.bootstrap(&ctx);
        self.drain_loaded_queries();
        self.drain_loaded_presets();
        self.drain_loaded_keybindings();
        self.drain_form_inbox();

        // Global keyboard shortcuts run before any panel so a matched chord's key
        // events are consumed before widgets (e.g. text fields) can see them.
        self.handle_global_shortcuts(&ctx);

        let panel_fill = ui.style().visuals.panel_fill;
        let persistent = ctx.viewport_rect().width() >= PERSISTENT_ORGANIZER_MIN_WIDTH;

        // A tab picks up edits as its own: once an unpinned (preview) tab becomes
        // dirty it's promoted to a pinned tab, so opening another query won't
        // silently discard the in-progress work. (Ephemeral tabs open pinned.)
        for page in self.pages.iter_mut().filter_map(Page::as_query_mut) {
            if !page.pinned && page.is_persisted() && page.unsaved() {
                page.pinned = true;
            }
        }

        self.ensure_current_results(&ctx);

        // On wide screens the organizer is a persistent left panel that reserves
        // its own space, so it must be added before the top/central panels for
        // them to lay out in the remaining area. The tab bar is added next so it
        // spans the area to the right of the sidebar (never over it), while the
        // sidebar extends to the very top of the screen alongside it.
        if persistent {
            self.render_persistent_organizer(ui, panel_fill);
        }

        // Top panels must be added before the central panel. The tab bar sits
        // above the query toolbar for every page type (it carries the explorer
        // toggle and the new-tab button even on the welcome page).
        self.render_tab_bar(ui);

        // The now-playing bar (bottom) and the record editor sidebar (right) are
        // added *before* the query builder toolbar so they reserve their space
        // first: the sidebar then spans the full height between the tab bar and
        // the now-playing bar, and pushes the builder toolbar (added next)
        // narrower — while the tab bar above stays full width.
        self.render_now_playing(ui);
        self.maybe_revalidate_current_track_index();
        self.render_record_editor_panel(ui);

        if let CurrentPage::Query(_) = self.current {
            self.render_menu_bar(ui);
            // In full mode the panel is the full-query editor (gated by its
            // own toggle); in sectioned mode it's the open builder section.
            let full_mode = self
                .current_page()
                .is_some_and(|p| p.live.definition.is_full());
            let show_builder = if full_mode {
                self.full_editor_open
            } else {
                self.builder_section.is_some()
            };
            if show_builder {
                self.render_builder_panel(ui);
            }
        }

        // Central panel.
        match self.current {
            CurrentPage::Query(_) => self.render_results(ui),
            CurrentPage::KeyboardShortcuts => self.render_shortcuts_page(ui),
            CurrentPage::Welcome => welcome::render_welcome_center(ui),
        }

        if persistent {
            // The persistent panel reserves real layout space, so the content
            // mustn't also be slid aside by the modal drawer's transform.
            ctx.set_transform_layer(egui::LayerId::background(), TSTransform::IDENTITY);
        } else {
            // On narrow screens the organizer is a modal drawer that slides over
            // the content (with a dimming scrim and swipe-to-close), pushing the
            // background layer aside as it opens.
            let progress = self.organizer_progress(&ctx);
            let organizer_offset = progress * ORGANIZER_WIDTH;
            ctx.set_transform_layer(
                egui::LayerId::background(),
                TSTransform::from_translation(egui::vec2(organizer_offset, 0.0)),
            );

            // Render while dragging even at progress == 0 so the widget that owns
            // the in-flight drag stays mounted and `drag_stopped` fires on release.
            if progress > 0.0 || self.organizer.dragging {
                self.render_organizer(&ctx, progress, panel_fill);
            }
        }

        // Modals float above everything else.
        self.render_delete_confirm(&ctx);
        self.render_preset_save_modal(&ctx);
        self.render_manage_presets_modal(&ctx);
        self.render_view_sql_modal(&ctx);
        self.render_command_palette(&ctx);
    }
}

impl App {
    /// Kicks off the one-time startup fetches (schema + saved query list).
    fn bootstrap(&mut self, ctx: &egui::Context) {
        if !self.schema_fetch_started {
            self.schema_fetch_started = true;
            http::fetch_schema(Arc::clone(&self.schema), ctx.clone());
        }
        if !self.queries_fetch_started {
            self.queries_fetch_started = true;
            rpc::list_queries(Arc::clone(&self.loaded_queries), ctx.clone());
        }
        if !self.presets_fetch_started {
            self.presets_fetch_started = true;
            rpc::list_presets(Arc::clone(&self.loaded_presets), ctx.clone());
        }
        if !self.keybindings_fetch_started {
            self.keybindings_fetch_started = true;
            rpc::list_keybindings(Arc::clone(&self.loaded_keybindings), ctx.clone());
        }
    }

    /// Routes each finished record-editor data load to the editor that owns its
    /// token. A message travels as an `Option` offered to every open editor in turn
    /// (see [`form::RecordEditor::deliver`]); the one holding the token consumes it,
    /// and an unclaimed message (its editor was closed mid-flight) is dropped.
    fn drain_form_inbox(&mut self) {
        let msgs = std::mem::take(&mut *self.form_inbox.lock().unwrap());
        for msg in msgs {
            let mut slot = Some(msg.result);
            for page in self.pages.iter_mut().filter_map(Page::as_query_mut) {
                if let Some(editor) = page.record_editor.as_mut() {
                    editor.deliver(msg.token, &mut slot);
                    if slot.is_none() {
                        break;
                    }
                }
            }
        }
    }

    /// If a `preset.list` response has arrived, replace the local preset list.
    fn drain_loaded_presets(&mut self) {
        if let Some(list) = self.loaded_presets.lock().unwrap().take() {
            self.presets = list;
        }
    }

    /// If a `keybinding.list` response has arrived, apply the persisted overrides
    /// on top of the built-in defaults.
    fn drain_loaded_keybindings(&mut self) {
        if let Some(list) = self.loaded_keybindings.lock().unwrap().take() {
            self.keymap
                .load_overrides(list.into_iter().map(|kb| (kb.command_id, kb.chord)));
        }
    }

    /// If a `query.list` response has arrived, refresh the saved-query list from
    /// it. Open tabs are left untouched (they carry their own live/saved state
    /// and cached results in memory), so a list refresh never re-runs an open
    /// query or discards unsaved edits. On the very first load, opens the
    /// most-recently-created saved query in a preview tab.
    fn drain_loaded_queries(&mut self) {
        let Some(list) = self.loaded_queries.lock().unwrap().take() else {
            return;
        };
        self.saved_queries = list;

        if !self.auto_selected_initial {
            self.auto_selected_initial = true;
            if let Some(id) = self
                .saved_queries
                .iter()
                .max_by_key(|q| q.created_at)
                .map(|q| q.id)
            {
                self.open_query(id);
            }
        }
        self.selection.clear();
        self.selection_anchor = None;
        self.selection_lead = None;
    }

    fn organizer_progress(&self, ctx: &egui::Context) -> f32 {
        let (anim_target, anim_time) = if self.organizer.dragging {
            (self.organizer.dragged_progress, 0.0)
        } else if self.organizer.open {
            (1.0, ORGANIZER_ANIM_TIME)
        } else {
            (0.0, ORGANIZER_ANIM_TIME)
        };
        ctx.animate_value_with_time(egui::Id::new("organizer_anim"), anim_target, anim_time)
    }

    /// Auto-fetches the current page's results the first time it's shown, so
    /// navigating to a query with a cold cache loads it without an explicit run.
    fn ensure_current_results(&mut self, ctx: &egui::Context) {
        if self.schema.lock().unwrap().is_none() {
            return;
        }
        let needs = self.current_page().is_some_and(|page| {
            !page.results_fetched
                && page.live.definition.is_runnable()
                && !page.results.lock().unwrap().running
        });
        if needs {
            self.run_query(ctx);
        }
    }

    pub(crate) fn current_page(&self) -> Option<&QueryPage> {
        self.find_query(self.current.query_id()?)
    }

    pub(crate) fn current_page_mut(&mut self) -> Option<&mut QueryPage> {
        self.find_query_mut(self.current.query_id()?)
    }

    /// The query page with id `id`, if one is open (skips non-query tabs).
    pub(crate) fn find_query(&self, id: Uuid) -> Option<&QueryPage> {
        self.pages
            .iter()
            .filter_map(Page::as_query)
            .find(|p| p.live.id == id)
    }

    /// Mutable [`find_query`].
    pub(crate) fn find_query_mut(&mut self, id: Uuid) -> Option<&mut QueryPage> {
        self.pages
            .iter_mut()
            .filter_map(Page::as_query_mut)
            .find(|p| p.live.id == id)
    }

    pub(crate) fn page_results(&self, id: Uuid) -> Option<Arc<Mutex<QueryState>>> {
        self.find_query(id).map(|p| Arc::clone(&p.results))
    }

    /// Creates a new ephemeral query (not yet persisted) and selects it, opening
    /// the filter builder with its custom input focused so the user can start
    /// typing immediately.
    pub(crate) fn add_query_page(&mut self) {
        let now = rpc::now_epoch();
        let query = rpc::Query {
            id: Uuid::new_v4(),
            name: rpc::now_name(),
            created_at: now,
            modified_at: now,
            last_play: now,
            definition: self.definition_for_base("track".to_string()),
        };
        let id = query.id;
        self.pages
            .push(Page::Query(Box::new(QueryPage::ephemeral(query))));
        self.select_page(id);
        self.expanded_preset = None;
        self.builder_section = Some(Section::Filter);
        self.builder_focus = true;
    }

    /// Creates a new ephemeral query copied from `id` and selects it. The copy's
    /// definition is taken from the source's `live` version, so any unsaved edits
    /// are carried into the duplicate; its name is computed like a freshly created
    /// query's (see [`rpc::now_name`]).
    pub(crate) fn duplicate_query(&mut self, id: Uuid) {
        let Some(source) = self.find_query(id) else {
            return;
        };
        let now = rpc::now_epoch();
        let query = rpc::Query {
            id: Uuid::new_v4(),
            name: rpc::now_name(),
            created_at: now,
            modified_at: now,
            last_play: now,
            definition: source.live.definition.clone(),
        };
        let new_id = query.id;
        self.pages
            .push(Page::Query(Box::new(QueryPage::ephemeral(query))));
        self.select_page(new_id);
    }

    /// A fresh definition for `base`, seeded with every default preset scoped to
    /// that base table. The filter section accepts any number of default presets;
    /// sort and display take only one, so the first default of each (presets are
    /// listed by name) wins.
    pub(crate) fn definition_for_base(&self, base: String) -> QueryDefinition {
        let mut def = QueryDefinition {
            base,
            ..Default::default()
        };
        for preset in &self.presets {
            if !preset.is_default || preset.base_table != def.base {
                continue;
            }
            match preset.section {
                Section::Filter => def.filter.presets.push(preset.id),
                Section::Sort if def.sort == SectionContent::default() => {
                    def.sort = SectionContent::Preset(preset.id);
                }
                Section::Display if def.display == SectionContent::default() => {
                    def.display = SectionContent::Preset(preset.id);
                }
                Section::Sort | Section::Display => {}
            }
        }
        def
    }

    /// Converts the current page's sectioned query into full-querydown mode by
    /// concatenating its resolved parts into one query, and opens the full-query
    /// editor so the result is immediately visible. A no-op if the query is
    /// already in full mode.
    pub(crate) fn convert_current_to_full(&mut self) {
        let full = match self.current_page() {
            Some(page) if !page.live.definition.is_full() => {
                page.live.definition.to_full_query(&self.presets)
            }
            _ => return,
        };
        if let Some(page) = self.current_page_mut() {
            page.live.definition.full = Some(full);
        }
        self.full_editor_open = true;
    }

    pub(crate) fn select_page(&mut self, id: Uuid) {
        self.current = self
            .pages
            .iter()
            .find(|p| p.id() == id)
            .map_or(CurrentPage::Query(id), Page::marker);
        self.selection.clear();
        self.selection_anchor = None;
        self.selection_lead = None;
    }

    /// Opens the saved query `id` in a tab and selects it. If it's already open,
    /// just selects that tab (leaving its pin state alone). Otherwise it opens as
    /// an unpinned "preview" tab, reusing the slot of the existing unpinned tab
    /// (there is at most one) so casual browsing doesn't pile up tabs — VS Code's
    /// preview-tab behaviour. Reusing the slot drops the old page, clearing its
    /// cached results.
    pub(crate) fn open_query(&mut self, id: Uuid) {
        if self.pages.iter().any(|p| p.id() == id) {
            self.select_page(id);
            return;
        }
        let Some(query) = self.saved_queries.iter().find(|q| q.id == id).cloned() else {
            return;
        };
        let page = Page::Query(Box::new(QueryPage::persisted(query))); // opens unpinned (preview)
        if let Some(slot) = self.pages.iter().position(|p| !p.pinned()) {
            self.pages[slot] = page;
        } else {
            self.pages.push(page);
        }
        self.select_page(id);
    }

    /// Closes the tab for `id`, dropping its cached result set from memory. If it
    /// was the current tab, selects an adjacent tab (the one that slid into its
    /// slot, else the previous one), or the welcome page if none remain.
    pub(crate) fn close_tab(&mut self, id: Uuid) {
        let Some(idx) = self.pages.iter().position(|p| p.id() == id) else {
            return;
        };
        let was_current = self.current.page_id() == Some(id);
        // Dropping the page releases its `results` Arc, freeing the result set.
        self.pages.remove(idx);
        if self.rename.as_ref().is_some_and(|r| r.id == id) {
            self.rename = None;
        }
        if was_current {
            let next = self
                .pages
                .get(idx)
                .or_else(|| idx.checked_sub(1).and_then(|i| self.pages.get(i)));
            self.current = next.map_or(CurrentPage::Welcome, Page::marker);
            self.selection.clear();
            self.selection_anchor = None;
            self.selection_lead = None;
        }
    }

    /// Toggles whether the tab for `id` is pinned. Only query tabs pin.
    pub(crate) fn toggle_pin(&mut self, id: Uuid) {
        if let Some(page) = self.find_query_mut(id) {
            page.pinned = !page.pinned;
        }
    }

    /// Pins the tab for `id` (a no-op if it's already pinned or not an open query).
    pub(crate) fn pin_tab(&mut self, id: Uuid) {
        if let Some(page) = self.find_query_mut(id) {
            page.pinned = true;
        }
    }

    /// Moves the tab `id` to index `to` in the tab order (clamped in range),
    /// backing tab drag-to-reorder.
    pub(crate) fn move_tab(&mut self, id: Uuid, to: usize) {
        let Some(from) = self.pages.iter().position(|p| p.id() == id) else {
            return;
        };
        let to = to.min(self.pages.len().saturating_sub(1));
        if from == to {
            return;
        }
        let page = self.pages.remove(from);
        self.pages.insert(to, page);
    }

    /// Inserts or replaces the saved-query metadata for `query`, keeping the
    /// explorer's "Queries" section in sync as queries are saved and renamed.
    fn upsert_saved_query(&mut self, query: rpc::Query) {
        if let Some(existing) = self.saved_queries.iter_mut().find(|q| q.id == query.id) {
            *existing = query;
        } else {
            self.saved_queries.push(query);
        }
    }

    /// Starts an inline rename of `id`, seeding the edit buffer with the current
    /// name. `surface` records where the rename was triggered so only that
    /// surface renders the field.
    pub(crate) fn begin_rename(&mut self, id: Uuid, surface: RenameSurface) {
        // A rename can be started from the Queries list for a query that isn't
        // open in a tab; seed the edit buffer from whichever record we have.
        let name = self
            .find_query(id)
            .map(|p| p.live.name.clone())
            .or_else(|| {
                self.saved_queries
                    .iter()
                    .find(|q| q.id == id)
                    .map(|q| q.name.clone())
            });
        let Some(name) = name else {
            return;
        };
        // Renaming is an explicit "keep" signal, so pin the tab (if it's open).
        self.pin_tab(id);
        self.rename = Some(Rename {
            id,
            buffer: name,
            surface,
            take_focus: true,
        });
    }

    /// Commits the in-progress rename. An empty/whitespace-only name is rejected
    /// and treated as a cancel. For a persisted query the new name is pushed to
    /// the backend immediately and mirrored into the saved snapshot, so the
    /// rename doesn't register as an unsaved (blue-dot) change.
    pub(crate) fn commit_rename(&mut self) {
        let Some(state) = self.rename.take() else {
            return;
        };
        let name = state.buffer.trim().to_string();
        if name.is_empty() {
            return;
        }
        let id = state.id;
        let mut persisted = false;
        // Update the open tab, if any (its live name, plus the saved snapshot so
        // the rename doesn't register as an unsaved change).
        if let Some(page) = self.find_query_mut(id) {
            if page.live.name == name {
                return;
            }
            page.live.name.clone_from(&name);
            if let Some(saved) = page.saved.as_mut() {
                saved.name.clone_from(&name);
                persisted = true;
            }
        }
        // Keep the saved-query record (present iff persisted) in sync so the
        // Queries list reflects the new name whether or not the query is open.
        if let Some(query) = self.saved_queries.iter_mut().find(|q| q.id == id) {
            query.name.clone_from(&name);
            persisted = true;
        }
        if persisted {
            rpc::rename_query(id, &name);
        }
    }

    /// Abandons the in-progress rename, restoring the original name.
    pub(crate) fn cancel_rename(&mut self) {
        self.rename = None;
    }

    /// Discards a query's unsaved edits, restoring its `live` version from the
    /// last-saved snapshot. A no-op for a never-saved query (nothing to revert
    /// to). Also cancels any in-progress rename of the query, since reverting
    /// restores its saved name.
    pub(crate) fn revert_query(&mut self, id: Uuid) {
        let Some(page) = self.find_query_mut(id) else {
            return;
        };
        let Some(saved) = page.saved.clone() else {
            return;
        };
        page.live = saved;
        if self.rename.as_ref().is_some_and(|r| r.id == id) {
            self.rename = None;
        }
    }

    /// Opens the delete-confirmation modal for `id`. The query may be open in a
    /// tab or only listed in the Queries section, so its name/unsaved state is
    /// taken from whichever record exists.
    pub(crate) fn request_delete(&mut self, id: Uuid) {
        let pending = self
            .find_query(id)
            .map(|page| PendingDelete {
                id,
                name: page.live.name.clone(),
                unsaved: page.unsaved(),
            })
            .or_else(|| {
                self.saved_queries
                    .iter()
                    .find(|q| q.id == id)
                    .map(|q| PendingDelete {
                        id,
                        name: q.name.clone(),
                        unsaved: false,
                    })
            });
        if let Some(pending) = pending {
            self.pending_delete = Some(pending);
        }
    }

    /// Deletes a query: closes its tab (dropping its results), removes it from
    /// the saved-query list, and deletes it on the backend if it was persisted.
    /// Closing the tab handles navigating away if it was the current page.
    pub(crate) fn delete_query(&mut self, id: Uuid) {
        let persisted = self.saved_queries.iter().any(|q| q.id == id)
            || self.find_query(id).is_some_and(QueryPage::is_persisted);
        self.saved_queries.retain(|q| q.id != id);
        if persisted {
            rpc::delete_query(id);
        }
        self.close_tab(id);
    }

    /// Renders the delete-confirmation modal when a delete is pending. Confirming
    /// performs the delete; cancelling (button, backdrop click, or Esc) dismisses.
    pub(crate) fn render_delete_confirm(&mut self, ctx: &egui::Context) {
        let Some(pending) = self.pending_delete.as_ref() else {
            return;
        };
        let id = pending.id;
        let name = pending.name.clone();
        let unsaved = pending.unsaved;
        let mut confirm = false;
        let mut cancel = false;

        let modal = egui::Modal::new(egui::Id::new("delete_query_confirm")).show(ctx, |ui| {
            ui.set_max_width(280.0);
            ui.heading("Delete query");
            ui.add_space(8.0);
            ui.label(format!("Delete \u{201c}{name}\u{201d}?"));
            if unsaved {
                ui.add_space(4.0);
                ui.colored_label(
                    ACCENT_BLUE.get(ui.visuals()),
                    "This query has unsaved changes.",
                );
            }
            ui.add_space(12.0);
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui
                    .add(
                        egui::Button::new(
                            egui::RichText::new("Delete").color(egui::Color32::WHITE),
                        )
                        .fill(page::DELETE_RED.get(ui.visuals())),
                    )
                    .clicked()
                {
                    confirm = true;
                }
                if ui.button("Cancel").clicked() {
                    cancel = true;
                }
            });
        });

        if modal.should_close() {
            cancel = true;
        }
        if confirm {
            self.pending_delete = None;
            self.delete_query(id);
        } else if cancel {
            self.pending_delete = None;
        }
    }

    /// Compiles the current page's live query into the `DuckDB` SQL that would be
    /// sent to the query API, returning the SQL or a compile-error message. This
    /// mirrors the compilation [`run_query`](Self::run_query) performs, but stops
    /// at the SQL string and runs nothing.
    fn current_query_sql(&self) -> Result<String, String> {
        let definition = self
            .current_page()
            .map(|p| p.live.definition.clone())
            .ok_or_else(|| "No query is open.".to_string())?;
        let presets = self.effective_presets();
        let schema = self.schema.lock().unwrap();
        match (definition.assemble(&presets), schema.as_deref()) {
            (Err(e), _) => Err(e),
            (_, None) => Err("Schema not loaded yet. Please try again in a moment.".to_string()),
            (Ok(source), Some(schema_json)) => {
                compile::querydown_to_duckdb(&source, schema_json).map(|c| c.sql)
            }
        }
    }

    /// Opens the "View SQL" modal, populating it with the current query's compiled
    /// SQL (pretty-formatted) or, if compilation fails, the error message.
    pub(crate) fn open_view_sql(&mut self) {
        self.view_sql = Some(match self.current_query_sql() {
            Ok(sql) => format_sql(&sql),
            Err(e) => e,
        });
    }

    /// Renders the "View SQL" modal when open: a scrollable, selectable view of the
    /// compiled SQL with a button to copy it to the clipboard. Closing (button,
    /// backdrop click, or Esc) dismisses it. The modal sizes itself to the viewport
    /// so it stays usable on small windows.
    pub(crate) fn render_view_sql_modal(&mut self, ctx: &egui::Context) {
        let Some(sql) = self.view_sql.as_ref() else {
            return;
        };
        let sql = sql.clone();
        let mut close = false;
        // Size the modal to the viewport so it stays usable on small (e.g. mobile)
        // windows. Width caps at a comfortable reading width but shrinks to fit
        // narrow screens. Height is bounded by `set_max_height` below so the modal
        // shrinks to fit short screens; the scroll area then absorbs all of that
        // shrinkage while the heading and footer keep their natural height.
        let screen = ctx.content_rect();
        let width = (screen.width() - 2.0 * VIEW_SQL_VIEWPORT_MARGIN).clamp(120.0, 560.0);
        let max_height = (screen.height() - 2.0 * VIEW_SQL_VIEWPORT_MARGIN).max(120.0);
        let modal = egui::Modal::new(egui::Id::new("view_sql")).show(ctx, |ui| {
            ui.set_width(width);
            ui.set_max_height(max_height);
            ui.heading("SQL");
            ui.add_space(8.0);
            // Fill the space between the heading and the fixed-height footer with the
            // scrollable SQL. Deriving its height from the remaining `available_height`
            // (which already accounts for the heading and the `set_max_height` bound)
            // keeps the footer pinned just below the SQL and the whole modal inside the
            // viewport, regardless of the heading's font metrics or the screen size.
            let scroll_height = (ui.available_height() - VIEW_SQL_FOOTER_HEIGHT).clamp(48.0, 480.0);
            // Vertical-only scrolling with wrapped text: long SQL lines wrap to the
            // modal width rather than scrolling sideways (better on small/mobile
            // viewports), and dropping the horizontal scrollbar lets the scroll area
            // shrink to the content so the footer hugs the SQL instead of floating
            // below a reserved scrollbar.
            egui::ScrollArea::vertical()
                .max_height(scroll_height)
                .auto_shrink([false, true])
                .show(ui, |ui| {
                    ui.add(
                        egui::Label::new(egui::RichText::new(&sql).monospace())
                            .selectable(true)
                            .wrap_mode(egui::TextWrapMode::Wrap),
                    );
                });
            ui.add_space(12.0);
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.button("Close").clicked() {
                    close = true;
                }
                if ui.button("Copy").clicked() {
                    ui.ctx().copy_text(sql.clone());
                }
            });
        });
        if close || modal.should_close() {
            self.view_sql = None;
        }
    }

    /// The primary-key column of `base`, per Collectune's convention, or `None`
    /// when the schema isn't loaded, `base` is unknown, or the table has only a
    /// composite key. See [`form::primary_key`].
    fn base_primary_key(&self, base: &str) -> Option<String> {
        let json = self.schema.lock().unwrap().clone()?;
        let schema = introspection::Schema::parse(&json).ok()?;
        let table = schema.table(base)?;
        form::primary_key(table).map(str::to_owned)
    }

    /// Opens the record editor sidebar on the current query page, for a record
    /// from the `base` table: builds the form structure from the introspected
    /// schema and seeds the primary-key id so the form shows which record it's
    /// editing. A no-op if there's no current query page, the schema isn't loaded
    /// yet, or `base` isn't a known table.
    pub(crate) fn open_record_editor(&mut self, base: &str, record_id: Option<String>) {
        let Some(schema_json) = self.schema.lock().unwrap().clone() else {
            return;
        };
        let Ok(schema) = introspection::Schema::parse(&schema_json) else {
            return;
        };
        let Some(editor) = form::RecordEditor::structure(&schema, base) else {
            return;
        };
        // Seed the identifying key so the form knows which record to fetch. When the
        // record is keyed by a single id column and we know its value, use it;
        // otherwise the form opens keyed only structurally (its values won't load
        // until a key is known).
        let editor = match (record_id, schema.table(base).and_then(form::primary_key)) {
            (Some(id), Some(pk)) => editor.with_key(vec![(pk.to_owned(), id)]),
            _ => editor,
        };
        if let Some(page) = self.current_page_mut() {
            page.record_editor = Some(editor);
        }
    }

    /// Renders the current query page's record editor as a resizable right-hand
    /// sidebar when one is open. The toolbar is pinned to the top and the fields
    /// scroll below it. Clicking *Cancel* closes the sidebar (dropping the form).
    /// A no-op when the current page has no editor open. Because the editor lives
    /// on the page, switching tabs shows each page's own editor (or none).
    pub(crate) fn render_record_editor_panel(&mut self, ui: &mut egui::Ui) {
        // Take the editor out of its page for the duration of the render so the
        // closures can borrow it freely; put it back unless Cancel was clicked.
        let Some(mut editor) = self.current_page_mut().and_then(|p| p.record_editor.take()) else {
            return;
        };
        let mut keep = true;
        let panel_fill = ui.visuals().panel_fill;

        // Everything the form needs to fetch data, extracted into locals so the
        // render closures borrow these (not `self`). The token counter round-trips
        // through `seq`. When the schema isn't loaded the form still renders (via
        // `None`), it just can't dispatch queries yet.
        let schema_json = self.schema.lock().unwrap().clone();
        let schema = schema_json
            .as_deref()
            .and_then(|j| introspection::Schema::parse(j).ok());
        let presets = self.presets.clone();
        let egui_ctx = ui.ctx().clone();
        let inbox = Arc::clone(&self.form_inbox);
        let mut seq = self.form_load_seq;
        // `form_ctx` borrows `seq`; confine it to this block so the borrow ends
        // (and `seq` can be written back) once the panel has rendered.
        let inner_rect = {
            let mut form_ctx = match (&schema, &schema_json) {
                (Some(schema), Some(json)) => Some(form::FormCtx {
                    schema,
                    schema_json: json,
                    presets: &presets,
                    egui_ctx: &egui_ctx,
                    inbox: &inbox,
                    next_token: &mut seq,
                }),
                _ => None,
            };
            let inner = egui::Panel::right("record_editor")
                .resizable(true)
                .default_size(360.0)
                .size_range(300.0..=620.0)
                // Zero inner margin on the panel itself so the toolbar's bottom border
                // spans the full sidebar width; the toolbar and body inset their own
                // content below.
                .frame(egui::Frame::new().fill(panel_fill))
                .show_inside(ui, |ui| {
                    // Toolbar: a fixed-height top panel matched to the query builder
                    // toolbar's height. Its bottom separator line supplies the
                    // full-width border under the toolbar.
                    egui::Panel::top("record_editor_toolbar")
                        .exact_size(form::TOOLBAR_HEIGHT)
                        .frame(
                            egui::Frame::new()
                                .fill(panel_fill)
                                .inner_margin(egui::Margin::symmetric(8, 0)),
                        )
                        .show_inside(ui, |ui| {
                            if editor.toolbar(ui).cancel {
                                keep = false;
                            }
                        });
                    // Body: the scrolling field list, inset from the panel edges.
                    egui::CentralPanel::default()
                        .frame(
                            egui::Frame::new()
                                .fill(panel_fill)
                                .inner_margin(egui::Margin {
                                    left: 8,
                                    right: 8,
                                    top: 0,
                                    bottom: 6,
                                }),
                        )
                        .show_inside(ui, |ui| {
                            egui::ScrollArea::vertical()
                                .auto_shrink([false, false])
                                .show(ui, |ui| {
                                    editor.body(ui, form_ctx.as_mut());
                                });
                        });
                });
            inner.response.rect
        };

        // A soft shadow down the panel's left edge lifts the sidebar above the
        // results and the builder toolbar. Painted on a layer above the
        // background panels (so it shows over them) as pure paint, so it never
        // intercepts pointer input.
        paint_left_shadow(ui.ctx(), inner_rect);

        // Persist the tokens the form handed out this frame.
        self.form_load_seq = seq;

        if keep && let Some(page) = self.current_page_mut() {
            page.record_editor = Some(editor);
        }
    }

    /// Keeps the current page's record editor in step with the result selection:
    /// closes it when nothing is selected, and re-points it at the newly selected
    /// record when a single, *different* record is selected. Multi-selection is
    /// left alone (bulk editing isn't supported yet). Called only after
    /// user-driven selection changes (row clicks, keyboard navigation) — never on
    /// a tab switch, which clears the selection programmatically and would
    /// otherwise spuriously close a page's editor.
    pub(crate) fn reconcile_record_editor_selection(&mut self) {
        let Some(page) = self.current_page() else {
            return;
        };
        // Nothing to reconcile unless an editor is open on this page.
        if page.record_editor.is_none() {
            return;
        }
        let base = page.live.definition.base.clone();
        let current_id = page
            .record_editor
            .as_ref()
            .and_then(|e| e.record_id().map(str::to_owned));
        // Own the results handle so the immutable borrow of `page` (and thus
        // `self`) ends here, freeing `self` for the mutable calls below.
        let results = Arc::clone(&page.results);

        if self.selection.is_empty() {
            // The user deselected the record — close the editor.
            if let Some(page) = self.current_page_mut() {
                page.record_editor = None;
            }
            return;
        }
        if self.selection.len() > 1 {
            // Multiple records selected: bulk editing isn't supported, so leave
            // the editor on whichever record it was already showing.
            return;
        }
        let index = *self.selection.iter().next().unwrap();
        let selected_id = {
            let state = results.lock().unwrap();
            state
                .record_id_column
                .and_then(|col| state.rows.cell_text(index, col))
        };
        // Propagate only a genuinely different id (an equal or missing id leaves
        // the editor untouched).
        if let Some(new_id) = selected_id
            && current_id.as_deref() != Some(new_id.as_str())
        {
            self.open_record_editor(&base, Some(new_id));
        }
    }

    /// Compiles and runs the current page's live query, replacing its results.
    pub(crate) fn run_query(&mut self, ctx: &egui::Context) {
        let Some((results, definition)) = self
            .current_page()
            .map(|p| (Arc::clone(&p.results), p.live.definition.clone()))
        else {
            return;
        };
        let ctx = ctx.clone();

        self.selection.clear();
        self.selection_anchor = None;
        self.selection_lead = None;
        if let Some(page) = self.current_page_mut() {
            page.results_fetched = true;
        }

        {
            let mut s = results.lock().unwrap();
            // Leave `rows` as-is: the previous results stay on screen (dimmed)
            // until the reload's first batch arrives (or it completes with none —
            // see `http::push_batch`/`http::finish`), rather than blanking the
            // pane while the new run is in flight.
            s.columns.clear();
            s.error = None;
            s.running = true;
            s.awaiting_first_batch = true;
            s.track_id_column = None;
            s.record_id_column = None;
            s.lineage_done = false;
            s.needs_revalidation = true;
        }

        // Resolve the four query parts into per-section Querydown source, then
        // compile it into DuckDB SQL before running it.
        let presets = self.effective_presets();
        let compiled = {
            let schema = self.schema.lock().unwrap();
            match (definition.assemble(&presets), schema.as_deref()) {
                (Err(e), _) => Err(e),
                (_, None) => {
                    Err("Schema not loaded yet. Please try again in a moment.".to_string())
                }
                (Ok(source), Some(schema_json)) => {
                    compile::querydown_to_duckdb(&source, schema_json)
                }
            }
        };
        let sql = match compiled {
            Ok(compiled) => {
                let mut s = results.lock().unwrap();
                s.columns = compiled.columns;
                compiled.sql
            }
            Err(e) => {
                let mut s = results.lock().unwrap();
                s.error = Some(e);
                s.running = false;
                drop(s);
                ctx.request_repaint();
                return;
            }
        };

        let base_table = definition.base.clone();
        let base_pk = self.base_primary_key(&base_table);
        lineage::detect_id_columns(
            sql.clone(),
            base_table,
            base_pk,
            Arc::clone(&results),
            ctx.clone(),
        );
        http::run_query(sql, &results, &ctx);
    }

    /// Persists the current page's live query. A no-op unless a query tab is
    /// active. See [`save_page`](Self::save_page).
    pub(crate) fn save_current(&mut self) {
        if let Some(id) = self.current.query_id() {
            self.save_page(id);
        }
    }

    /// Persists every open query tab that has unsaved changes.
    pub(crate) fn save_all_unsaved(&mut self) {
        let ids: Vec<Uuid> = self
            .pages
            .iter()
            .filter_map(Page::as_query)
            .filter(|p| p.unsaved())
            .map(|p| p.live.id)
            .collect();
        for id in ids {
            self.save_page(id);
        }
    }

    /// Persists the query page `id`. Inserts it if it's new, otherwise updates its
    /// definition; either way bumps `modified_at` and pins the tab.
    fn save_page(&mut self, id: Uuid) {
        let Some(page) = self.find_query_mut(id) else {
            return;
        };
        page.live.modified_at = rpc::now_epoch();
        // A saved query is one the user means to keep, so its tab is pinned.
        page.pinned = true;
        let snapshot = page.live.clone();
        let was_persisted = page.saved.is_some();
        page.saved = Some(snapshot.clone());
        if was_persisted {
            rpc::update_definition(snapshot.id, &snapshot.definition, snapshot.modified_at);
        } else {
            rpc::add_query(&snapshot);
        }
        // Reflect the new/updated query in the explorer's Queries section.
        self.upsert_saved_query(snapshot);
    }

    /// Plays a track that was located on `source_page`, recording the play
    /// against that query's `last_play`.
    pub(crate) fn play_track(
        &mut self,
        source_page: Uuid,
        index: usize,
        id: &str,
        ctx: &egui::Context,
    ) {
        {
            let mut ct = self.current_track.lock().unwrap();
            *ct = Some(CurrentTrack {
                source_page,
                id: id.to_string(),
                row_index: Some(index),
                title: None,
                artist_names: Vec::new(),
            });
        }
        // Hand the audio player the whole play context around this track — what
        // came before (for "previous") and what comes after (for "next" and
        // auto-advance) — so it can navigate on its own, including while the tab
        // is backgrounded and egui isn't painting (see `AudioPlayer::set_playlist`).
        let (preceding, upcoming) = self.playlist_around(source_page, index);
        self.audio.set_playlist(preceding, id, upcoming);
        // Force the next paint to push fresh media-session metadata even if the
        // same track id is replayed.
        self.media_metadata_key = None;
        http::fetch_track_metadata(id, &self.current_track, ctx);

        // Record the play on the originating query. Updating both live and saved
        // equally keeps `last_play` out of the unsaved comparison.
        self.record_play(source_page);
    }

    /// Opens (or focuses) the singleton Keyboard Shortcuts editor tab.
    pub(crate) fn open_keyboard_shortcuts(&mut self) {
        if !self
            .pages
            .iter()
            .any(|p| matches!(p, Page::KeyboardShortcuts))
        {
            self.pages.push(Page::KeyboardShortcuts);
        }
        self.current = CurrentPage::KeyboardShortcuts;
        self.selection.clear();
        self.selection_anchor = None;
        self.selection_lead = None;
    }

    /// Records that a command was just used, moving it to the front of the MRU
    /// list (capped) so the palette can surface recent commands first.
    pub(crate) fn record_command_use(&mut self, cmd: CommandId) {
        self.command_mru.retain(|c| *c != cmd);
        self.command_mru.insert(0, cmd);
        self.command_mru.truncate(10);
    }
}

/// Pretty-formats `DuckDB` `sql` for display in the "View SQL" modal, using
/// `polyglot-sql`. Statements are joined with blank lines (the formatter returns
/// one per statement). Falls back to the raw SQL if it can't be parsed/formatted,
/// so the user always sees something they can copy.
fn format_sql(sql: &str) -> String {
    match polyglot_sql::format(sql, polyglot_sql::DialectType::DuckDB) {
        Ok(statements) if !statements.is_empty() => statements.join(";\n\n"),
        _ => sql.to_owned(),
    }
}

/// Paints a soft drop shadow fading leftward off the left edge of `panel_rect`,
/// giving the record editor sidebar depth over the content beneath it. Drawn on
/// a layer above the background panels so it shows over the results and builder
/// toolbar, but as pure paint (no `interact`) so it never eats pointer input.
fn paint_left_shadow(ctx: &egui::Context, panel_rect: egui::Rect) {
    /// How far the shadow reaches out from the panel edge.
    const WIDTH: f32 = 12.0;

    let painter = ctx.layer_painter(egui::LayerId::new(
        egui::Order::Middle,
        egui::Id::new("record_editor_shadow"),
    ));
    // Darkest against the panel edge, fading to fully transparent outward. A
    // touch stronger on dark theme, where a fainter shadow would vanish.
    let edge = if ctx.theme() == egui::Theme::Dark {
        egui::Color32::from_black_alpha(90)
    } else {
        egui::Color32::from_black_alpha(28)
    };
    let clear = egui::Color32::TRANSPARENT;
    let x_edge = panel_rect.left();
    let x_out = x_edge - WIDTH;
    let (y_top, y_bot) = (panel_rect.top(), panel_rect.bottom());

    let mut mesh = egui::Mesh::default();
    mesh.colored_vertex(egui::pos2(x_out, y_top), clear);
    mesh.colored_vertex(egui::pos2(x_out, y_bot), clear);
    mesh.colored_vertex(egui::pos2(x_edge, y_top), edge);
    mesh.colored_vertex(egui::pos2(x_edge, y_bot), edge);
    mesh.add_triangle(0, 1, 2);
    mesh.add_triangle(2, 1, 3);
    painter.add(egui::Shape::mesh(mesh));
}

#[cfg(test)]
mod tests {
    use super::{App, form, format_sql};

    #[test]
    fn format_sql_pretty_prints() {
        // A single-line query gains line breaks once pretty-formatted.
        let out = format_sql("select a, b from t where a > 1");
        assert!(out.contains('\n'), "expected multi-line output, got: {out}");
        assert!(out.to_uppercase().contains("SELECT"));
    }

    /// `open_record_editor` parses the loaded schema, builds the form structure
    /// for the base table, and seeds the record's id — the whole context-menu
    /// "Edit {base}" outcome, minus the UI event plumbing.
    #[test]
    fn open_record_editor_builds_form_and_seeds_id() {
        let schema = r#"{ "tables": [
            { "name": "track", "unique_constraints": [["id"]], "columns": [
                { "name": "id", "type": "UUID", "nullable": false },
                { "name": "title", "type": "VARCHAR", "nullable": true },
                { "name": "album", "type": "UUID", "nullable": true }
            ] },
            { "name": "album", "unique_constraints": [["id"]], "columns": [
                { "name": "id", "type": "UUID", "nullable": false }
            ] },
            { "name": "credit", "unique_constraints": [["track", "artist"]], "columns": [
                { "name": "track", "type": "UUID", "nullable": false },
                { "name": "artist", "type": "UUID", "nullable": false }
            ] }
        ], "links": [] }"#;
        let mut app = App::default();
        *app.schema.lock().unwrap() = Some(schema.to_string());
        // The editor lives on the current query page, so open one first.
        app.add_query_page();

        app.open_record_editor("track", Some("abc-123".to_string()));

        let editor = app
            .current_page()
            .and_then(|p| p.record_editor.as_ref())
            .expect("editor should open");
        assert_eq!(editor.base_table, "track");
        // The record id is tracked on the editor for selection comparisons.
        assert_eq!(editor.record_id(), Some("abc-123"));
        // The id field is seeded with the record's id.
        let id_field = editor.fields.iter().find(|f| f.name == "id").unwrap();
        assert!(matches!(
            &id_field.kind,
            form::FieldKind::Primitive { ty: form::Primitive::Id, value: Some(v) } if v == "abc-123"
        ));
        // `album` (a UUID named after a table) is a scalar link; `credit`
        // (references track) is a multi-record field.
        assert!(
            editor
                .fields
                .iter()
                .any(|f| f.name == "album" && matches!(f.kind, form::FieldKind::ScalarLink { .. }))
        );
        assert!(
            editor.fields.iter().any(
                |f| f.name == "credit" && matches!(f.kind, form::FieldKind::MultiRecord { .. })
            )
        );
    }

    /// A form isn't opened when the base table isn't in the schema.
    #[test]
    fn open_record_editor_ignores_unknown_base() {
        let mut app = App::default();
        *app.schema.lock().unwrap() = Some(r#"{ "tables": [], "links": [] }"#.to_string());
        app.add_query_page();
        app.open_record_editor("track", None);
        assert!(app.current_page().unwrap().record_editor.is_none());
    }
}

#[cfg(test)]
mod view_sql_snapshot_tests {
    //! Snapshot tests for the "View SQL" modal's responsive sizing, driving the
    //! real [`App::render_view_sql_modal`] so the snapshots track the actual modal
    //! code. The invariant: the footer (button row) keeps a constant height and
    //! stays hugging the SQL, while the modal as a whole shrinks to fit short
    //! viewports. `tall` shows the whole (wrapped) query; `short` shows it clipped
    //! into a modal squeezed by the viewport. Generate or refresh with
    //! `UPDATE_SNAPSHOTS=1 cargo test -p frontend`.

    use eframe::egui;

    use crate::App;
    use crate::snapshot_harness::{self, snapshot_dual};

    /// A long, wide block of SQL: tall enough to overflow the scroll area and with a
    /// line long enough to exercise wrapping at a narrow modal width.
    const SAMPLE_SQL: &str = "\
WITH \"cte0\" AS (\n  \
  SELECT\n    \
    \"credit\".\"track\" AS \"pk\"\n  \
  FROM \"credit\"\n  \
  JOIN \"artist\"\n    \
    ON \"credit\".\"artist\" = \"artist\".\"id\"\n  \
  WHERE\n    \
    COALESCE(CONTAINS(LOWER(STRIP_ACCENTS(\"artist\".\"name\")), LOWER(STRIP_ACCENTS('x'))), FALSE)\n  \
  GROUP BY\n    \
    \"credit\".\"track\"\n\
), \"cte1\" AS (\n  \
  SELECT\n    \
    \"play\".\"track\" AS \"pk\",\n    \
    COUNT(*) AS \"v1\"\n  \
  FROM \"play\"\n  \
  GROUP BY\n    \
    \"play\".\"track\"\n\
)\nSELECT\n  \
  \"track\".\"id\" AS \"id\",\n  \
  \"track\".\"title\" AS \"title\"\nFROM \"track\"\n\
LEFT JOIN \"cte0\" ON \"cte0\".\"pk\" = \"track\".\"id\"\n\
LEFT JOIN \"cte1\" ON \"cte1\".\"pk\" = \"track\".\"id\"\n\
ORDER BY\n  \"track\".\"title\"";

    /// Renders the modal at `size` (logical points) into `view_sql_modal/<name>`.
    fn snapshot(name: &str, size: egui::Vec2) {
        let mut app = App {
            view_sql: Some(SAMPLE_SQL.to_owned()),
            ..Default::default()
        };
        // The modal is a `ctx`-level floating area, so we drive it via `ui.ctx()`
        // rather than the passed `ui`.
        let mut harness = snapshot_harness::harness(size, move |ui| {
            app.render_view_sql_modal(ui.ctx());
        });
        harness.run();
        snapshot_dual(&mut harness, &format!("view_sql_modal/{name}"));
    }

    #[test]
    fn tall() {
        // Tall enough that the whole (wrapped) query fits: the footer hugs the SQL.
        snapshot("tall", egui::vec2(480.0, 620.0));
    }

    #[test]
    fn short() {
        // Short viewport: the modal shrinks, the SQL clips, the footer stays put.
        snapshot("short", egui::vec2(480.0, 260.0));
    }
}
