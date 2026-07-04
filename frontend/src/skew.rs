//! Faux-italic text: paint an already-laid-out [`egui::Galley`] with a
//! horizontal shear so upright glyphs slant like italics.
//!
//! Our bundled Noto Sans face ships no italic variant, so we can't ask egui for
//! italic text. Instead we shear the galley's tessellated glyph meshes
//! geometrically: every vertex is nudged rightward in proportion to its height
//! above the baseline, which leans the text to the right the same way a real
//! italic does. This is a general, reusable transform — anything with a galley
//! (a label, a tab name, a menu entry) can be rendered slanted through it.

use eframe::egui;

/// Horizontal shear applied for the faux-italic slant: rightward offset as a
/// fraction of the distance above the baseline. ~0.2 gives roughly a 11° lean,
/// close to a typical italic angle.
pub(crate) const ITALIC_SHEAR: f32 = 0.2;

/// Paints `galley` at `pos` (its top-left, as with [`egui::Painter::galley`])
/// sheared by `shear`: each glyph vertex is shifted right by
/// `shear * (baseline - y)`, where the baseline is the galley's bottom edge, so
/// the text slants to the right like an italic while its bottom stays put.
///
/// The galley keeps whatever colors it was laid out with (this bypasses
/// `Painter::galley`'s fallback-color path and paints the row meshes directly).
pub(crate) fn paint_galley_skewed(
    painter: &egui::Painter,
    pos: egui::Pos2,
    galley: &egui::Galley,
    shear: f32,
) {
    // A galley row's cached mesh is what egui itself tessellates, but stored in
    // *texel* UV space (not normalized) and positioned relative to the galley
    // origin. Painting it directly means reproducing what the tessellator does to
    // it (see `Tessellator::tessellate_text`): offset each vertex by the galley +
    // row position, and divide UVs by the font-atlas size — otherwise the glyphs
    // sample outside the atlas and paint nothing.
    // (A method reference here trips a higher-ranked-lifetime error, so keep the
    // closure.)
    #[allow(clippy::redundant_closure_for_method_calls)]
    let [tw, th] = painter.ctx().fonts(|f| f.font_image_size());
    let uv_scale = egui::vec2(1.0 / tw as f32, 1.0 / th as f32);
    // Slant around the galley's bottom edge so the baseline of the (single-line)
    // text stays anchored and only the ascenders lean right.
    let baseline_y = pos.y + galley.size().y;
    for row in &galley.rows {
        if row.visuals.mesh.is_empty() {
            continue;
        }
        let row_origin = pos + row.pos.to_vec2();
        let mut mesh = row.visuals.mesh.clone();
        for v in &mut mesh.vertices {
            v.uv = (v.uv.to_vec2() * uv_scale).to_pos2();
            let x = row_origin.x + v.pos.x;
            let y = row_origin.y + v.pos.y;
            v.pos = egui::pos2(x + shear * (baseline_y - y), y);
        }
        painter.add(egui::Shape::mesh(mesh));
    }
}
