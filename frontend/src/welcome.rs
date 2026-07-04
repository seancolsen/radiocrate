//! The welcome page: shown when no query is open (e.g. before any query has been
//! created). Its top chrome — the explorer toggle and the new-tab button — comes
//! from the shared tab bar (see [`crate::tabs`]), so this module only paints the
//! page's centered body.

use eframe::egui;

/// The welcome page's body: the app name, centered. Intentionally minimal for
/// now — we can flesh this out later.
pub(crate) fn render_welcome_center(ui: &mut egui::Ui) {
    egui::CentralPanel::default().show_inside(ui, |ui| {
        ui.centered_and_justified(|ui| {
            ui.heading(egui::RichText::new("Collectune").size(48.0));
        });
    });
}
