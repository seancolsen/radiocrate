//! Shared rig for the widget snapshot tests.
//!
//! [`harness`] builds an [`egui_kittest::Harness`] with the app's real
//! environment — bundled fonts, theme palettes, a non-blinking caret — bound on
//! the first frame; the caller's `ui_fn` draws from the second frame on (font
//! changes only take effect the frame after they're set).
//!
//! [`snapshot_dual`] then captures every scene twice, once per theme, and
//! stacks the frames into a single PNG: light on top, dark on bottom, split by
//! a gray rule. One file per test keeps the baseline set flat, and a theme
//! regression in either mode shows up in the same diff image.
//!
//! Generate or refresh the baselines with `UPDATE_SNAPSHOTS=1 cargo test -p
//! frontend`.

use std::cell::Cell;

use eframe::egui;
use egui_kittest::Harness;

/// Render at 2× device scale (the project convention) so text stays crisp.
pub(crate) const PPP: f32 = 2.0;

/// Thickness (physical pixels) of the rule between the light and dark halves.
const DIVIDER: u32 = 2;

/// Builds a harness of `size` logical points at [`PPP`] that renders `ui_fn`
/// in the app's environment.
pub(crate) fn harness<'a>(
    size: egui::Vec2,
    mut ui_fn: impl FnMut(&mut egui::Ui) + 'a,
) -> Harness<'a> {
    // `build_ui` runs the closure once before the context can be configured,
    // so bind the app environment on that first frame and skip drawing until
    // the next one. The caret blink is stopped so focused-input snapshots are
    // deterministic rather than depending on phase.
    let ready = Cell::new(false);
    Harness::builder()
        .with_size(size)
        .with_pixels_per_point(PPP)
        .build_ui(move |ui| {
            if !ready.replace(true) {
                crate::setup_context(ui.ctx());
                ui.ctx()
                    .global_style_mut(|s| s.visuals.text_cursor.blink = false);
                return;
            }
            ui_fn(ui);
        })
}

/// How frames advance between the theme switch and each capture.
pub(crate) enum Run {
    /// Run until the ui settles (nothing requests an immediate repaint).
    Settle,
    /// Step a fixed number of frames — for scenes that repaint forever, like a
    /// spinner, where [`Harness::run`] would panic.
    Steps(usize),
}

/// Captures `harness` in light then dark mode and compares the stacked pair
/// against `tests/snapshots/<name>.png`.
pub(crate) fn snapshot_dual(harness: &mut Harness<'_>, name: &str) {
    snapshot_dual_run(harness, name, &Run::Settle);
}

/// [`snapshot_dual`] with control over how frames advance (see [`Run`]).
pub(crate) fn snapshot_dual_run(harness: &mut Harness<'_>, name: &str, run: &Run) {
    let light = capture(harness, egui::Theme::Light, run);
    let dark = capture(harness, egui::Theme::Dark, run);
    egui_kittest::image_snapshot(&stack(&light, &dark), name);
}

/// Forces `theme`, advances frames so its visuals take effect, and renders.
fn capture(harness: &mut Harness<'_>, theme: egui::Theme, run: &Run) -> image::RgbaImage {
    harness.ctx.set_theme(theme);
    match run {
        Run::Settle => {
            harness.run();
        }
        Run::Steps(n) => harness.run_steps(*n),
    }
    harness.render().expect("render themed frame")
}

/// Stacks the two captures vertically with a gray rule between them.
fn stack(top: &image::RgbaImage, bottom: &image::RgbaImage) -> image::RgbaImage {
    let w = top.width().max(bottom.width());
    let h = top.height() + DIVIDER + bottom.height();
    let mut out = image::RgbaImage::from_pixel(w, h, image::Rgba([0x80, 0x80, 0x80, 0xFF]));
    image::imageops::replace(&mut out, top, 0, 0);
    image::imageops::replace(&mut out, bottom, 0, i64::from(top.height() + DIVIDER));
    out
}
