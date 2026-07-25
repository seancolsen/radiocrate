//! Rasterizes `branding/logo.svg` into the PNG icon set the PWA needs.
//!
//! Browsers won't take an SVG for the places that matter most — Android's
//! adaptive launcher icon, the iOS home-screen icon, the iOS launch screen, the
//! desktop shortcut Chrome writes when you install the app — so the logo gets
//! baked into PNGs here and committed under `frontend/public/`.
//! Run `cargo xtask icons` after changing the logo.
//!
//! The master SVG draws the artwork on a black disc. The disc is there to
//! position the artwork for the contexts that want a circular ground; every
//! context that doesn't is rendered from a disc-less copy of the tree (see
//! [`strip_backdrop`]) so the logo never carries a backdrop it wasn't asked for.

use resvg::tiny_skia::{self, Pixmap, PixmapMut};
use resvg::usvg;
use std::path::Path;

/// The ground under every opaque icon. The artwork is drawn to sit on the
/// master SVG's black disc, so black is the color it was designed against —
/// and a full-bleed black square is what the disc becomes once the platform is
/// doing its own masking.
const ICON_BG: [u8; 3] = [0x00, 0x00, 0x00];

/// The launch screens' backgrounds — the app's panel fill in each theme, so
/// the launch image hands off to the booted app without a color jump.
const LIGHT_BG: [u8; 3] = [0xf8, 0xf8, 0xf8];
const DARK_BG: [u8; 3] = [0x1b, 0x1b, 0x1b];

/// How much of a maskable icon's width the artwork may occupy. Android crops
/// maskable icons to an arbitrary shape and only guarantees the middle 80%
/// (the "safe zone"); the worst-case mask is a circle, and a roughly square
/// logo inscribed in that circle can't be much wider than this.
const MASKABLE_SCALE: f32 = 0.66;

/// The iOS home-screen icon is masked to a rounded square rather than an
/// arbitrary shape, so the artwork can sit closer to the edge than a maskable
/// icon's — but not against it, since iOS rounds the corners in.
const PADDED_SCALE: f32 = 0.80;

/// Icons drawn on transparency get no backdrop to hide behind, so the artwork
/// runs nearly to the edge: whatever surface the OS puts behind them is all the
/// margin they get.
const FREESTANDING_SCALE: f32 = 0.94;

/// Sizes shipped for the manifest's `purpose: "any"` icons.
///
/// The small end of this ladder is not decoration. When Chrome installs a PWA
/// on Linux it writes a `.desktop` file plus a PNG into
/// `~/.local/share/icons/hicolor/<N>x<N>/apps/` for a fixed set of `N` — 16,
/// 32, 48, 64, 128, 256 — and that hicolor set is what the shell's task
/// switcher and dock read. Any size Chrome can't satisfy from a declared icon
/// it resamples from the nearest one it has, so a manifest offering only 192
/// and 512 leaves every desktop size to a non-integer downscale: exactly the
/// soft, low-resolution icon that shows up in the switcher. Declaring each size
/// Chrome asks for means it installs pixels we rendered at that size.
const ANY_SIZES: &[u32] = &[16, 32, 48, 64, 96, 128, 192, 256, 512];

/// Sizes shipped for `purpose: "maskable"`. These are only ever consumed by a
/// platform that rescales them into its own adaptive-icon pipeline anyway, so
/// the ladder can be short.
const MASKABLE_SIZES: &[u32] = &[192, 512];

pub(crate) fn generate(root: &Path) -> Result<(), String> {
    let logo = root.join("branding/logo.svg");
    let out = root.join("frontend/public/icons");
    std::fs::create_dir_all(&out).map_err(|e| format!("creating {}: {e}", out.display()))?;

    let svg =
        std::fs::read_to_string(&logo).map_err(|e| format!("reading {}: {e}", logo.display()))?;
    // Every job below draws the artwork alone; the disc's only role in this
    // file is to be removed. Backgrounds get painted here instead, so each
    // context gets one shaped the way that context wants it.
    let bare = strip_backdrop(&svg)?;
    let tree = parse(&bare, &logo)?;

    // (file name, size, artwork scale, background)
    let mut jobs: Vec<(String, u32, f32, Option<[u8; 3]>)> = Vec::new();

    // The manifest's "any" icons. Transparent, because a browser that draws
    // them on its own surface — a tab strip, a dark app list, a task switcher —
    // shouldn't get a square of our background color in the middle of it.
    for &size in ANY_SIZES {
        jobs.push((format!("icon-{size}.png"), size, FREESTANDING_SCALE, None));
    }
    // Maskable icons are always composited onto something and cropped to a
    // shape we don't choose, so their background has to be full-bleed: any
    // transparency is filled by a system color with no relation to the logo.
    for &size in MASKABLE_SIZES {
        jobs.push((
            format!("icon-maskable-{size}.png"),
            size,
            MASKABLE_SCALE,
            Some(ICON_BG),
        ));
    }
    // iOS ignores transparency and flattens onto black, so bake the ground in.
    jobs.push((
        "apple-touch-icon.png".into(),
        180,
        PADDED_SCALE,
        Some(ICON_BG),
    ));

    for (name, size, scale, bg) in &jobs {
        let pixmap = render(&tree, *size, *size, *scale, *bg)?;
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

    // A scalable icon, for browsers that would rather have one. Same deal as
    // the "any" PNGs: no disc, and cropped so it frames the artwork the way
    // they do instead of floating it in the master's 500×500 page.
    let scalable = crop_to_artwork(&bare, &tree)?;
    std::fs::write(out.join("logo.svg"), scalable).map_err(|e| format!("writing logo.svg: {e}"))?;
    println!("Wrote icons to {}", out.display());

    write_launch_links(&root.join("frontend/index.html"))?;
    Ok(())
}

fn parse(svg: &str, path: &Path) -> Result<usvg::Tree, String> {
    usvg::Tree::from_data(svg.as_bytes(), &usvg::Options::default())
        .map_err(|e| format!("parsing {}: {e}", path.display()))
}

/// Drops the black disc the master SVG draws the artwork on.
///
/// It's the document's first `<circle>`, and its only one — the artwork itself
/// is all `<path>`. Erroring out when it isn't found is deliberate: if the logo
/// is ever redrawn without the disc, this file's whole background story needs
/// rethinking, and a loud failure beats silently shipping an icon set with a
/// hole where the ground used to be.
fn strip_backdrop(svg: &str) -> Result<String, String> {
    let start = svg
        .find("<circle")
        .ok_or("branding/logo.svg has no <circle>: the backdrop disc is gone")?;
    let end = svg[start..]
        .find("/>")
        .map(|i| start + i + 2)
        .ok_or("the <circle> in branding/logo.svg is not self-closing")?;
    if !svg[start..end].contains("fill:#000000") {
        return Err("the first <circle> in branding/logo.svg is not the black backdrop".into());
    }
    Ok(format!("{}{}", &svg[..start], &svg[end..]))
}

/// Retargets the root `<svg>`'s size and viewBox onto the artwork's bounding
/// box, padded to the framing [`render`] gives the PNGs at
/// [`FREESTANDING_SCALE`]. Without this the SVG icon would draw noticeably
/// smaller than its PNG siblings in the same box: the master page is sized for
/// the disc, and the artwork only fills the part of it the disc enclosed.
fn crop_to_artwork(svg: &str, tree: &usvg::Tree) -> Result<String, String> {
    let bbox = tree.root().abs_bounding_box();
    let side = bbox.width().max(bbox.height()) / FREESTANDING_SCALE;
    let x = bbox.x() - (side - bbox.width()) / 2.0;
    let y = bbox.y() - (side - bbox.height()) / 2.0;

    let mut out = svg.to_string();
    set_root_attr(&mut out, "viewBox", &format!("{x} {y} {side} {side}"))?;
    set_root_attr(&mut out, "width", &side.to_string())?;
    set_root_attr(&mut out, "height", &side.to_string())?;
    Ok(out)
}

/// Replaces `name="..."` on the root `<svg>` element.
fn set_root_attr(svg: &mut String, name: &str, value: &str) -> Result<(), String> {
    let root = svg.find("<svg").ok_or("no <svg> element")?;
    let head_end = svg[root..]
        .find('>')
        .map(|i| root + i)
        .ok_or("unterminated <svg> element")?;

    let needle = format!("{name}=\"");
    let at = svg[root..head_end]
        .match_indices(&needle)
        // Guard against matching the tail of a longer attribute name.
        .find(|(i, _)| svg.as_bytes()[root + i - 1].is_ascii_whitespace())
        .map(|(i, _)| root + i + needle.len())
        .ok_or_else(|| format!("root <svg> has no {name} attribute"))?;
    let close = svg[at..]
        .find('"')
        .map(|i| at + i)
        .ok_or_else(|| format!("unterminated {name} attribute"))?;

    svg.replace_range(at..close, value);
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

/// Draws the app icon — the artwork on a black rounded tile — centered on the
/// theme's background color. That's what iOS does for native launch screens,
/// and what the HTML boot screen in `index.html` shows for the same moment on
/// every other platform.
fn render_launch(tree: &usvg::Tree, w: u32, h: u32, theme: Theme) -> Result<Pixmap, String> {
    let bg = match theme {
        Theme::Light => LIGHT_BG,
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

/// Renders `tree` centered in a `w`×`h` canvas, scaled so the longest side of
/// its *artwork* is `scale` times the canvas width, over `bg` (or transparency
/// when `None`).
///
/// Fitting the drawn bounding box rather than the SVG page matters here: the
/// master page is sized for a disc the artwork no longer carries, so measuring
/// the page would silently inset every icon by the disc's own margin.
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

    let src = tree.root().abs_bounding_box();
    let k = w as f32 * scale / src.width().max(src.height());
    let tx = (w as f32 - src.width() * k) / 2.0 - src.x() * k;
    let ty = (h as f32 - src.height() * k) / 2.0 - src.y() * k;
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
