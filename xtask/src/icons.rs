//! Rasterizes `branding/logo.svg` into the PNG icon set the PWA needs.
//!
//! Browsers won't take an SVG for the places that matter most — Android's
//! adaptive launcher icon, the iOS home-screen icon, the iOS launch screen — so
//! the logo gets baked into PNGs here and committed under `frontend/assets/`.
//! Run `cargo xtask icons` after changing the logo.

use resvg::tiny_skia::{self, Pixmap, PixmapMut};
use resvg::usvg;
use std::path::Path;

/// The ground every opaque icon is drawn on. The logo carries its own soft
/// white halo, which only disappears into the artwork over white; on any other
/// color it reads as a fuzzy-edged disc.
const ICON_BG: [u8; 3] = [0xff, 0xff, 0xff];

/// The dark launch screen's background — egui's dark panel fill, so the launch
/// image hands off to the booted app without a color jump.
const DARK_BG: [u8; 3] = [0x1b, 0x1b, 0x1b];

/// How much of a maskable icon's width the logo may occupy. Android crops
/// maskable icons to an arbitrary shape and only guarantees the middle 80%
/// (the "safe zone"); a circle mask over a full-width logo would clip its edges.
const MASKABLE_SCALE: f32 = 0.62;

/// The plain icons and the iOS home-screen icon are shown uncropped, so the
/// logo can run nearly to the edge — just enough margin that it doesn't look
/// jammed into the corners once the OS rounds them.
const PADDED_SCALE: f32 = 0.86;

pub(crate) fn generate(root: &Path) -> Result<(), String> {
    let logo = root.join("branding/logo.svg");
    let out = root.join("frontend/assets/icons");
    std::fs::create_dir_all(&out).map_err(|e| format!("creating {}: {e}", out.display()))?;

    let svg = std::fs::read(&logo).map_err(|e| format!("reading {}: {e}", logo.display()))?;
    let tree = usvg::Tree::from_data(&svg, &usvg::Options::default())
        .map_err(|e| format!("parsing {}: {e}", logo.display()))?;

    // (file name, size, logo scale, background)
    let jobs: &[(&str, u32, f32, Option<[u8; 3]>)] = &[
        // The manifest's "any" icons. Transparent so a browser that draws them
        // on its own surface (a tab strip, a dark app list) doesn't get a white
        // square — the halo is soft enough to pass as a glow at these sizes.
        ("icon-192.png", 192, PADDED_SCALE, None),
        ("icon-512.png", 512, PADDED_SCALE, None),
        // Maskable icons are always composited onto something, and Android
        // fills any transparency with a system color that fights the halo.
        ("icon-maskable-192.png", 192, MASKABLE_SCALE, Some(ICON_BG)),
        ("icon-maskable-512.png", 512, MASKABLE_SCALE, Some(ICON_BG)),
        // iOS ignores transparency and flattens onto black, so bake white in.
        ("apple-touch-icon.png", 180, PADDED_SCALE, Some(ICON_BG)),
        ("favicon-32.png", 32, 1.0, None),
        ("favicon-16.png", 16, 1.0, None),
    ];

    for &(name, size, scale, bg) in jobs {
        let pixmap = render(&tree, size, size, scale, bg)?;
        write(&out.join(name), &pixmap)?;
    }

    // iOS launch images. Safari shows these while the app boots in standalone
    // mode; without them the user stares at a blank screen for as long as the
    // wasm bundle takes to download and compile — which, at ~19 MB, is a while.
    // Each needs a `<link>` whose media query matches the device exactly, so the
    // file name carries the logical size and scale factor `index.html` keys off.
    for &(w, h, dppx) in LAUNCH_SIZES {
        for theme in [Theme::Light, Theme::Dark] {
            let pixmap = render_launch(&tree, w * dppx, h * dppx, theme)?;
            write(&out.join(launch_file_name(w, h, dppx, theme)), &pixmap)?;
        }
    }

    // A scalable icon, for browsers that would rather have one.
    std::fs::copy(&logo, out.join("logo.svg")).map_err(|e| format!("copying logo.svg: {e}"))?;
    println!("Wrote icons to {}", out.display());

    write_launch_links(&root.join("frontend/index.html"))?;
    Ok(())
}

const LAUNCH_BEGIN: &str = "<!-- BEGIN generated: ios-launch-images (cargo xtask icons) -->";
const LAUNCH_END: &str = "<!-- END generated: ios-launch-images -->";

/// Rewrites the `apple-touch-startup-image` block in `index.html` from
/// [`LAUNCH_SIZES`], so the `<link>` media queries can't drift from the files
/// we actually generate. Safari needs one exactly-matching query per device;
/// there is no wildcard.
fn write_launch_links(index: &Path) -> Result<(), String> {
    let html =
        std::fs::read_to_string(index).map_err(|e| format!("reading {}: {e}", index.display()))?;
    let (Some(begin), Some(end)) = (html.find(LAUNCH_BEGIN), html.find(LAUNCH_END)) else {
        return Err(format!(
            "{} is missing the generated ios-launch-images markers",
            index.display()
        ));
    };

    let indent = "  ";
    let mut block = String::from(LAUNCH_BEGIN);
    for &(w, h, dppx) in LAUNCH_SIZES {
        for (theme, scheme) in [(Theme::Light, "light"), (Theme::Dark, "dark")] {
            let file = launch_file_name(w, h, dppx, theme);
            block.push_str(&format!(
                "\n{indent}<link rel=\"apple-touch-startup-image\" href=\"/icons/{file}\"\n\
                 {indent}      media=\"(device-width: {w}px) and (device-height: {h}px) \
                 and (-webkit-device-pixel-ratio: {dppx}) and (prefers-color-scheme: {scheme})\" />"
            ));
        }
    }
    block.push_str(&format!("\n{indent}"));

    let updated = format!("{}{}{}", &html[..begin], block, &html[end..]);
    std::fs::write(index, updated).map_err(|e| format!("writing {}: {e}", index.display()))?;
    println!("Updated launch-image links in {}", index.display());
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Theme {
    Light,
    Dark,
}

/// The launch image for a given device and theme. `index.html` builds the same
/// names from the same table, so the two must agree.
pub(crate) fn launch_file_name(w: u32, h: u32, dppx: u32, theme: Theme) -> String {
    let suffix = match theme {
        Theme::Light => "light",
        Theme::Dark => "dark",
    };
    format!("launch-{w}x{h}@{dppx}x-{suffix}.png")
}

/// Logical sizes (CSS px) and device-pixel ratios of the devices we ship iOS
/// launch images for. Landscape isn't listed: recent iOS rotates the portrait
/// image rather than demanding its own asset, and shipping both would double an
/// already chunky set of full-screen PNGs.
pub(crate) const LAUNCH_SIZES: &[(u32, u32, u32)] = &[
    // iPhone
    (320, 568, 2), // SE 1st gen
    (375, 667, 2), // SE 2nd/3rd gen, 8
    (390, 844, 3), // 12, 13, 14
    (393, 852, 3), // 14 Pro, 15, 16
    (414, 896, 2), // 11, XR
    (428, 926, 3), // 12/13/14 Pro Max
    (430, 932, 3), // 14 Pro Max, 15/16 Pro Max
    // iPad
    (768, 1024, 2),
    (810, 1080, 2),
    (820, 1180, 2),
    (834, 1194, 2),
    (1024, 1366, 2),
];

/// Draws the logo on a white rounded tile — the app icon, essentially —
/// centered on the theme's background color. On the light image the tile
/// vanishes into the background and you just see the logo; on the dark one it
/// reads as the icon floating on the app's own dark surface, which is what iOS
/// does for native launch screens.
fn render_launch(tree: &usvg::Tree, w: u32, h: u32, theme: Theme) -> Result<Pixmap, String> {
    let bg = match theme {
        Theme::Light => ICON_BG,
        Theme::Dark => DARK_BG,
    };
    let mut pixmap = Pixmap::new(w, h).ok_or_else(|| format!("invalid pixmap size {w}x{h}"))?;
    pixmap.fill(color(bg));

    let tile = 0.34 * w.min(h) as f32;
    let x = (w as f32 - tile) / 2.0;
    let y = (h as f32 - tile) / 2.0;
    draw_rounded_rect(&mut pixmap.as_mut(), x, y, tile, 0.225 * tile, ICON_BG);

    let logo = render(tree, tile as u32, tile as u32, PADDED_SCALE, None)?;
    pixmap.draw_pixmap(
        x as i32,
        y as i32,
        logo.as_ref(),
        &tiny_skia::PixmapPaint::default(),
        tiny_skia::Transform::identity(),
        None,
    );
    Ok(pixmap)
}

fn draw_rounded_rect(target: &mut PixmapMut<'_>, x: f32, y: f32, size: f32, r: f32, fill: [u8; 3]) {
    let mut pb = tiny_skia::PathBuilder::new();
    pb.move_to(x + r, y);
    pb.line_to(x + size - r, y);
    pb.quad_to(x + size, y, x + size, y + r);
    pb.line_to(x + size, y + size - r);
    pb.quad_to(x + size, y + size, x + size - r, y + size);
    pb.line_to(x + r, y + size);
    pb.quad_to(x, y + size, x, y + size - r);
    pb.line_to(x, y + r);
    pb.quad_to(x, y, x + r, y);
    pb.close();
    let Some(path) = pb.finish() else { return };

    let mut paint = tiny_skia::Paint::default();
    paint.set_color(color(fill));
    paint.anti_alias = true;
    target.fill_path(
        &path,
        &paint,
        tiny_skia::FillRule::Winding,
        tiny_skia::Transform::identity(),
        None,
    );
}

/// Renders `tree` centered in a `w`×`h` canvas, scaled so its longest side is
/// `scale` times the canvas width, over `bg` (or transparency when `None`).
fn render(
    tree: &usvg::Tree,
    w: u32,
    h: u32,
    scale: f32,
    bg: Option<[u8; 3]>,
) -> Result<Pixmap, String> {
    let mut pixmap = Pixmap::new(w, h).ok_or_else(|| format!("invalid pixmap size {w}x{h}"))?;
    if let Some(bg) = bg {
        pixmap.fill(color(bg));
    }

    let src = tree.size();
    let k = w as f32 * scale / src.width().max(src.height());
    let tx = (w as f32 - src.width() * k) / 2.0;
    let ty = (h as f32 - src.height() * k) / 2.0;
    let transform = tiny_skia::Transform::from_translate(tx, ty).pre_scale(k, k);

    resvg::render(tree, transform, &mut pixmap.as_mut());
    Ok(pixmap)
}

fn color(rgb: [u8; 3]) -> tiny_skia::Color {
    tiny_skia::Color::from_rgba8(rgb[0], rgb[1], rgb[2], 0xff)
}

fn write(path: &Path, pixmap: &Pixmap) -> Result<(), String> {
    let png = pixmap
        .encode_png()
        .map_err(|e| format!("encoding {}: {e}", path.display()))?;
    std::fs::write(path, png).map_err(|e| format!("writing {}: {e}", path.display()))
}
