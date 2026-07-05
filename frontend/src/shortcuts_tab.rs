//! The Keyboard Shortcuts editor: a VS Code-style tabular view of every command,
//! its bound shortcut, and the context it fires in, with a search bar (by command
//! name or, in "record" mode, by pressing the chord) and a capture dialog for
//! rebinding.

use eframe::egui::{self, Key};

use crate::App;
use crate::button::SplitButton;
use crate::commands::{ALL_COMMANDS, Chord, CommandId};
use crate::icons;

/// Transient UI state for the keyboard-shortcuts editor tab. Lives on [`App`]
/// (the tab is a singleton), reset to empty by [`Default`].
#[derive(Default)]
pub(crate) struct ShortcutsUi {
    /// The command-name search text (used when not in record mode).
    search: String,
    /// Whether the search bar is capturing a chord to filter by instead of text.
    record_mode: bool,
    /// The chord captured in record mode, filtering the table to its command.
    recorded: Option<Chord>,
    /// The open rebind-capture dialog, if any.
    capture: Option<CaptureState>,
}

impl ShortcutsUi {
    /// Whether the editor is currently grabbing keys (record mode or the capture
    /// dialog), so the global shortcut pass should stand down.
    pub(crate) fn is_capturing(&self) -> bool {
        self.record_mode || self.capture.is_some()
    }
}

/// The rebind-capture dialog's state: which command is being edited and the chord
/// pressed so far.
struct CaptureState {
    cmd: CommandId,
    pending: Option<Chord>,
}

/// An action chosen from a row's context menu.
#[derive(Clone, Copy)]
enum RowAction {
    /// Open the capture dialog to set a new chord.
    Change,
    /// Explicitly unbind the command.
    Remove,
    /// Discard the override, reverting to the built-in default.
    Reset,
}

/// A row's rendering data, snapshotted so the draw closure needn't borrow the
/// keymap.
struct RowData {
    cmd: CommandId,
    chord: Option<Chord>,
    when: &'static str,
    overridden: bool,
}

/// Reads the first key-press chord from this frame's input, or `None`. When
/// `skip_control`, ignores Enter/Escape/Tab so a dialog can reserve them.
fn read_chord(ctx: &egui::Context, skip_control: bool) -> Option<Chord> {
    ctx.input(|i| {
        i.events.iter().find_map(|ev| match ev {
            egui::Event::Key {
                key,
                pressed: true,
                modifiers,
                ..
            } if !(skip_control && matches!(key, Key::Enter | Key::Escape | Key::Tab)) => {
                Some(Chord::new(*modifiers, *key))
            }
            _ => None,
        })
    })
}

impl App {
    /// Renders the Keyboard Shortcuts editor tab's central panel, plus its
    /// (floating) capture dialog.
    #[allow(clippy::too_many_lines)]
    pub(crate) fn render_shortcuts_page(&mut self, ui: &mut egui::Ui) {
        let ctx = ui.ctx().clone();

        // Record-mode chord capture for the search bar.
        if self.shortcuts.record_mode
            && let Some(ch) = read_chord(&ctx, true)
        {
            self.shortcuts.recorded = Some(ch);
        }

        // The commands to show, filtered by the search bar (name or recorded
        // chord). Snapshot each row's data so the panel closure doesn't borrow
        // the keymap.
        let record_mode = self.shortcuts.record_mode;
        let recorded = self.shortcuts.recorded;
        let filter = self.shortcuts.search.to_lowercase();
        let row_data: Vec<RowData> = ALL_COMMANDS
            .iter()
            .copied()
            .filter(|&c| {
                if record_mode {
                    recorded.is_none_or(|ch| self.keymap.binding_for(c) == Some(ch))
                } else {
                    filter.is_empty() || c.title().to_lowercase().contains(&filter)
                }
            })
            .map(|c| RowData {
                cmd: c,
                chord: self.keymap.binding_for(c),
                when: c.when().label(),
                overridden: self.keymap.is_overridden(c),
            })
            .collect();

        let shortcuts = &mut self.shortcuts;
        let mut open_capture: Option<CommandId> = None;
        let mut row_action: Option<(CommandId, RowAction)> = None;

        let frame = egui::Frame::central_panel(ui.style());
        egui::CentralPanel::default()
            .frame(frame)
            .show_inside(ui, |ui| {
                ui.add_space(10.0);
                ui.horizontal(|ui| {
                    ui.add_space(4.0);
                    ui.heading("Keyboard Shortcuts");
                });
                ui.add_space(8.0);

                // Search / record bar.
                ui.horizontal(|ui| {
                    ui.add_space(4.0);
                    let field_w = (ui.available_width() - 140.0).clamp(120.0, 420.0);
                    if shortcuts.record_mode {
                        let text = shortcuts
                            .recorded
                            .map_or_else(|| "Press keys to search…".to_owned(), |c| c.format(&ctx));
                        record_box(ui, &text, field_w);
                    } else {
                        crate::text_input::add(
                            ui,
                            egui::TextEdit::singleline(&mut shortcuts.search)
                                .hint_text("Search by command name")
                                .desired_width(field_w),
                        );
                    }
                    if SplitButton::new(icons::KEYBOARD, "Record keys")
                        .active(shortcuts.record_mode)
                        .show_menu(false)
                        .show(ui)
                        .main
                        .clicked()
                    {
                        shortcuts.record_mode = !shortcuts.record_mode;
                        shortcuts.recorded = None;
                    }
                });
                ui.add_space(8.0);

                shortcuts_header(ui);
                egui::ScrollArea::vertical()
                    .auto_shrink([false, false])
                    .show(ui, |ui| {
                        ui.spacing_mut().item_spacing.y = 0.0;
                        if row_data.is_empty() {
                            ui.add_space(12.0);
                            ui.horizontal(|ui| {
                                ui.add_space(12.0);
                                ui.weak("No matching commands");
                            });
                        }
                        for data in &row_data {
                            if let Some(action) = shortcuts_row(ui, data, &ctx) {
                                match action {
                                    RowAction::Change => open_capture = Some(data.cmd),
                                    other => row_action = Some((data.cmd, other)),
                                }
                            }
                        }
                    });
            });

        if let Some(cmd) = open_capture {
            self.shortcuts.capture = Some(CaptureState {
                cmd,
                pending: self.keymap.binding_for(cmd),
            });
        }
        if let Some((cmd, action)) = row_action {
            match action {
                RowAction::Remove => self.set_binding(cmd, None),
                RowAction::Reset => self.reset_binding(cmd),
                RowAction::Change => {}
            }
        }

        self.render_shortcut_capture(&ctx);
    }

    /// Renders the rebind-capture dialog when open. Pressing a chord updates the
    /// pending binding; the buttons (or Enter/Esc) resolve it.
    fn render_shortcut_capture(&mut self, ctx: &egui::Context) {
        let Some(mut cap) = self.shortcuts.capture.take() else {
            return;
        };
        let cmd = cap.cmd;
        if let Some(ch) = read_chord(ctx, true) {
            cap.pending = Some(ch);
        }

        let mut result: Option<CaptureResult> = None;
        let modal = egui::Modal::new(egui::Id::new("shortcut_capture")).show(ctx, |ui| {
            ui.set_width(340.0);
            ui.heading("Set keyboard shortcut");
            ui.add_space(6.0);
            ui.label(cmd.title());
            ui.add_space(10.0);
            let text = cap.pending.map_or_else(
                || "Press desired key combination…".to_owned(),
                |c| c.format(ctx),
            );
            record_box(ui, &text, ui.available_width());
            if let Some(chord) = cap.pending
                && let Some(other) = self.keymap.command_for_chord(chord)
                && other != cmd
            {
                ui.add_space(4.0);
                ui.colored_label(
                    crate::ACCENT_BLUE.get(ui.visuals()),
                    format!("Currently bound to \u{201c}{}\u{201d}", other.title()),
                );
            }
            ui.add_space(12.0);
            ui.horizontal(|ui| {
                if ui
                    .add_enabled(cap.pending.is_some(), egui::Button::new("Assign"))
                    .clicked()
                {
                    result = Some(CaptureResult::Assign);
                }
                if ui.button("Unbind").clicked() {
                    result = Some(CaptureResult::Unbind);
                }
                if ui.button("Reset to default").clicked() {
                    result = Some(CaptureResult::Reset);
                }
                if ui.button("Cancel").clicked() {
                    result = Some(CaptureResult::Cancel);
                }
            });
        });

        // Enter assigns the pending chord; Esc / backdrop cancels.
        if result.is_none() && cap.pending.is_some() && ctx.input(|i| i.key_pressed(Key::Enter)) {
            result = Some(CaptureResult::Assign);
        }
        if result.is_none() && modal.should_close() {
            result = Some(CaptureResult::Cancel);
        }

        match result {
            Some(CaptureResult::Assign) => {
                if let Some(chord) = cap.pending {
                    self.set_binding(cmd, Some(chord));
                }
            }
            Some(CaptureResult::Unbind) => self.set_binding(cmd, None),
            Some(CaptureResult::Reset) => self.reset_binding(cmd),
            Some(CaptureResult::Cancel) => {}
            // Still open: put the capture state back.
            None => self.shortcuts.capture = Some(cap),
        }
    }

    /// Sets a command's binding, stealing the chord from any other command that
    /// currently holds it (that command becomes unbound). Persists both changes.
    pub(crate) fn set_binding(&mut self, cmd: CommandId, chord: Option<Chord>) {
        if let Some(chord) = chord
            && let Some(other) = self.keymap.command_for_chord(chord)
            && other != cmd
        {
            self.apply_binding(other, None);
        }
        self.apply_binding(cmd, chord);
    }

    /// Reverts a command to its built-in default binding, dropping any override.
    pub(crate) fn reset_binding(&mut self, cmd: CommandId) {
        self.keymap.set_override(cmd, cmd.default_chord());
        crate::rpc::delete_keybinding(cmd.id_str());
    }

    /// Applies one binding to the keymap and persists it: an override that matches
    /// the default is stored as a deletion (so the row disappears), otherwise as a
    /// set (a `null` chord records an explicit unbind).
    fn apply_binding(&mut self, cmd: CommandId, chord: Option<Chord>) {
        self.keymap.set_override(cmd, chord);
        if self.keymap.is_overridden(cmd) {
            let stored = chord.map(Chord::to_storage);
            crate::rpc::set_keybinding(cmd.id_str(), stored.as_deref());
        } else {
            crate::rpc::delete_keybinding(cmd.id_str());
        }
    }
}

/// The rebind dialog's resolution (kept distinct from [`RowAction`], which is the
/// row context-menu's vocabulary).
#[derive(Clone, Copy)]
enum CaptureResult {
    Assign,
    Unbind,
    Reset,
    Cancel,
}

/// A bordered, read-only box showing a chord (or a prompt), matching the app's
/// text-input chrome so the record/capture affordance reads as a field.
fn record_box(ui: &mut egui::Ui, text: &str, width: f32) {
    let height = 26.0;
    let (rect, _) = ui.allocate_exact_size(egui::vec2(width, height), egui::Sense::hover());
    ui.painter()
        .rect_filled(rect, 4.0, ui.visuals().text_edit_bg_color());
    ui.painter().rect_stroke(
        rect,
        4.0,
        egui::Stroke::new(1.0, crate::HOVER_BLUE.get(ui.visuals())),
        egui::StrokeKind::Inside,
    );
    ui.painter().text(
        egui::pos2(rect.left() + 8.0, rect.center().y),
        egui::Align2::LEFT_CENTER,
        text,
        egui::FontId::proportional(13.0),
        ui.visuals().text_color(),
    );
}

/// The table header row: Command | Keybinding | When.
fn shortcuts_header(ui: &mut egui::Ui) {
    let (rect, _) =
        ui.allocate_exact_size(egui::vec2(ui.available_width(), 24.0), egui::Sense::hover());
    let weak = ui.visuals().weak_text_color();
    let font = egui::FontId::proportional(12.0);
    let (key_x, when_x) = column_anchors(rect);
    ui.painter().text(
        egui::pos2(rect.left() + 12.0, rect.center().y),
        egui::Align2::LEFT_CENTER,
        "Command",
        font.clone(),
        weak,
    );
    ui.painter().text(
        egui::pos2(key_x, rect.center().y),
        egui::Align2::LEFT_CENTER,
        "Keybinding",
        font.clone(),
        weak,
    );
    ui.painter().text(
        egui::pos2(when_x, rect.center().y),
        egui::Align2::LEFT_CENTER,
        "When",
        font,
        weak,
    );
    ui.painter().line_segment(
        [
            egui::pos2(rect.left(), rect.bottom()),
            egui::pos2(rect.right(), rect.bottom()),
        ],
        egui::Stroke::new(1.0, weak.gamma_multiply(0.4)),
    );
}

/// The left x-anchors of the Keybinding and When columns for a full-width row.
fn column_anchors(rect: egui::Rect) -> (f32, f32) {
    let when_w = 150.0;
    let key_w = 170.0;
    let when_x = rect.right() - when_w;
    let key_x = when_x - key_w;
    (
        key_x.max(rect.left() + 120.0),
        when_x.max(rect.left() + 240.0),
    )
}

/// One editable row. Double-click opens the capture dialog; right-click offers
/// Change / Remove / Reset. Returns the chosen action.
fn shortcuts_row(ui: &mut egui::Ui, data: &RowData, ctx: &egui::Context) -> Option<RowAction> {
    let height = 30.0;
    let (rect, resp) = ui.allocate_exact_size(
        egui::vec2(ui.available_width(), height),
        egui::Sense::click(),
    );
    let v = ui.visuals();
    if resp.hovered() {
        ui.painter().rect_filled(
            rect,
            0.0,
            crate::theme::shade(v, v.panel_fill, crate::theme::HOVER_SHADE),
        );
    }
    let text_color = v.text_color();
    let weak = v.weak_text_color();
    let (key_x, when_x) = column_anchors(rect);

    // Command title, clipped so it can't run under the Keybinding column.
    let title_clip = egui::Rect::from_min_max(
        egui::pos2(rect.left() + 12.0, rect.top()),
        egui::pos2(key_x - 8.0, rect.bottom()),
    );
    ui.painter().with_clip_rect(title_clip).text(
        egui::pos2(rect.left() + 12.0, rect.center().y),
        egui::Align2::LEFT_CENTER,
        data.cmd.title(),
        egui::FontId::proportional(13.0),
        text_color,
    );

    // Keybinding — tinted blue when overridden from the default.
    let (key_text, key_color) = match data.chord {
        Some(chord) => (
            chord.format(ctx),
            if data.overridden {
                crate::HOVER_BLUE.get(ui.visuals())
            } else {
                text_color
            },
        ),
        None => ("\u{2014}".to_owned(), weak),
    };
    ui.painter().text(
        egui::pos2(key_x, rect.center().y),
        egui::Align2::LEFT_CENTER,
        key_text,
        egui::FontId::proportional(12.0),
        key_color,
    );

    // When context.
    if !data.when.is_empty() {
        ui.painter().text(
            egui::pos2(when_x, rect.center().y),
            egui::Align2::LEFT_CENTER,
            data.when,
            egui::FontId::proportional(12.0),
            weak,
        );
    }

    let mut action = None;
    if resp.double_clicked() {
        action = Some(RowAction::Change);
    }
    if let Some(inner) = egui::Popup::context_menu(&resp)
        .show(|ui| {
            ui.set_width(180.0);
            let mut chosen = None;
            if crate::now_playing::menu_item(ui, icons::EDIT, "Change keybinding", true, None)
                .clicked()
            {
                chosen = Some(RowAction::Change);
            }
            if data.chord.is_some()
                && crate::now_playing::menu_item(ui, icons::CLEAR, "Remove keybinding", true, None)
                    .clicked()
            {
                chosen = Some(RowAction::Remove);
            }
            if data.overridden
                && crate::now_playing::menu_item(ui, icons::REVERT, "Reset to default", true, None)
                    .clicked()
            {
                chosen = Some(RowAction::Reset);
            }
            chosen
        })
        .and_then(|i| i.inner)
    {
        action = Some(inner);
    }
    action
}
