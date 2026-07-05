//! The app's theme palettes.
//!
//! Both of egui's themes get their visuals installed up front; which one is
//! active then follows the context's theme preference — the system theme by
//! default (falling back to light where the platform doesn't report one), or
//! an explicit choice via [`egui::Context::set_theme`].

use eframe::egui;

/// Installs the app's visuals for both egui themes and makes light the
/// fallback when no system preference is known.
pub(crate) fn install(ctx: &egui::Context) {
    ctx.set_visuals_of(egui::Theme::Light, light_visuals());
    // Dark mode isn't designed yet: mirror the light palette so a dark-themed
    // context renders identically for now.
    ctx.set_visuals_of(egui::Theme::Dark, light_visuals());
    ctx.options_mut(|o| o.fallback_theme = egui::Theme::Light);
}

/// egui's light theme, but with fully-black body text (egui's default is a
/// dark gray). Icons are painted in their own dark gray (see
/// [`crate::icons::DEFAULT_COLOR`]) so they still read as secondary chrome
/// against the blacker text.
fn light_visuals() -> egui::Visuals {
    let mut visuals = egui::Visuals::light();
    visuals.override_text_color = Some(egui::Color32::BLACK);
    visuals
}
