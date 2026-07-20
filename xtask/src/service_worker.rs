//! Stamps the built `dist/sw.js` with a build id and its precache list.
//!
//! Trunk is configured with `filehash = false`, so every build writes the same
//! file names. That's what the embedding server wants, but it leaves the
//! service worker no way to tell a new deployment from the one it already has
//! cached. So after the build we hash `dist/` and write that hash into the
//! worker: a changed hash means a new cache name, which means everything is
//! re-fetched. The file list is written from the same walk, so the worker can
//! never precache a URL the build didn't produce.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;

/// Files excluded from the precache. The launch images are iOS-only, used
/// before the app is even running and copied by iOS at install time — 1.5 MB of
/// them in the cache would buy nothing. `.gitkeep` is the placeholder that
/// keeps the gitignored `dist/` present on a fresh checkout.
fn is_precached(rel: &str) -> bool {
    rel != "sw.js" && rel != ".gitkeep" && !rel.starts_with("icons/launch-")
}

pub(crate) fn stamp(dist: &Path) -> Result<(), String> {
    let sw = dist.join("sw.js");
    if !sw.exists() {
        return Err(format!(
            "{} not found — did the trunk build copy assets/sw.js?",
            sw.display()
        ));
    }

    let mut files = Vec::new();
    collect(dist, dist, &mut files)?;
    files.sort();

    let mut hasher = DefaultHasher::new();
    for rel in &files {
        rel.hash(&mut hasher);
        std::fs::read(dist.join(rel))
            .map_err(|e| format!("reading {rel}: {e}"))?
            .hash(&mut hasher);
    }
    let build_id = format!("{:016x}", hasher.finish());

    // `/` is the start_url, and is what a cold launch requests; it resolves to
    // the same bytes as `/index.html` but needs its own cache entry.
    let mut urls = vec!["/".to_string()];
    urls.extend(
        files
            .iter()
            .filter(|rel| is_precached(rel))
            .map(|rel| format!("/{rel}")),
    );

    let source =
        std::fs::read_to_string(&sw).map_err(|e| format!("reading {}: {e}", sw.display()))?;
    let precache = urls
        .iter()
        .map(|u| format!("\"{u}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let stamped = replace_const(&source, "BUILD_ID", &format!("\"{build_id}\""))?;
    let stamped = replace_const(&stamped, "PRECACHE", &format!("[{precache}]"))?;

    std::fs::write(&sw, stamped).map_err(|e| format!("writing {}: {e}", sw.display()))?;
    println!("    build {build_id}, {} file(s) precached", urls.len());
    Ok(())
}

/// Rewrites the value of a top-level `const NAME = ...;` declaration.
fn replace_const(source: &str, name: &str, value: &str) -> Result<String, String> {
    let prefix = format!("const {name} = ");
    let start = source
        .find(&prefix)
        .ok_or_else(|| format!("sw.js has no `{prefix}` declaration to stamp"))?;
    let rest = &source[start + prefix.len()..];
    let end = rest
        .find(";\n")
        .ok_or_else(|| format!("sw.js's `{prefix}` declaration is unterminated"))?;
    Ok(format!(
        "{}{prefix}{value}{}",
        &source[..start],
        &rest[end..]
    ))
}

fn collect(root: &Path, dir: &Path, out: &mut Vec<String>) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("reading {}: {e}", dir.display()))?;
    for entry in entries {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.is_dir() {
            collect(root, &path, out)?;
        } else if let Ok(rel) = path.strip_prefix(root) {
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(())
}
