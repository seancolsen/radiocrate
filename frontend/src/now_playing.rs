//! The "now playing" bottom bar and the bookkeeping that ties a playing track
//! back to the query page it was played from.

use std::time::Duration;

use eframe::egui;
use uuid::Uuid;

use crate::icons::{self, MaterialIcon};
use crate::{ACCENT_BLUE, App};

#[derive(Clone)]
pub(crate) struct CurrentTrack {
    /// The query page this track was played from (results are per-page).
    pub(crate) source_page: Uuid,
    pub(crate) id: String,
    pub(crate) row_index: Option<usize>,
    pub(crate) title: Option<String>,
    pub(crate) artist_names: Vec<String>,
}

#[derive(Clone, Copy)]
enum MenuAction {
    Next,
    Close,
    Locate,
}

impl App {
    pub(crate) fn render_now_playing(&mut self, ui: &mut egui::Ui) {
        let ctx = ui.ctx().clone();

        // Fold in any track that changed off the render loop — an auto-advance
        // when a track ended, or a media-key next/previous from the lock screen
        // or a headset. Those events keep firing while the tab is backgrounded
        // and egui is suspended, so by the time we paint again the actually
        // playing track may be ahead of (or behind) `current_track`.
        if let Some(new_id) = self.audio.take_changed() {
            self.reconcile_track_change(&new_id, &ctx);
        }

        let snapshot = self.current_track.lock().unwrap().clone();
        let Some(ct) = snapshot else {
            return;
        };

        // Keep the OS "now playing" metadata (lock screen, Bluetooth display) in
        // step with the current track, pushing only when it actually changes.
        let media_key = (ct.id.clone(), ct.title.clone(), ct.artist_names.clone());
        if self.media_metadata_key.as_ref() != Some(&media_key) {
            let artist = (!ct.artist_names.is_empty()).then(|| ct.artist_names.join(", "));
            self.audio
                .set_metadata(ct.title.as_deref(), artist.as_deref());
            self.media_metadata_key = Some(media_key);
        }

        let playing = self.audio.is_playing();
        let position = self.audio.position();
        let duration = self.audio.duration();

        if playing {
            self.audio.update_position_state(position, duration);
            ctx.request_repaint_after(Duration::from_millis(50));
        } else if self.audio.has_ended() {
            // Advancement is owned by the audio element's queue now, so reaching
            // here means the queue ran dry: nothing is left to play.
            self.clear_current_track();
            ctx.request_repaint();
            return;
        }

        let (toggle, action) = self.paint_now_playing_bar(ui, &ct, playing, position, duration);

        if toggle {
            if playing {
                self.audio.pause();
            } else {
                self.audio.play();
            }
        }

        match action {
            Some(MenuAction::Next) => self.skip_to_next_track(&ctx),
            Some(MenuAction::Close) => {
                self.clear_current_track();
            }
            Some(MenuAction::Locate) => {
                if let Some(idx) = ct.row_index {
                    // Switch to the page the track lives on, then scroll to it.
                    self.current = crate::CurrentPage::Query(ct.source_page);
                    self.pending_scroll = Some(crate::PendingScroll {
                        row: idx,
                        select: true,
                    });
                    ctx.request_repaint();
                }
            }
            None => {}
        }
    }

    /// Re-locates the current track's row index within its source page's results,
    /// e.g. after that page was re-run and the rows changed.
    pub(crate) fn maybe_revalidate_current_track_index(&mut self) {
        let source = {
            let guard = self.current_track.lock().unwrap();
            let Some(ct) = guard.as_ref() else {
                return;
            };
            ct.source_page
        };
        let Some(results) = self.page_results(source) else {
            return;
        };
        let (needs, track_id_column, running, lineage_done) = {
            let s = results.lock().unwrap();
            (
                s.needs_revalidation,
                s.track_id_column,
                s.running,
                s.lineage_done,
            )
        };
        if !needs || running || !lineage_done {
            return;
        }

        let mut ct_guard = self.current_track.lock().unwrap();
        let Some(ct) = ct_guard.as_mut() else {
            drop(ct_guard);
            results.lock().unwrap().needs_revalidation = false;
            return;
        };

        let Some(col) = track_id_column else {
            ct.row_index = None;
            drop(ct_guard);
            results.lock().unwrap().needs_revalidation = false;
            return;
        };

        let s = results.lock().unwrap();
        let rows = &s.rows;
        let id = ct.id.as_str();

        if let Some(idx) = ct.row_index
            && rows.cell_text(idx, col).as_deref() == Some(id)
        {
            drop(s);
            drop(ct_guard);
            results.lock().unwrap().needs_revalidation = false;
            return;
        }

        let scan_limit = rows.len().min(1000);
        let mut found: Option<usize> = None;
        for i in 0..scan_limit {
            if rows.cell_text(i, col).as_deref() == Some(id) {
                found = Some(i);
                break;
            }
        }
        ct.row_index = found;
        drop(s);
        drop(ct_guard);
        results.lock().unwrap().needs_revalidation = false;
    }

    /// Paints the bottom "now playing" bar and reports whether playback should
    /// toggle and which menu action (if any) the user picked.
    fn paint_now_playing_bar(
        &self,
        ui: &mut egui::Ui,
        ct: &CurrentTrack,
        playing: bool,
        position: f64,
        duration: Option<f64>,
    ) -> (bool, Option<MenuAction>) {
        let panel_fill = ui.style().visuals.panel_fill;
        let sheet_fill = crate::theme::shade(ui.visuals(), panel_fill, 8);

        let mut toggle = false;
        let mut action: Option<MenuAction> = None;
        egui::Panel::bottom("now_playing")
            .exact_size(40.0)
            .show_separator_line(true)
            .frame(
                egui::Frame::new()
                    .inner_margin(egui::Margin::same(0))
                    .fill(sheet_fill),
            )
            .show_inside(ui, |ui| {
                let full = ui.available_rect_before_wrap();
                let pad_x = 8.0;
                let timeline_height = 4.0;
                let timeline_bottom_pad = 2.0;
                let above_timeline_h = full.height() - timeline_height - timeline_bottom_pad;

                let (t, a) =
                    self.draw_now_playing_controls(ui, full, pad_x, above_timeline_h, ct, playing);
                toggle = t;
                action = a;

                draw_now_playing_text(ui, full, pad_x, above_timeline_h, ct);

                let progress = match (duration, position) {
                    (Some(d), p) if d > 0.0 => (p / d).clamp(0.0, 1.0) as f32,
                    _ => 0.0,
                };
                draw_now_playing_timeline(ui, full, timeline_height, timeline_bottom_pad, progress);
            });

        (toggle, action)
    }

    /// Draws the play/pause button and overflow menu on the right of the bar.
    fn draw_now_playing_controls(
        &self,
        ui: &egui::Ui,
        full: egui::Rect,
        pad_x: f32,
        above_timeline_h: f32,
        ct: &CurrentTrack,
        playing: bool,
    ) -> (bool, Option<MenuAction>) {
        let mut toggle = false;
        let mut action: Option<MenuAction> = None;

        let icon_font = icons::font_id(18.0);
        let icon_char = if playing {
            icons::PAUSE.codepoint
        } else {
            icons::PLAY.codepoint
        };
        let menu_icon_char = icons::MORE.codepoint;
        let visuals = ui.visuals().clone();

        let button_size = egui::vec2(26.0, 26.0);
        let button_gap = 4.0;
        let buttons_center_y = full.min.y + above_timeline_h * 0.5;
        let menu_btn_rect = egui::Rect::from_min_size(
            egui::pos2(
                full.max.x - pad_x - button_size.x,
                buttons_center_y - button_size.y * 0.5,
            ),
            button_size,
        );
        let play_btn_rect = egui::Rect::from_min_size(
            egui::pos2(
                menu_btn_rect.min.x - button_gap - button_size.x,
                buttons_center_y - button_size.y * 0.5,
            ),
            button_size,
        );
        let play_resp = ui.interact(
            play_btn_rect,
            ui.id().with("now_playing_toggle"),
            egui::Sense::click(),
        );
        ui.painter().text(
            play_btn_rect.center(),
            egui::Align2::CENTER_CENTER,
            icon_char,
            icon_font.clone(),
            visuals.text_color(),
        );
        if play_resp.clicked() {
            toggle = true;
        }
        let menu_resp = ui.interact(
            menu_btn_rect,
            ui.id().with("now_playing_menu"),
            egui::Sense::click(),
        );
        ui.painter().text(
            menu_btn_rect.center(),
            egui::Align2::CENTER_CENTER,
            menu_icon_char,
            icon_font,
            visuals.text_color(),
        );

        let can_next = self.audio.has_next();
        let can_locate = ct.row_index.is_some();
        egui::Popup::menu(&menu_resp)
            .align(egui::RectAlign::TOP_END)
            .width(130.0)
            .show(|ui| {
                if menu_item(ui, icons::NEXT, "Next", can_next, None).clicked() {
                    action = Some(MenuAction::Next);
                }
                if menu_item(ui, icons::CLOSE, "Close", true, None).clicked() {
                    action = Some(MenuAction::Close);
                }
                if menu_item(ui, icons::LOCATE, "Locate", can_locate, None).clicked() {
                    action = Some(MenuAction::Locate);
                }
                let _ = menu_item(ui, icons::EDIT, "Edit", true, None);
            });

        (toggle, action)
    }

    /// Skips to the next track (from the "Next" menu item or keyboard command)
    /// and reconciles the resulting change into app state.
    pub(crate) fn skip_to_next_track(&mut self, ctx: &egui::Context) {
        self.audio.skip_next();
        if let Some(new_id) = self.audio.take_changed() {
            self.reconcile_track_change(&new_id, ctx);
        }
        ctx.request_repaint();
    }

    /// Clears the now-playing state and tears down the audio player's queue and
    /// OS media session (stopping playback).
    fn clear_current_track(&mut self) {
        self.audio.stop();
        *self.current_track.lock().unwrap() = None;
        self.media_metadata_key = None;
    }

    /// Folds a track change that originated in the audio layer (an auto-advance
    /// when a track ended, or a media-key next/previous) into app state: swaps
    /// the now-playing bar's track, re-locates its row, refetches metadata, and
    /// records the play. The audio player owns the queue/history across these
    /// transitions, so there is nothing to re-sync there.
    fn reconcile_track_change(&mut self, new_id: &str, ctx: &egui::Context) {
        let source = {
            let guard = self.current_track.lock().unwrap();
            let Some(ct) = guard.as_ref() else {
                return;
            };
            ct.source_page
        };
        let row_index = self.locate_row(source, new_id);
        {
            let mut guard = self.current_track.lock().unwrap();
            let Some(ct) = guard.as_mut() else {
                return;
            };
            ct.id = new_id.to_string();
            ct.row_index = row_index;
            ct.title = None;
            ct.artist_names = Vec::new();
        }
        crate::http::fetch_track_metadata(new_id, &self.current_track, ctx);
        self.record_play(source);
    }

    /// Finds the row index of `id` within `source`'s current results, if present.
    fn locate_row(&self, source: Uuid, id: &str) -> Option<usize> {
        let results = self.page_results(source)?;
        let s = results.lock().unwrap();
        let col = s.track_id_column?;
        let scan_limit = s.rows.len().min(1000);
        (0..scan_limit).find(|&i| s.rows.cell_text(i, col).as_deref() == Some(id))
    }

    /// Snapshots `source`'s results around row `index` into the play context the
    /// audio player navigates: `(preceding, upcoming)`. `preceding` is every
    /// non-empty track id before `index` (nearest last, for "previous");
    /// `upcoming` is the contiguous run of non-empty ids after `index`, stopping
    /// at the first empty one (a row without a playable track), for "next" and
    /// auto-advance.
    pub(crate) fn playlist_around(&self, source: Uuid, index: usize) -> (Vec<String>, Vec<String>) {
        let Some(results) = self.page_results(source) else {
            return (Vec::new(), Vec::new());
        };
        let s = results.lock().unwrap();
        let Some(col) = s.track_id_column else {
            return (Vec::new(), Vec::new());
        };
        let len = s.rows.len();
        let mut preceding = Vec::new();
        for i in 0..index.min(len) {
            if let Some(id) = s.rows.cell_text(i, col).filter(|id| !id.is_empty()) {
                preceding.push(id);
            }
        }
        let mut upcoming = Vec::new();
        for i in (index + 1)..len {
            match s.rows.cell_text(i, col) {
                Some(id) if !id.is_empty() => upcoming.push(id),
                _ => break,
            }
        }
        (preceding, upcoming)
    }

    /// Records a play against `source`'s query: bumps `last_play` on both the
    /// live and saved copies and persists it when the query is saved. Shared by
    /// manual plays and background auto-advances so both keep `last_play` fresh.
    pub(crate) fn record_play(&mut self, source: Uuid) {
        let now = crate::rpc::now_epoch();
        if let Some(page) = self.find_query_mut(source) {
            page.live.last_play = now;
            if let Some(saved) = page.saved.as_mut() {
                saved.last_play = now;
            }
            if page.is_persisted() {
                crate::rpc::record_play(source, now);
            }
        }
        if let Some(query) = self.saved_queries.iter_mut().find(|q| q.id == source) {
            query.last_play = now;
        }
    }
}

/// Draws the track title and artist names on the left of the now-playing bar.
fn draw_now_playing_text(
    ui: &egui::Ui,
    full: egui::Rect,
    pad_x: f32,
    above_timeline_h: f32,
    ct: &CurrentTrack,
) {
    let visuals = ui.visuals();
    let title_font = egui::FontId::proportional(13.0);
    let artist_font = egui::FontId::proportional(11.0);
    let text_left = full.min.x + pad_x;
    let title_h = 14.0;
    let line_gap = 1.0;
    let artist_h = 11.0;
    let total_text_h = title_h + line_gap + artist_h;
    let text_top = full.min.y + above_timeline_h * 0.5 - total_text_h * 0.5;
    let title = ct.title.as_deref().unwrap_or("");
    ui.painter().text(
        egui::pos2(text_left, text_top),
        egui::Align2::LEFT_TOP,
        title,
        title_font,
        visuals.text_color(),
    );
    let artists = ct.artist_names.join(", ");
    ui.painter().text(
        egui::pos2(text_left, text_top + title_h + line_gap),
        egui::Align2::LEFT_TOP,
        artists,
        artist_font,
        visuals.weak_text_color(),
    );
}

/// Draws the played/unplayed timeline pills near the bottom of the bar.
fn draw_now_playing_timeline(
    ui: &egui::Ui,
    full: egui::Rect,
    timeline_height: f32,
    timeline_bottom_pad: f32,
    progress: f32,
) {
    let timeline_pad_x = 2.0;
    let track_rect = egui::Rect::from_min_size(
        egui::pos2(
            full.min.x + timeline_pad_x,
            full.max.y - timeline_bottom_pad - timeline_height,
        ),
        egui::vec2(full.width() - timeline_pad_x * 2.0, timeline_height),
    );
    let gap = 4.0;
    let played_w = track_rect.width() * progress;
    let rounding = timeline_height * 0.5;
    let unplayed_color = egui::Color32::from_rgba_unmultiplied(46, 124, 246, 70);

    if played_w > 0.0 {
        let played_rect = egui::Rect::from_min_size(
            track_rect.min,
            egui::vec2((played_w - gap * 0.5).max(0.0), timeline_height),
        );
        if played_rect.width() > 0.0 {
            ui.painter()
                .rect_filled(played_rect, rounding, ACCENT_BLUE.get(ui.visuals()));
        }
    }
    let unplayed_start = track_rect.min.x + (played_w + gap * 0.5).max(0.0);
    if unplayed_start < track_rect.max.x {
        let unplayed_rect = egui::Rect::from_min_max(
            egui::pos2(unplayed_start, track_rect.min.y),
            egui::pos2(track_rect.max.x, track_rect.max.y),
        );
        ui.painter()
            .rect_filled(unplayed_rect, rounding, unplayed_color);
    }
}

/// A single row in a popup/context menu: an icon, a label, and hover feedback.
/// `tint` overrides the icon/label color when the item is enabled (e.g. red for a
/// destructive action); disabled items always use the weak text color.
pub(crate) fn menu_item(
    ui: &mut egui::Ui,
    icon: MaterialIcon,
    label: &str,
    enabled: bool,
    tint: Option<egui::Color32>,
) -> egui::Response {
    let row_height = 28.0;
    let icon_size = 16.0;
    let label_size = 13.0;
    let row_width = ui.available_width();
    let sense = if enabled {
        egui::Sense::click()
    } else {
        egui::Sense::hover()
    };
    let (rect, resp) = ui.allocate_exact_size(egui::vec2(row_width, row_height), sense);

    let visuals = ui.visuals();
    if enabled && resp.hovered() {
        ui.painter()
            .rect_filled(rect, 4.0, visuals.widgets.hovered.weak_bg_fill);
    }

    let text_color = if enabled {
        tint.unwrap_or_else(|| visuals.text_color())
    } else {
        visuals.weak_text_color()
    };

    let icon_font = icons::font_id(icon_size);
    let label_font = egui::FontId::proportional(label_size);
    let pad_x = 10.0;
    let icon_x = rect.left() + pad_x;
    ui.painter().text(
        egui::pos2(icon_x, rect.center().y),
        egui::Align2::LEFT_CENTER,
        icon.codepoint,
        icon_font,
        text_color,
    );
    ui.painter().text(
        egui::pos2(icon_x + icon_size + 10.0, rect.center().y),
        egui::Align2::LEFT_CENTER,
        label,
        label_font,
        text_color,
    );

    resp
}
