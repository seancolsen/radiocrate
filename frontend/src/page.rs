//! The "pages" abstraction: the organizer is a page switcher, and everything in
//! the rest of the app renders the currently selected page. A query page is the
//! first (and currently only) page type; settings/playlist/artist pages will
//! follow the same shape.

use std::sync::{Arc, Mutex};

use eframe::egui;
use uuid::Uuid;

use crate::QueryState;
use crate::button::Button;
use crate::icons;
use crate::now_playing::menu_item;
use crate::rpc::Query;

/// Red used for the destructive "Delete" affordances (menu item + dialog
/// button). The dark variant is brighter so it stays legible as text/tint on
/// dark panels.
pub(crate) const DELETE_RED: crate::theme::Duo = crate::theme::Duo {
    light: egui::Color32::from_rgb(0xC0, 0x39, 0x2B),
    dark: egui::Color32::from_rgb(0xE0, 0x6B, 0x5C),
};
/// Red of the superscript "unsaved changes" marker shown after a query name.
pub(crate) const UNSAVED_RED: crate::theme::Duo = DELETE_RED;
/// Size of the superscript unsaved marker glyph.
pub(crate) const UNSAVED_MARKER_SIZE: f32 = 10.0;

/// The [`egui::TextFormat`] for the superscript "unsaved changes" marker — a
/// small, raised, red `emergency` glyph appended after a query name. A small
/// font with [`egui::Align::TOP`] gives the raised superscript-asterisk effect.
pub(crate) fn unsaved_marker_format(visuals: &egui::Visuals) -> egui::TextFormat {
    egui::TextFormat {
        font_id: icons::font_id(UNSAVED_MARKER_SIZE),
        color: UNSAVED_RED.get(visuals),
        valign: egui::Align::TOP,
        ..Default::default()
    }
}

/// Horizontal gap between a query name and its trailing unsaved marker.
pub(crate) const MARKER_GAP: f32 = 2.0;

/// Lays out a query name truncated to `max_width`, reserving room for a trailing
/// superscript "unsaved" marker (when `unsaved`) so the marker survives the
/// truncation instead of being dropped along with the ellipsized text. Returns
/// the name galley and the marker galley (if any); the caller paints the marker
/// top-aligned just after the name (offset by [`MARKER_GAP`]). Shared by the
/// sidebar rows and the query page's title so both truncate identically.
pub(crate) fn layout_query_name(
    ui: &egui::Ui,
    name: &str,
    unsaved: bool,
    font_id: egui::FontId,
    color: egui::Color32,
    max_width: f32,
) -> (Arc<egui::Galley>, Option<Arc<egui::Galley>>) {
    let marker_galley = unsaved.then(|| {
        let mut job = egui::text::LayoutJob::default();
        job.append(
            icons::UNSAVED.codepoint,
            0.0,
            unsaved_marker_format(ui.visuals()),
        );
        ui.painter().layout_job(job)
    });
    let reserved = marker_galley
        .as_ref()
        .map_or(0.0, |g| g.size().x + MARKER_GAP);
    let name_avail = (max_width - reserved).max(0.0);
    let mut name_job = egui::text::LayoutJob::single_section(
        name.to_owned(),
        egui::TextFormat {
            font_id,
            color,
            ..Default::default()
        },
    );
    name_job.wrap = egui::text::TextWrapping::truncate_at_width(name_avail);
    (ui.painter().layout_job(name_job), marker_galley)
}

/// An action chosen from a query's options menu.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum QueryAction {
    Rename,
    /// Discard unsaved edits, restoring the last-saved version. Only offered for
    /// a query that has already been saved.
    Revert,
    /// Create a new query copied from this one (carrying any unsaved edits).
    Duplicate,
    Delete,
    /// Toggle whether the query's tab is pinned (kept open). Only offered from a
    /// tab's context menu, where a query is currently open in a tab.
    TogglePin,
}

/// Renders the shared query-actions menu body. Used both for the sidebar row's
/// `⋮`/right-click menu and the query page's `⋮` menu, so the two stay identical.
/// `show_revert` gates the "Revert changes" item — it's shown only for a query
/// that has already been saved. Returns the chosen action, if any.
pub(crate) fn query_actions_menu(ui: &mut egui::Ui, show_revert: bool) -> Option<QueryAction> {
    ui.set_width(130.0);
    let mut action = None;
    if menu_item(ui, icons::RENAME, "Rename", true, None).clicked() {
        action = Some(QueryAction::Rename);
    }
    if show_revert && menu_item(ui, icons::REVERT, "Revert changes", true, None).clicked() {
        action = Some(QueryAction::Revert);
    }
    if menu_item(ui, icons::DUPLICATE, "Duplicate", true, None).clicked() {
        action = Some(QueryAction::Duplicate);
    }
    if menu_item(
        ui,
        icons::DELETE,
        "Delete",
        true,
        Some(DELETE_RED.get(ui.visuals())),
    )
    .clicked()
    {
        action = Some(QueryAction::Delete);
    }
    action
}

/// The result of a frame of inline-rename editing.
#[derive(Default)]
pub(crate) struct RenameOutcome {
    pub(crate) commit: bool,
    pub(crate) cancel: bool,
}

/// Renders an inline single-line rename field into `buffer`. On the first frame
/// (`take_focus`) it grabs focus and selects all text. Pressing Enter or clicking
/// away commits; pressing Escape cancels. The `id` keeps the widget's state stable
/// across frames; `width` sizes the field.
pub(crate) fn inline_rename_field(
    ui: &mut egui::Ui,
    buffer: &mut String,
    take_focus: &mut bool,
    id: egui::Id,
    width: f32,
) -> RenameOutcome {
    let mut output = crate::text_input::show(
        ui,
        egui::TextEdit::singleline(buffer)
            .id(id)
            .desired_width(width),
    );

    if *take_focus {
        output.response.request_focus();
        let end = buffer.chars().count();
        let range = egui::text::CCursorRange::two(
            egui::text::CCursor::new(0),
            egui::text::CCursor::new(end),
        );
        output.state.cursor.set_char_range(Some(range));
        output.state.store(ui.ctx(), output.response.id);
        *take_focus = false;
    }

    let mut outcome = RenameOutcome::default();
    // egui's TextEdit surrenders focus on Enter (→ commit) but ignores Escape, so
    // we detect Escape ourselves and release focus to dismiss the field.
    if output.response.has_focus() && ui.input(|i| i.key_pressed(egui::Key::Escape)) {
        outcome.cancel = true;
        ui.memory_mut(|m| m.surrender_focus(output.response.id));
    } else if output.response.lost_focus() {
        outcome.commit = true;
    }
    outcome
}

/// A fixed sentinel id for the singleton Keyboard Shortcuts page, so it flows
/// through the same `Uuid`-keyed tab machinery (select/close/reorder) as queries
/// without colliding with any real query id.
pub(crate) const SHORTCUTS_PAGE_ID: Uuid =
    Uuid::from_u128(0x5E11_0000_0000_0000_0000_0000_0000_0001);

/// Which page the app is currently showing. A query page requires a concrete
/// query id; `Welcome` is the placeholder shown when no query is open (e.g.
/// before any query has been created); `KeyboardShortcuts` is the singleton
/// settings editor.
#[derive(Default, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CurrentPage {
    #[default]
    Welcome,
    Query(Uuid),
    KeyboardShortcuts,
}

impl CurrentPage {
    /// The id of the open query, if a *query* page is currently showing.
    pub(crate) fn query_id(self) -> Option<Uuid> {
        match self {
            CurrentPage::Query(id) => Some(id),
            CurrentPage::Welcome | CurrentPage::KeyboardShortcuts => None,
        }
    }

    /// The tab id of the current page (query *or* settings), if any — used by the
    /// tab-keyed commands (close/move active tab) which act on either page type.
    pub(crate) fn page_id(self) -> Option<Uuid> {
        match self {
            CurrentPage::Query(id) => Some(id),
            CurrentPage::KeyboardShortcuts => Some(SHORTCUTS_PAGE_ID),
            CurrentPage::Welcome => None,
        }
    }
}

/// An open tab. Currently either a query page or the singleton keyboard-shortcuts
/// editor; more page types (playlists, artists, …) will slot in here.
///
/// [`QueryPage`] is boxed so the (data-less) `KeyboardShortcuts` variant doesn't
/// bloat every element of the tab `Vec` to the query page's size.
pub(crate) enum Page {
    Query(Box<QueryPage>),
    /// The keyboard-shortcuts editor. There is at most one, and its transient UI
    /// state lives on [`crate::App`], so this variant carries no data.
    KeyboardShortcuts,
}

impl Page {
    /// The tab id: the query's id, or the fixed [`SHORTCUTS_PAGE_ID`] sentinel.
    pub(crate) fn id(&self) -> Uuid {
        match self {
            Page::Query(p) => p.live.id,
            Page::KeyboardShortcuts => SHORTCUTS_PAGE_ID,
        }
    }

    /// Whether the tab is pinned. The settings tab is always pinned (it has no
    /// preview-tab semantics).
    pub(crate) fn pinned(&self) -> bool {
        match self {
            Page::Query(p) => p.pinned,
            Page::KeyboardShortcuts => true,
        }
    }

    pub(crate) fn as_query(&self) -> Option<&QueryPage> {
        match self {
            Page::Query(p) => Some(p),
            Page::KeyboardShortcuts => None,
        }
    }

    pub(crate) fn as_query_mut(&mut self) -> Option<&mut QueryPage> {
        match self {
            Page::Query(p) => Some(p),
            Page::KeyboardShortcuts => None,
        }
    }

    /// The [`CurrentPage`] marker that selects this page.
    pub(crate) fn marker(&self) -> CurrentPage {
        match self {
            Page::Query(p) => CurrentPage::Query(p.live.id),
            Page::KeyboardShortcuts => CurrentPage::KeyboardShortcuts,
        }
    }
}

/// Renders the explorer (organizer) toggle shown at the top-left of every page.
/// Every page type renders it by calling this one helper, which is what keeps
/// the button identical (look and behaviour) across page types. It uses no
/// background; only the glyph changes — `left_panel_close` while the explorer is
/// `open` (click to close), `left_panel_open` while it's closed. Returns `true`
/// when clicked.
pub(crate) fn explorer_button(ui: &mut egui::Ui, open: bool) -> bool {
    let icon = if open {
        icons::EXPLORER_CLOSE
    } else {
        icons::EXPLORER_OPEN
    };
    Button::icon(icon).show(ui).clicked()
}

/// A single query page: an editable `live` query plus the `saved` snapshot it was
/// last persisted from, and a cache of its results.
pub(crate) struct QueryPage {
    /// The editable working copy. Edits to the definition update this.
    pub(crate) live: Query,
    /// The last-saved version, or `None` if the query has never been persisted.
    pub(crate) saved: Option<Query>,
    /// Cached query results, shared with the async fetch task.
    pub(crate) results: Arc<Mutex<QueryState>>,
    /// Whether a result fetch has been kicked off for the current results cache.
    pub(crate) results_fetched: bool,
    /// Whether this tab is pinned (kept open). Unpinned tabs are "preview" tabs
    /// (VS Code semantics): opening another query reuses/closes the single
    /// unpinned tab rather than piling up tabs. See [`crate::App::open_query`].
    pub(crate) pinned: bool,
}

impl QueryPage {
    /// Builds a page from a persisted query (its live and saved versions match).
    /// Opens unpinned (a preview tab) by default; callers pin it explicitly.
    pub(crate) fn persisted(query: Query) -> Self {
        Self {
            live: query.clone(),
            saved: Some(query),
            results: Arc::new(Mutex::new(QueryState::default())),
            results_fetched: false,
            pinned: false,
        }
    }

    /// Builds a brand-new ephemeral page that has never been saved. Ephemeral
    /// queries are pinned: they don't appear in the explorer, so a preview-tab
    /// reuse would silently discard them.
    pub(crate) fn ephemeral(query: Query) -> Self {
        Self {
            live: query,
            saved: None,
            results: Arc::new(Mutex::new(QueryState::default())),
            results_fetched: false,
            pinned: true,
        }
    }

    /// Derived: a page is unsaved whenever its live version differs from the
    /// last-saved version (a never-saved page is always unsaved).
    pub(crate) fn unsaved(&self) -> bool {
        self.saved.as_ref() != Some(&self.live)
    }

    /// Whether this query exists in the backend database.
    pub(crate) fn is_persisted(&self) -> bool {
        self.saved.is_some()
    }
}
