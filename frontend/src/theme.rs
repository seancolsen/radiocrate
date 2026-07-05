//! The app's theme palettes.
//!
//! Both of egui's themes get their visuals installed up front; which one is
//! active then follows the context's theme preference — the system theme by
//! default (falling back to light where the platform doesn't report one), or
//! an explicit choice via [`set_preference`].
//!
//! Custom colors that egui's [`egui::Visuals`] don't cover are defined as
//! [`Duo`] pairs next to the widgets that use them, and resolved against the
//! active visuals at paint time.

use eframe::egui;

/// A color pair: one variant per theme.
#[derive(Clone, Copy)]
pub(crate) struct Duo {
    pub(crate) light: egui::Color32,
    pub(crate) dark: egui::Color32,
}

impl Duo {
    /// The variant for the active theme.
    pub(crate) fn get(self, visuals: &egui::Visuals) -> egui::Color32 {
        if visuals.dark_mode {
            self.dark
        } else {
            self.light
        }
    }
}

/// How much a row/surface fill shifts on hover (per RGB channel, via [`shade`]).
/// Small, so the hover effect stays subtle.
pub(crate) const HOVER_SHADE: u8 = 10;

/// Shifts `color` by `amount` per RGB channel *away* from the theme's
/// background: darker in light mode, lighter in dark mode. Use it for hover
/// shades and adjacent-surface fills that need the same contrast step in
/// either theme.
pub(crate) fn shade(visuals: &egui::Visuals, color: egui::Color32, amount: u8) -> egui::Color32 {
    let step = if visuals.dark_mode {
        u8::saturating_add
    } else {
        u8::saturating_sub
    };
    egui::Color32::from_rgba_unmultiplied(
        step(color.r(), amount),
        step(color.g(), amount),
        step(color.b(), amount),
        color.a(),
    )
}

/// Installs the app's visuals for both egui themes and makes light the
/// fallback when no system preference is known.
pub(crate) fn install(ctx: &egui::Context) {
    ctx.set_visuals_of(egui::Theme::Light, light_visuals());
    ctx.set_visuals_of(egui::Theme::Dark, dark_visuals());
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

/// egui's dark theme, with body text lifted to near-white — mirroring the
/// light theme's black-on-light maximal contrast — while icons keep their own
/// lighter gray (the dark half of [`crate::icons::DEFAULT_COLOR`]).
fn dark_visuals() -> egui::Visuals {
    let mut visuals = egui::Visuals::dark();
    visuals.override_text_color = Some(egui::Color32::from_gray(0xE8));
    visuals
}

/// Applies an explicit theme choice (or `System` to follow the platform again)
/// and persists it where the target supports that: on the web, localStorage's
/// `theme` key holds `"light"` or `"dark"` (removed for `System`); the native
/// dev build doesn't persist (use its `--theme` flag instead).
pub(crate) fn set_preference(ctx: &egui::Context, pref: egui::ThemePreference) {
    ctx.set_theme(pref);
    persist_preference(pref);
}

#[cfg(target_arch = "wasm32")]
fn persist_preference(pref: egui::ThemePreference) {
    let Some(storage) = web_sys::window().and_then(|w| w.local_storage().ok().flatten()) else {
        return;
    };
    let _ = match pref {
        egui::ThemePreference::Light => storage.set_item("theme", "light"),
        egui::ThemePreference::Dark => storage.set_item("theme", "dark"),
        egui::ThemePreference::System => storage.remove_item("theme"),
    };
}

#[cfg(not(target_arch = "wasm32"))]
fn persist_preference(_pref: egui::ThemePreference) {}

/// The preference persisted in localStorage; `System` when nothing (or an
/// unrecognized value) is stored.
#[cfg(target_arch = "wasm32")]
pub(crate) fn stored_preference() -> egui::ThemePreference {
    match web_sys::window()
        .and_then(|w| w.local_storage().ok().flatten())
        .and_then(|s| s.get_item("theme").ok().flatten())
        .as_deref()
    {
        Some("light") => egui::ThemePreference::Light,
        Some("dark") => egui::ThemePreference::Dark,
        _ => egui::ThemePreference::System,
    }
}
