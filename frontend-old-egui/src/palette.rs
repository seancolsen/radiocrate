//! The command palette: a VS Code-style overlay for finding and running
//! commands by name, showing each command's keyboard shortcut and listing
//! recently-used commands first.
//!
//! Opened with the `palette.open` shortcut (or from itself). While it's open the
//! global shortcut pass stands down (see [`crate::App::shortcuts_suppressed`]),
//! so the palette handles its own arrow/enter/escape navigation and consumes the
//! open shortcut to toggle itself closed.

use eframe::egui::{self, Key, Modifiers};

use crate::App;
use crate::commands::{ALL_COMMANDS, Chord, CommandContext, CommandId, consume_chord};

/// The command palette's transient state while open.
pub(crate) struct PaletteState {
    /// The search query typed into the palette's field.
    query: String,
    /// Index of the highlighted row within the current filtered list.
    selected: usize,
    /// The row index last scrolled into view, so we only request a scroll when
    /// the selection changes (scrolling every frame would repaint in a busy loop).
    scrolled_to: Option<usize>,
    /// Set on open so the search field grabs focus once.
    take_focus: bool,
}

impl Default for PaletteState {
    fn default() -> Self {
        Self {
            query: String::new(),
            selected: 0,
            scrolled_to: None,
            take_focus: true,
        }
    }
}

impl App {
    /// Toggles the command palette open/closed.
    pub(crate) fn open_command_palette(&mut self) {
        self.palette = if self.palette.is_some() {
            None
        } else {
            Some(PaletteState::default())
        };
    }

    /// Renders the command palette overlay when open, dispatching the chosen
    /// command on Enter/click and closing on Escape, backdrop click, or the open
    /// shortcut.
    pub(crate) fn render_command_palette(&mut self, ctx: &egui::Context) {
        let Some(mut state) = self.palette.take() else {
            return;
        };
        let cctx = self.compute_command_context();
        let items = rank_commands(&state.query, cctx, &self.command_mru);
        let n = items.len();
        if state.selected >= n {
            state.selected = n.saturating_sub(1);
        }

        let mut chosen: Option<CommandId> = None;
        let mut close = false;

        // The open shortcut toggles the palette closed while it's up.
        if let Some(chord) = self.keymap.binding_for(CommandId::PaletteOpen)
            && consume_chord(ctx, chord)
        {
            close = true;
        }

        // Keyboard navigation — consumed before the search field can see these
        // keys, so arrows move the selection and Enter runs the highlighted row.
        ctx.input_mut(|i| {
            if n > 0 && i.consume_key(Modifiers::NONE, Key::ArrowDown) {
                state.selected = (state.selected + 1) % n;
            }
            if n > 0 && i.consume_key(Modifiers::NONE, Key::ArrowUp) {
                state.selected = (state.selected + n - 1) % n;
            }
            if n > 0 && i.consume_key(Modifiers::NONE, Key::Enter) {
                chosen = Some(items[state.selected]);
            }
        });

        let width = (ctx.content_rect().width() - 48.0).clamp(220.0, 520.0);
        let id = egui::Id::new("command_palette");
        let area =
            egui::Modal::default_area(id).anchor(egui::Align2::CENTER_TOP, egui::vec2(0.0, 72.0));
        let keymap = &self.keymap;
        let modal = egui::Modal::new(id).area(area).show(ctx, |ui| {
            ui.set_width(width);

            let output = crate::text_input::show(
                ui,
                egui::TextEdit::singleline(&mut state.query)
                    .hint_text("Type a command name…")
                    .desired_width(width),
            );
            // Keep focus on the field the whole time the palette is open, so
            // typing always lands there and it never gets stolen by a list row.
            output.response.request_focus();
            state.take_focus = false;

            ui.add_space(6.0);

            if items.is_empty() {
                ui.weak("No matching commands");
                return;
            }

            // Scroll the selected row into view only when the selection changed,
            // so a settled palette doesn't repaint forever.
            let scroll_to = (state.scrolled_to != Some(state.selected)).then_some(state.selected);
            egui::ScrollArea::vertical()
                .max_height(320.0)
                .auto_shrink([false, true])
                .show(ui, |ui| {
                    ui.spacing_mut().item_spacing.y = 0.0;
                    for (i, &cmd) in items.iter().enumerate() {
                        let selected = i == state.selected;
                        let resp = palette_row(
                            ui,
                            cmd,
                            selected,
                            scroll_to == Some(i),
                            keymap.binding_for(cmd),
                            ctx,
                        );
                        if resp.clicked() {
                            chosen = Some(cmd);
                        } else if resp.hovered()
                            && ctx.input(|i| i.pointer.velocity() != egui::Vec2::ZERO)
                        {
                            state.selected = i;
                        }
                    }
                });
            state.scrolled_to = Some(state.selected);
        });

        if modal.should_close() {
            close = true;
        }
        if chosen.is_some() {
            close = true;
        }

        if close {
            // `state` was taken, so leaving it dropped keeps the palette closed.
            if let Some(cmd) = chosen {
                self.record_command_use(cmd);
                self.execute_command(cmd, ctx);
            }
        } else {
            self.palette = Some(state);
        }
    }
}

/// Ranks the commands available in `cctx` for the given `query`. With an empty
/// query, recently-used commands come first (in MRU order), then the rest in
/// registry order. Otherwise substring title matches rank above subsequence
/// matches, and non-matches are dropped.
fn rank_commands(query: &str, cctx: CommandContext, mru: &[CommandId]) -> Vec<CommandId> {
    let available: Vec<CommandId> = ALL_COMMANDS
        .iter()
        .copied()
        .filter(|c| c.when().satisfied(cctx))
        .collect();

    let q = query.trim().to_lowercase();
    if q.is_empty() {
        let mut out: Vec<CommandId> = Vec::new();
        for &c in mru {
            if available.contains(&c) && !out.contains(&c) {
                out.push(c);
            }
        }
        for &c in &available {
            if !out.contains(&c) {
                out.push(c);
            }
        }
        return out;
    }

    let mut scored: Vec<(u8, usize, CommandId)> = Vec::new();
    for (idx, &c) in available.iter().enumerate() {
        let title = c.title().to_lowercase();
        if title.contains(&q) {
            scored.push((0, idx, c));
        } else if is_subsequence(&q, &title) {
            scored.push((1, idx, c));
        }
    }
    scored.sort_by_key(|(score, idx, _)| (*score, *idx));
    scored.into_iter().map(|(_, _, c)| c).collect()
}

/// Whether every non-space char of `needle` appears in `haystack` in order.
fn is_subsequence(needle: &str, haystack: &str) -> bool {
    let mut hay = haystack.chars();
    'outer: for nc in needle.chars() {
        if nc == ' ' {
            continue;
        }
        for hc in hay.by_ref() {
            if hc == nc {
                continue 'outer;
            }
        }
        return false;
    }
    true
}

/// One palette row: the command title on the left, its bound shortcut (if any)
/// right-aligned in weak text. The selected row is highlighted and scrolled into
/// view for keyboard navigation.
fn palette_row(
    ui: &mut egui::Ui,
    cmd: CommandId,
    selected: bool,
    scroll: bool,
    chord: Option<Chord>,
    ctx: &egui::Context,
) -> egui::Response {
    let row_h = 30.0;
    let (rect, resp) = ui.allocate_exact_size(
        egui::vec2(ui.available_width(), row_h),
        egui::Sense::click(),
    );
    let v = ui.visuals();
    if selected {
        ui.painter()
            .rect_filled(rect, 4.0, v.widgets.hovered.weak_bg_fill);
        if scroll {
            resp.scroll_to_me(Some(egui::Align::Center));
        }
    } else if resp.hovered() {
        ui.painter().rect_filled(
            rect,
            4.0,
            v.widgets.hovered.weak_bg_fill.gamma_multiply(0.5),
        );
    }
    let text_color = v.text_color();
    let weak = v.weak_text_color();

    // Reserve room on the right for the shortcut so a long title can't overlap it.
    let shortcut = chord.map(|c| c.format(ctx));
    let shortcut_font = egui::FontId::proportional(12.0);
    let shortcut_w = shortcut.as_ref().map_or(0.0, |s| {
        ui.painter()
            .layout_no_wrap(s.clone(), shortcut_font.clone(), weak)
            .size()
            .x
    });

    let title_left = rect.left() + 10.0;
    let title_right = rect.right()
        - 10.0
        - if shortcut_w > 0.0 {
            shortcut_w + 12.0
        } else {
            0.0
        };
    let title_clip = egui::Rect::from_min_max(
        egui::pos2(title_left, rect.top()),
        egui::pos2(title_right.max(title_left), rect.bottom()),
    );
    ui.painter().with_clip_rect(title_clip).text(
        egui::pos2(title_left, rect.center().y),
        egui::Align2::LEFT_CENTER,
        cmd.title(),
        egui::FontId::proportional(13.0),
        text_color,
    );

    if let Some(s) = shortcut {
        ui.painter().text(
            egui::pos2(rect.right() - 10.0, rect.center().y),
            egui::Align2::RIGHT_CENTER,
            s,
            shortcut_font,
            weak,
        );
    }

    resp
}
