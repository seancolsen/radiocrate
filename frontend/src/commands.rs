//! The command registry, keybinding model, and global keyboard-shortcut input
//! pass.
//!
//! Every user-triggerable action the command palette or a keyboard shortcut can
//! invoke is a [`CommandId`]. Each command carries a stable `snake_case` id (the
//! string persisted to the `settings.keybinding` table), a human-readable title,
//! a [`When`] context gating when its shortcut may fire, and a built-in default
//! [`Chord`]. User overrides live in [`Keymap::overrides`]; everything else uses
//! its default.
//!
//! ## Cross-platform modifiers
//!
//! Chords are stored platform-neutrally: the "Mod" modifier is egui's
//! [`Modifiers::command`], which is ⌘ on macOS and Ctrl on Windows/Linux (egui
//! normalizes this for us). A chord is displayed with per-OS glyphs by
//! [`Chord::format`] (⇧⌘P on macOS, `Ctrl+Shift+P` elsewhere).
//!
//! ## Matching
//!
//! The input pass ([`App::handle_global_shortcuts`]) matches with
//! [`Modifiers::matches_exact`] semantics (via [`consume_chord`]) rather than
//! egui's looser `consume_shortcut`, so a plain `ArrowDown` binding does not also
//! swallow `Shift+ArrowDown` — the two are distinct commands (select vs. extend).

use eframe::egui::{self, Key, Modifiers};

use crate::query_def::Section;

/// A modifier+key chord, e.g. ⌘⇧P. `mods` uses [`Modifiers::command`] to mean the
/// platform "Mod" key (⌘ on macOS, Ctrl elsewhere).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) struct Chord {
    pub(crate) mods: Modifiers,
    pub(crate) key: Key,
}

impl Chord {
    pub(crate) const fn new(mods: Modifiers, key: Key) -> Self {
        Self { mods, key }
    }

    /// Serializes to the storage form persisted in `settings.keybinding.chord`,
    /// e.g. `"mod+shift+P"` or `"shift+Down"`. Modifier tokens are lowercase and
    /// canonically ordered; the key uses egui's [`Key::name`].
    pub(crate) fn to_storage(self) -> String {
        let mut s = String::new();
        // Canonical order: mod, ctrl, shift, alt. `command` is the platform "Mod";
        // a bare `ctrl` (physical Control, distinct from Mod) is kept separate.
        if self.mods.command {
            s.push_str("mod+");
        }
        if self.mods.ctrl && !self.mods.command {
            s.push_str("ctrl+");
        }
        if self.mods.shift {
            s.push_str("shift+");
        }
        if self.mods.alt {
            s.push_str("alt+");
        }
        s.push_str(self.key.name());
        s
    }

    /// Parses the storage form produced by [`Chord::to_storage`]. Returns `None`
    /// for an unrecognized modifier token or key name. The key segment is the last
    /// `+`-separated token, so keys whose name contains `+` are not representable
    /// (none of the defaults are).
    pub(crate) fn parse(s: &str) -> Option<Self> {
        let mut mods = Modifiers::NONE;
        let mut parts = s.split('+').peekable();
        let mut key_token = None;
        while let Some(part) = parts.next() {
            if parts.peek().is_none() {
                key_token = Some(part);
                break;
            }
            match part.to_ascii_lowercase().as_str() {
                "mod" => mods.command = true,
                "ctrl" => mods.ctrl = true,
                "shift" => mods.shift = true,
                "alt" => mods.alt = true,
                _ => return None,
            }
        }
        let key = Key::from_name(key_token?)?;
        Some(Self { mods, key })
    }

    /// A human-readable rendering for the current OS: `⇧⌘P` on macOS, or
    /// `Ctrl+Shift+P` elsewhere. Key names (not symbols) are used so glyphs never
    /// fall back to tofu in the bundled font.
    pub(crate) fn format(self, ctx: &egui::Context) -> String {
        let m = self.mods;
        let mut s = String::new();
        if ctx.os().is_mac() {
            // ⌃⌥⇧⌘ order, no separators — matching macOS convention.
            if m.ctrl && !m.command {
                s.push('\u{2303}'); // ⌃
            }
            if m.alt {
                s.push('\u{2325}'); // ⌥
            }
            if m.shift {
                s.push('\u{21e7}'); // ⇧
            }
            if m.command {
                s.push('\u{2318}'); // ⌘
            }
        } else {
            if m.ctrl || m.command {
                s.push_str("Ctrl+");
            }
            if m.alt {
                s.push_str("Alt+");
            }
            if m.shift {
                s.push_str("Shift+");
            }
        }
        s.push_str(self.key.name());
        s
    }
}

/// Every command the palette lists and a keyboard shortcut can invoke.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) enum CommandId {
    PaletteOpen,
    ShortcutsConfigure,
    ExplorerToggle,
    PlaybackNextTrack,
    PlaybackTogglePlay,
    QueryFocusFilter,
    QueryFocusSort,
    QueryFocusDisplay,
    QueryNew,
    ResultsSelectNext,
    ResultsSelectPrevious,
    ResultsExtendSelectionDown,
    ResultsExtendSelectionUp,
    TabsCloseActive,
    TabsNext,
    TabsPrevious,
    TabsMoveLeft,
    TabsMoveRight,
    TabsPinActive,
    TabsUnpinActive,
    TabsSaveActive,
    TabsSaveAll,
}

/// Every command, in the order the palette lists them (grouped by category).
pub(crate) const ALL_COMMANDS: &[CommandId] = &[
    CommandId::PaletteOpen,
    CommandId::ShortcutsConfigure,
    CommandId::ExplorerToggle,
    CommandId::PlaybackTogglePlay,
    CommandId::PlaybackNextTrack,
    CommandId::QueryNew,
    CommandId::QueryFocusFilter,
    CommandId::QueryFocusSort,
    CommandId::QueryFocusDisplay,
    CommandId::ResultsSelectNext,
    CommandId::ResultsSelectPrevious,
    CommandId::ResultsExtendSelectionDown,
    CommandId::ResultsExtendSelectionUp,
    CommandId::TabsSaveActive,
    CommandId::TabsSaveAll,
    CommandId::TabsCloseActive,
    CommandId::TabsNext,
    CommandId::TabsPrevious,
    CommandId::TabsMoveLeft,
    CommandId::TabsMoveRight,
    CommandId::TabsPinActive,
    CommandId::TabsUnpinActive,
];

impl CommandId {
    /// The stable identifier persisted in `settings.keybinding.command_id`. Never
    /// change these once shipped; they are the on-disk contract.
    pub(crate) fn id_str(self) -> &'static str {
        match self {
            CommandId::PaletteOpen => "palette.open",
            CommandId::ShortcutsConfigure => "shortcuts.configure",
            CommandId::ExplorerToggle => "explorer.toggle",
            CommandId::PlaybackNextTrack => "playback.next_track",
            CommandId::PlaybackTogglePlay => "playback.toggle_play",
            CommandId::QueryFocusFilter => "query.focus_filter",
            CommandId::QueryFocusSort => "query.focus_sort",
            CommandId::QueryFocusDisplay => "query.focus_display",
            CommandId::QueryNew => "query.new",
            CommandId::ResultsSelectNext => "results.select_next",
            CommandId::ResultsSelectPrevious => "results.select_previous",
            CommandId::ResultsExtendSelectionDown => "results.extend_selection_down",
            CommandId::ResultsExtendSelectionUp => "results.extend_selection_up",
            CommandId::TabsCloseActive => "tabs.close_active",
            CommandId::TabsNext => "tabs.next",
            CommandId::TabsPrevious => "tabs.previous",
            CommandId::TabsMoveLeft => "tabs.move_left",
            CommandId::TabsMoveRight => "tabs.move_right",
            CommandId::TabsPinActive => "tabs.pin_active",
            CommandId::TabsUnpinActive => "tabs.unpin_active",
            CommandId::TabsSaveActive => "tabs.save_active",
            CommandId::TabsSaveAll => "tabs.save_all",
        }
    }

    /// Resolves a persisted id back to its command, or `None` for an id this build
    /// doesn't know (so overrides from a newer build are ignored, not dropped).
    pub(crate) fn from_id_str(s: &str) -> Option<Self> {
        ALL_COMMANDS.iter().copied().find(|c| c.id_str() == s)
    }

    /// The palette/editor display title, `"Category: Action"`.
    pub(crate) fn title(self) -> &'static str {
        match self {
            CommandId::PaletteOpen => "Commands: Open command palette",
            CommandId::ShortcutsConfigure => "Commands: Configure keyboard shortcuts",
            CommandId::ExplorerToggle => "Explorer: Toggle explorer sidebar",
            CommandId::PlaybackNextTrack => "Playback: Skip to next track",
            CommandId::PlaybackTogglePlay => "Playback: Toggle play/pause of active track",
            CommandId::QueryFocusFilter => "Query: Focus filter builder",
            CommandId::QueryFocusSort => "Query: Focus sort builder",
            CommandId::QueryFocusDisplay => "Query: Focus display builder",
            CommandId::QueryNew => "Query: New query",
            CommandId::ResultsSelectNext => "Results: Select next result row",
            CommandId::ResultsSelectPrevious => "Results: Select previous result row",
            CommandId::ResultsExtendSelectionDown => "Results: Extend result row selection down",
            CommandId::ResultsExtendSelectionUp => "Results: Extend result row selection up",
            CommandId::TabsCloseActive => "Tabs: Close active tab",
            CommandId::TabsNext => "Tabs: Go to next tab",
            CommandId::TabsPrevious => "Tabs: Go to previous tab",
            CommandId::TabsMoveLeft => "Tabs: Move active tab to the left",
            CommandId::TabsMoveRight => "Tabs: Move active tab to the right",
            CommandId::TabsPinActive => "Tabs: Pin active tab",
            CommandId::TabsUnpinActive => "Tabs: Unpin active tab",
            CommandId::TabsSaveActive => "Tabs: Save active tab",
            CommandId::TabsSaveAll => "Tabs: Save all unsaved tabs",
        }
    }

    /// The context in which this command's shortcut may fire (and which the
    /// palette uses to gray/skip unavailable commands).
    pub(crate) fn when(self) -> When {
        match self {
            CommandId::PaletteOpen
            | CommandId::ShortcutsConfigure
            | CommandId::ExplorerToggle
            | CommandId::QueryNew => When::Always,
            CommandId::PlaybackNextTrack | CommandId::PlaybackTogglePlay => When::TrackLoaded,
            CommandId::QueryFocusFilter
            | CommandId::QueryFocusSort
            | CommandId::QueryFocusDisplay
            | CommandId::TabsPinActive
            | CommandId::TabsUnpinActive
            | CommandId::TabsSaveActive => When::QueryTabActive,
            CommandId::ResultsSelectNext
            | CommandId::ResultsSelectPrevious
            | CommandId::ResultsExtendSelectionDown
            | CommandId::ResultsExtendSelectionUp => When::ResultsAvailable,
            CommandId::TabsCloseActive | CommandId::TabsMoveLeft | CommandId::TabsMoveRight => {
                When::ActiveTab
            }
            CommandId::TabsNext | CommandId::TabsPrevious | CommandId::TabsSaveAll => {
                When::AnyTabOpen
            }
        }
    }

    /// The built-in default chord, or `None` for a command that ships unbound.
    pub(crate) fn default_chord(self) -> Option<Chord> {
        const MOD: Modifiers = Modifiers::COMMAND;
        let shift = Modifiers::SHIFT;
        let alt = Modifiers::ALT;
        let c = |mods, key| Some(Chord::new(mods, key));
        match self {
            CommandId::PaletteOpen => c(MOD | shift, Key::P),
            CommandId::ShortcutsConfigure => None,
            CommandId::ExplorerToggle => c(MOD, Key::B),
            CommandId::PlaybackNextTrack => c(shift, Key::N),
            CommandId::PlaybackTogglePlay => c(shift, Key::Space),
            CommandId::QueryFocusFilter => c(MOD | shift, Key::F),
            CommandId::QueryFocusSort => c(MOD | shift, Key::S),
            CommandId::QueryFocusDisplay => c(MOD | shift, Key::D),
            CommandId::QueryNew => c(MOD | alt, Key::N),
            CommandId::ResultsSelectNext => c(Modifiers::NONE, Key::ArrowDown),
            CommandId::ResultsSelectPrevious => c(Modifiers::NONE, Key::ArrowUp),
            CommandId::ResultsExtendSelectionDown => c(shift, Key::ArrowDown),
            CommandId::ResultsExtendSelectionUp => c(shift, Key::ArrowUp),
            CommandId::TabsCloseActive => c(MOD | alt, Key::W),
            CommandId::TabsNext => c(MOD | alt, Key::ArrowRight),
            CommandId::TabsPrevious => c(MOD | alt, Key::ArrowLeft),
            CommandId::TabsMoveLeft => c(MOD | shift | alt, Key::ArrowLeft),
            CommandId::TabsMoveRight => c(MOD | shift | alt, Key::ArrowRight),
            CommandId::TabsPinActive => c(MOD | alt, Key::P),
            CommandId::TabsUnpinActive => c(MOD | shift | alt, Key::P),
            CommandId::TabsSaveActive => c(MOD, Key::S),
            CommandId::TabsSaveAll => c(MOD | alt, Key::S),
        }
    }
}

/// The context gating a command. Kept deliberately small: a fixed set of boolean
/// predicates over [`CommandContext`], not a general expression language.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum When {
    /// Always available.
    Always,
    /// A tab (query or settings) is currently open.
    ActiveTab,
    /// At least one tab is open.
    AnyTabOpen,
    /// The current tab is a query page.
    QueryTabActive,
    /// The current query page has at least one result row.
    ResultsAvailable,
    /// A track is loaded in the now-playing bar.
    TrackLoaded,
}

impl When {
    pub(crate) fn satisfied(self, c: CommandContext) -> bool {
        match self {
            When::Always => true,
            When::ActiveTab => c.active_tab,
            When::AnyTabOpen => c.any_tab_open,
            When::QueryTabActive => c.query_tab_active,
            When::ResultsAvailable => c.results_available,
            When::TrackLoaded => c.track_loaded,
        }
    }

    /// A short label for the shortcuts editor's "When" column. Empty for `Always`.
    pub(crate) fn label(self) -> &'static str {
        match self {
            When::Always => "",
            When::ActiveTab => "tab open",
            When::AnyTabOpen => "tabs open",
            When::QueryTabActive => "query tab active",
            When::ResultsAvailable => "results shown",
            When::TrackLoaded => "track loaded",
        }
    }
}

/// A snapshot of the app state the [`When`] predicates read, computed once per
/// input pass.
#[allow(clippy::struct_excessive_bools)]
#[derive(Clone, Copy, Default)]
pub(crate) struct CommandContext {
    pub(crate) active_tab: bool,
    pub(crate) any_tab_open: bool,
    pub(crate) query_tab_active: bool,
    pub(crate) results_available: bool,
    pub(crate) track_loaded: bool,
}

/// The resolved keymap: user overrides layered over the built-in defaults, plus a
/// flattened `chord -> command` lookup rebuilt after any change.
#[derive(Default)]
pub(crate) struct Keymap {
    /// User overrides. `Some(chord)` rebinds; `None` explicitly unbinds. A command
    /// absent from this map uses its [`CommandId::default_chord`].
    overrides: std::collections::HashMap<CommandId, Option<Chord>>,
    /// Flattened active bindings in [`ALL_COMMANDS`] order. Chords are unique
    /// (assignment steals conflicts), so first-match is unambiguous.
    resolved: Vec<(Chord, CommandId)>,
}

impl Keymap {
    /// The effective chord for a command: its override if present, else its
    /// default. `None` means unbound.
    pub(crate) fn binding_for(&self, cmd: CommandId) -> Option<Chord> {
        match self.overrides.get(&cmd) {
            Some(over) => *over,
            None => cmd.default_chord(),
        }
    }

    /// Whether the command's binding differs from its built-in default.
    pub(crate) fn is_overridden(&self, cmd: CommandId) -> bool {
        self.overrides.contains_key(&cmd)
    }

    /// Sets an override in memory and rebuilds the lookup. `chord == default`
    /// clears the override instead (so it reverts to default). Callers persist the
    /// change separately.
    pub(crate) fn set_override(&mut self, cmd: CommandId, chord: Option<Chord>) {
        if chord == cmd.default_chord() {
            self.overrides.remove(&cmd);
        } else {
            self.overrides.insert(cmd, chord);
        }
        self.rebuild();
    }

    /// Replaces all overrides (e.g. from the DB) and rebuilds. Entries are
    /// `(command_id, chord_or_null)`; unknown ids and unparseable chords are
    /// skipped.
    pub(crate) fn load_overrides(
        &mut self,
        entries: impl IntoIterator<Item = (String, Option<String>)>,
    ) {
        self.overrides.clear();
        for (id, chord) in entries {
            let Some(cmd) = CommandId::from_id_str(&id) else {
                continue;
            };
            match chord {
                Some(s) => {
                    if let Some(ch) = Chord::parse(&s) {
                        self.overrides.insert(cmd, Some(ch));
                    }
                }
                None => {
                    self.overrides.insert(cmd, None);
                }
            }
        }
        self.rebuild();
    }

    /// The command currently bound to `chord`, if any.
    pub(crate) fn command_for_chord(&self, chord: Chord) -> Option<CommandId> {
        self.resolved
            .iter()
            .find(|(c, _)| *c == chord)
            .map(|(_, cmd)| *cmd)
    }

    fn rebuild(&mut self) {
        self.resolved.clear();
        for &cmd in ALL_COMMANDS {
            if let Some(chord) = self.binding_for(cmd) {
                self.resolved.push((chord, cmd));
            }
        }
    }
}

/// Consumes a single key-press event matching `chord` from this frame's input,
/// returning whether one was found. Uses [`Modifiers::matches_exact`] so alt/shift
/// must match exactly (while ⌘/Ctrl are normalized via `command`), keeping plain
/// and shift-modified bindings of the same key distinct.
pub(crate) fn consume_chord(ctx: &egui::Context, chord: Chord) -> bool {
    ctx.input_mut(|input| {
        let mut found = false;
        input.events.retain(|event| {
            let is_match = matches!(
                event,
                egui::Event::Key { key, modifiers, pressed: true, .. }
                    if *key == chord.key && modifiers.matches_exact(chord.mods)
            );
            found |= is_match;
            !is_match
        });
        found
    })
}

impl crate::App {
    /// Snapshots the [`When`] predicates from the current app state.
    pub(crate) fn compute_command_context(&self) -> CommandContext {
        let results_available = self
            .current_page()
            .is_some_and(|p| !p.results.lock().unwrap().rows.is_empty());
        CommandContext {
            active_tab: self.current.page_id().is_some(),
            any_tab_open: !self.pages.is_empty(),
            query_tab_active: self.current.query_id().is_some(),
            results_available,
            track_loaded: self.current_track.lock().unwrap().is_some(),
        }
    }

    /// Whether any modal/overlay that owns the keyboard is open, so the global
    /// shortcut pass should stand down.
    pub(crate) fn shortcuts_suppressed(&self) -> bool {
        self.palette.is_some()
            || self.pending_delete.is_some()
            || self.view_sql.is_some()
            || self.manage_presets
            || self.preset_save.is_some()
            || self.rename.is_some()
            || self.shortcuts.is_capturing()
    }

    /// The global keyboard-shortcut pass. Runs early in the frame (before panels),
    /// so a matched chord's key events are consumed before any widget sees them.
    ///
    /// When a text field wants keyboard input, only chords carrying ⌘/Ctrl or Alt
    /// may fire — plain and shift-only chords (arrow-key row navigation, etc.) are
    /// left for the field.
    pub(crate) fn handle_global_shortcuts(&mut self, ctx: &egui::Context) {
        if self.shortcuts_suppressed() {
            return;
        }
        let cctx = self.compute_command_context();
        let typing = ctx.egui_wants_keyboard_input();
        let mut fired = None;
        // `resolved` is small; clone so `self` isn't borrowed across execute.
        for (chord, cmd) in self.keymap.resolved.clone() {
            if typing && !(chord.mods.command || chord.mods.alt) {
                continue;
            }
            if !cmd.when().satisfied(cctx) {
                continue;
            }
            if consume_chord(ctx, chord) {
                fired = Some(cmd);
                break;
            }
        }
        if let Some(cmd) = fired {
            self.record_command_use(cmd);
            self.execute_command(cmd, ctx);
        }
    }

    /// Runs a command. The single dispatch point shared by the palette, keyboard
    /// shortcuts, and the shortcuts editor.
    pub(crate) fn execute_command(&mut self, cmd: CommandId, ctx: &egui::Context) {
        match cmd {
            CommandId::PaletteOpen => self.open_command_palette(),
            CommandId::ShortcutsConfigure => self.open_keyboard_shortcuts(),
            CommandId::ExplorerToggle => self.organizer.open = !self.organizer.open,
            CommandId::PlaybackTogglePlay => {
                if self.current_track.lock().unwrap().is_some() {
                    if self.audio.is_playing() {
                        self.audio.pause();
                    } else {
                        self.audio.play();
                    }
                }
            }
            CommandId::PlaybackNextTrack => {
                if let Some((source, next_idx, id)) = self.next_track_info() {
                    self.play_track(source, next_idx, &id, ctx);
                }
            }
            CommandId::QueryFocusFilter => self.focus_builder_section(Section::Filter),
            CommandId::QueryFocusSort => self.focus_builder_section(Section::Sort),
            CommandId::QueryFocusDisplay => self.focus_builder_section(Section::Display),
            CommandId::QueryNew => self.add_query_page(),
            CommandId::ResultsSelectNext => self.select_row_delta(true, false),
            CommandId::ResultsSelectPrevious => self.select_row_delta(false, false),
            CommandId::ResultsExtendSelectionDown => self.select_row_delta(true, true),
            CommandId::ResultsExtendSelectionUp => self.select_row_delta(false, true),
            CommandId::TabsCloseActive => {
                if let Some(id) = self.current.page_id() {
                    self.close_tab(id);
                }
            }
            CommandId::TabsNext => self.cycle_tab(true),
            CommandId::TabsPrevious => self.cycle_tab(false),
            CommandId::TabsMoveLeft => self.move_current_tab(false),
            CommandId::TabsMoveRight => self.move_current_tab(true),
            CommandId::TabsPinActive => self.set_current_pinned(true),
            CommandId::TabsUnpinActive => self.set_current_pinned(false),
            CommandId::TabsSaveActive => self.save_current(),
            CommandId::TabsSaveAll => self.save_all_unsaved(),
        }
    }

    /// Opens (or focuses) the given builder section on the current query page,
    /// mirroring `add_query_page`'s focus sequence. In full-querydown mode opens
    /// the full editor instead. A no-op when no query tab is active.
    fn focus_builder_section(&mut self, section: Section) {
        let Some(page) = self.current_page() else {
            return;
        };
        if page.live.definition.is_full() {
            self.full_editor_open = true;
            return;
        }
        self.expanded_preset = None;
        self.builder_section = Some(section);
        self.builder_focus = true;
    }

    /// Selects the next (`forward`) or previous tab, wrapping around.
    fn cycle_tab(&mut self, forward: bool) {
        let len = self.pages.len();
        if len == 0 {
            return;
        }
        let Some(cur) = self.current.page_id() else {
            return;
        };
        let Some(idx) = self.pages.iter().position(|p| p.id() == cur) else {
            return;
        };
        let next = if forward {
            (idx + 1) % len
        } else {
            (idx + len - 1) % len
        };
        let id = self.pages[next].id();
        self.select_page(id);
    }

    /// Moves the current tab one slot right (`forward`) or left, clamped in range.
    fn move_current_tab(&mut self, forward: bool) {
        let Some(cur) = self.current.page_id() else {
            return;
        };
        let Some(idx) = self.pages.iter().position(|p| p.id() == cur) else {
            return;
        };
        let to = if forward {
            (idx + 1).min(self.pages.len().saturating_sub(1))
        } else {
            idx.saturating_sub(1)
        };
        self.move_tab(cur, to);
    }

    /// Pins/unpins the current query tab. A no-op unless a query tab is active
    /// (the settings tab has no pin state).
    fn set_current_pinned(&mut self, pinned: bool) {
        let Some(id) = self.current.query_id() else {
            return;
        };
        if let Some(page) = self.find_query_mut(id) {
            page.pinned = pinned;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn every_command_has_unique_id() {
        let mut seen = HashSet::new();
        for &cmd in ALL_COMMANDS {
            assert!(seen.insert(cmd.id_str()), "duplicate id: {}", cmd.id_str());
        }
    }

    #[test]
    fn all_commands_lists_every_variant() {
        // A crude exhaustiveness guard: every id round-trips through from_id_str.
        for &cmd in ALL_COMMANDS {
            assert_eq!(CommandId::from_id_str(cmd.id_str()), Some(cmd));
        }
    }

    #[test]
    fn default_chords_round_trip_through_storage() {
        for &cmd in ALL_COMMANDS {
            if let Some(chord) = cmd.default_chord() {
                let s = chord.to_storage();
                assert_eq!(
                    Chord::parse(&s),
                    Some(chord),
                    "chord {s:?} for {} did not round-trip",
                    cmd.id_str()
                );
            }
        }
    }

    #[test]
    fn default_chords_are_unique() {
        let mut seen = HashSet::new();
        for &cmd in ALL_COMMANDS {
            if let Some(chord) = cmd.default_chord() {
                assert!(
                    seen.insert(chord),
                    "duplicate default chord {:?} on {}",
                    chord,
                    cmd.id_str()
                );
            }
        }
    }

    #[test]
    fn parse_rejects_unknown_tokens() {
        assert!(Chord::parse("hyper+P").is_none());
        assert!(Chord::parse("mod+shift+NotAKey").is_none());
    }

    #[test]
    fn plain_and_shift_arrow_are_distinct() {
        let next = CommandId::ResultsSelectNext.default_chord().unwrap();
        let extend = CommandId::ResultsExtendSelectionDown
            .default_chord()
            .unwrap();
        assert_eq!(next.key, extend.key);
        assert_ne!(next.mods, extend.mods);
    }
}
