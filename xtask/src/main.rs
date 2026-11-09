mod gen_api;
mod icons;

use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

fn usage() {
    eprintln!(
        "cargo xtask <command>\n\n\
         Commands:\n  \
           build-release      Build the frontend with Bun/Vite and the production binary\n  \
           build-release-pi   Cross-compile the production binary for the Raspberry Pi 4 (armv7)\n  \
           vendor-querydown   Build the pinned Querydown's JS packages into frontend/vendor/\n  \
           clean-web          Remove the frontend/dist directory\n  \
           icons              Regenerate the PWA icon set from branding/logo.svg\n  \
           gen-api            Regenerate the TypeScript API client under api-client/"
    );
}

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("xtask must live in a workspace")
        .to_path_buf()
}

fn run(cmd: &mut Command) -> Result<(), String> {
    let status = cmd
        .status()
        .map_err(|e| format!("failed to spawn `{cmd:?}`: {e}"))?;
    if !status.success() {
        return Err(format!("`{cmd:?}` exited with {status}"));
    }
    Ok(())
}

/// The Querydown revision `RadioCrate` builds its JS packages from. Pinned
/// deliberately so the compiled SQL behavior stays consistent with the
/// schema/PRELUDE the frontend expects. See
/// `plans/2026-07-migrate-ui-to-dom/phase-03.md` §2.
const QUERYDOWN_REPO: &str = "https://github.com/seancolsen/querydown";
const QUERYDOWN_REV: &str = "12a5370";

/// Builds Querydown's two JS packages from a pinned Querydown checkout and
/// vendors them into `frontend/vendor/`, where `frontend/package.json`'s local
/// `file:` dependencies point:
///
/// - `querydown-js`, the compiler binding, built with `wasm-pack`;
/// - `querydown-codemirror`, the editor's highlighting and completion, built
///   with Bun (its `tsc` emits `dist/`).
///
/// This runs *before* `bun install` so the dependencies resolve. The vendored
/// dirs are build artifacts (gitignored); this is the one step that
/// (re)generates them. Not a `duckdb-sys` build — safe and fast.
fn build_querydown() -> Result<(), String> {
    let root = workspace_root();

    for (tool, hint) in [
        ("git", "install git"),
        (
            "wasm-pack",
            "install with: curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh",
        ),
    ] {
        let ok = Command::new(tool)
            .arg("--version")
            .output()
            .is_ok_and(|o| o.status.success());
        if !ok {
            return Err(format!(
                "`{tool}` is required to build Querydown's JS packages ({hint})."
            ));
        }
    }
    check_bun()?;

    // Clone (once) into a build cache under target/, then check out the pinned rev.
    let src = root.join("target/querydown-src");
    if !src.join(".git").exists() {
        println!("==> git clone {QUERYDOWN_REPO}");
        run(Command::new("git")
            .args(["clone", QUERYDOWN_REPO])
            .arg(&src))?;
    }
    println!("==> git checkout {QUERYDOWN_REV}");
    run(Command::new("git")
        .args(["fetch", "origin"])
        .current_dir(&src))?;
    run(Command::new("git")
        .args(["checkout", QUERYDOWN_REV])
        .current_dir(&src))?;

    // `--target web`: emits an ES-module package we init() ourselves; Vite serves
    // the .wasm same-origin (CSP/offline-safe — no external fetch).
    println!("==> wasm-pack build bindings/js --target web");
    run(Command::new("wasm-pack")
        .args(["build", "bindings/js", "--target", "web"])
        .current_dir(&src))?;
    vendor(
        &src.join("bindings/js/pkg"),
        &root.join("frontend/vendor/querydown-js"),
        &[
            "querydown_js.js",
            "querydown_js.d.ts",
            "querydown_js_bg.wasm",
            "querydown_js_bg.wasm.d.ts",
            "package.json",
            "README.md",
            "LICENSE",
        ],
    )?;

    // The CodeMirror package takes the binding's `tokenize` and completer as
    // arguments rather than importing them, so it builds without the WASM.
    let codemirror = src.join("bindings/codemirror");
    println!("==> bun install && bun run build (bindings/codemirror)");
    run(Command::new("bun")
        .args(["install", "--frozen-lockfile"])
        .current_dir(&codemirror))?;
    // Bun installs from upstream's `package-lock.json` by migrating it to a
    // `bun.lock`, which it writes even with `--no-save`. Drop it, so the
    // checkout stays clean for the next `git checkout`.
    let migrated = codemirror.join("bun.lock");
    if migrated.exists() {
        std::fs::remove_file(&migrated).map_err(|e| e.to_string())?;
    }
    run(Command::new("bun")
        .args(["run", "build"])
        .current_dir(&codemirror))?;
    vendor(
        &codemirror,
        &root.join("frontend/vendor/querydown-codemirror"),
        &["dist", "package.json", "README.md", "LICENSE"],
    )?;
    reinstall_vendored(&root.join("frontend"))
}

/// Puts freshly vendored packages into `frontend/node_modules`.
///
/// Bun installs a `file:` dependency as a *copy*, and `bun install` doesn't
/// re-copy one whose version is unchanged, which a re-vendored Querydown's
/// always is. Left alone, the app, its tests and a release build would all go
/// on using the old packages. So the installed copies are dropped, along with
/// Vite's pre-bundled deps (which hold copies of their own), and reinstalled.
/// Before the first `bun install` there's nothing installed to go stale.
fn reinstall_vendored(frontend: &Path) -> Result<(), String> {
    let modules = frontend.join("node_modules");
    if !modules.exists() {
        return Ok(());
    }
    for name in ["querydown-js", "querydown-codemirror", ".vite"] {
        let path = modules.join(name);
        if path.exists() {
            std::fs::remove_dir_all(&path)
                .map_err(|e| format!("removing {}: {e}", path.display()))?;
        }
    }
    println!("==> bun install --frozen-lockfile (vendored packages)");
    run(Command::new("bun")
        .args(["install", "--frozen-lockfile"])
        .current_dir(frontend))
}

/// Replaces `dest` with copies of `names` (files, or directories copied whole)
/// from `from`.
fn vendor(from: &Path, dest: &Path, names: &[&str]) -> Result<(), String> {
    if dest.exists() {
        std::fs::remove_dir_all(dest).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for name in names {
        copy_recursive(&from.join(name), &dest.join(name))
            .map_err(|e| format!("copying {name}: {e}"))?;
    }
    println!("Vendored {}", dest.display());
    Ok(())
}

fn copy_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
    if from.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &to.join(entry.file_name()))?;
        }
    } else {
        std::fs::copy(from, to)?;
    }
    Ok(())
}

/// The oldest Bun `build_frontend` accepts. Bun 1.2 made the text `bun.lock`
/// the lockfile. An older Bun ignores it, resolves every dependency afresh from
/// `package.json`'s version ranges and writes a binary `bun.lockb` instead, so
/// the release would be built from package versions nothing was tested with.
const MIN_BUN: (u32, u32, u32) = (1, 2, 0);

/// Parses `bun --version` output (`1.3.14`, or a prerelease such as
/// `1.3.14-canary.1+abc123`) into `(major, minor, patch)`.
fn parse_version(output: &str) -> Option<(u32, u32, u32)> {
    let core = output.trim().split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|part| part.parse::<u32>().ok());
    Some((parts.next()??, parts.next()??, parts.next()??))
}

/// Checks that `bun` is installed and at least [`MIN_BUN`].
fn check_bun() -> Result<(), String> {
    let output = Command::new("bun")
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .ok_or(
            "`bun` is required. Install with: curl -fsSL https://bun.sh/install | bash\n\
             See https://bun.sh for other install methods.",
        )?;
    let reported = String::from_utf8_lossy(&output.stdout);
    let (major, minor, patch) = MIN_BUN;
    match parse_version(&reported) {
        Some(version) if version >= MIN_BUN => Ok(()),
        Some(_) => Err(format!(
            "Bun {} is too old: {major}.{minor}.{patch} or newer is required, since older \
             versions ignore frontend/bun.lock. Upgrade with: bun upgrade",
            reported.trim()
        )),
        None => Err(format!(
            "couldn't read a version from `bun --version` (got {:?}); \
             Bun {major}.{minor}.{patch} or newer is required.",
            reported.trim()
        )),
    }
}

/// Builds `frontend/dist`, which `radiocrate` embeds via `rust-embed`. Shared
/// by both the native and cross-compiled release builds — only the final
/// `cargo`/`cross` invocation differs between them.
fn build_frontend() -> Result<(), String> {
    let root = workspace_root();
    let frontend = root.join("frontend");

    check_bun()?;

    // Build + vendor Querydown's JS packages first, so the frontend's local
    // `file:` dependencies on them resolve during `bun install` below.
    build_querydown()?;

    // `--frozen-lockfile`: install exactly what `bun.lock` records, and fail
    // rather than update it when it no longer matches `package.json`. A
    // release is built from the versions the lockfile says were tested, never
    // from ones resolved on the build machine. If this fails, run `bun install`
    // in `frontend/` and commit the updated `bun.lock`.
    println!("==> bun install --frozen-lockfile");
    run(Command::new("bun")
        .args(["install", "--frozen-lockfile"])
        .current_dir(&frontend))?;

    // Emits `frontend/dist` (Vite's outDir), which `radiocrate` embeds.
    // `vite-plugin-pwa` (Workbox) generates the service worker and handles
    // precache revisioning, so there is no separate stamping step.
    println!("==> bun run build");
    run(Command::new("bun")
        .args(["run", "build"])
        .current_dir(&frontend))?;

    Ok(())
}

fn build_release() -> Result<(), String> {
    let root = workspace_root();
    build_frontend()?;

    println!("==> cargo build --release -p radiocrate");
    run(Command::new("cargo")
        .args(["build", "--release", "-p", "radiocrate"])
        .current_dir(&root))?;

    let bin = root.join("target/release/radiocrate");
    println!("\nBuilt: {}", bin.display());
    Ok(())
}

/// Cross-compiles the production binary for the Raspberry Pi 4 (32-bit
/// Raspberry Pi OS / armhf, Cortex-A72) home-lab deployment target. The
/// target triple is armv7, not aarch64, even though the Pi's kernel is
/// 64-bit-capable — this Pi runs the 32-bit userland (see DEVELOPMENT.md).
/// Builds against glibc using a custom Debian Bookworm image (Cross.toml +
/// docker/cross-armv7-gnueabihf.Dockerfile), not cross-rs's default Ubuntu-
/// based image or musl — see DEVELOPMENT.md for why (in short: the default
/// image's glibc is too new for the Pi, and musl's unwinder is incompatible
/// with `DuckDB`'s C++ exceptions and crashes the process).
/// Requires `cross` (Docker-based) — see DEVELOPMENT.md — because
/// `duckdb-sys` and `audiopus_sys` compile bundled C/C++ from source and need
/// a real cross toolchain, not just a Rust target. Must be run on a host with
/// a Docker daemon (not from inside this project's own dev container, which
/// doesn't nest Docker).
fn build_release_pi() -> Result<(), String> {
    const TARGET: &str = "armv7-unknown-linux-gnueabihf";

    let root = workspace_root();

    let cross_check = Command::new("cross").arg("--version").output();
    if cross_check.is_err() || !cross_check.unwrap().status.success() {
        return Err("`cross` is required. Install with:\n  \
             cargo install cross --git https://github.com/cross-rs/cross --locked\n\
             and make sure a Docker daemon is running. See DEVELOPMENT.md."
            .into());
    }

    build_frontend()?;

    println!("==> cross build --profile release-pi --target {TARGET} -p radiocrate");
    run(Command::new("cross")
        // `cross` re-derives settings like `rustc-wrapper` from the *effective
        // Cargo config* (including ~/.cargo/config.toml) and injects them into
        // the container itself — so a host-wide sccache setup breaks the build
        // (our custom image doesn't have `sccache` installed) even after
        // clearing the env vars below, since those only cover ambient env
        // forwarding, not config-derived settings. The `--config` overrides
        // take the highest precedence in Cargo's own resolution and empty
        // string is cargo's documented way to disable a wrapper.
        .env_remove("RUSTC_WRAPPER")
        .env_remove("RUSTC_WORKSPACE_WRAPPER")
        .env_remove("CARGO_BUILD_RUSTC_WRAPPER")
        .env_remove("CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER")
        .args([
            "build",
            "--config",
            "build.rustc-wrapper=\"\"",
            "--config",
            "build.rustc-workspace-wrapper=\"\"",
            "--profile",
            "release-pi",
            "--target",
            TARGET,
            "-p",
            "radiocrate",
        ])
        .current_dir(&root))?;

    let bin = root.join(format!("target/{TARGET}/release-pi/radiocrate"));
    println!("\nBuilt: {}", bin.display());
    Ok(())
}

fn clean_web() -> Result<(), String> {
    let dist = workspace_root().join("frontend/dist");
    if dist.exists() {
        std::fs::remove_dir_all(&dist).map_err(|e| e.to_string())?;
        println!("Removed {}", dist.display());
    }
    Ok(())
}

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let Some(cmd) = args.next() else {
        usage();
        return ExitCode::from(2);
    };

    let result = match cmd.as_str() {
        "build-release" => build_release(),
        "build-release-pi" => build_release_pi(),
        "clean-web" => clean_web(),
        "vendor-querydown" => build_querydown(),
        "icons" => icons::generate(&workspace_root()),
        "gen-api" => gen_api::generate(&workspace_root()),
        "--help" | "-h" | "help" => {
            usage();
            Ok(())
        }
        other => Err(format!("unknown command: {other}")),
    };

    if let Err(e) = result {
        eprintln!("error: {e}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::{MIN_BUN, parse_version};

    #[test]
    fn parses_release_and_prerelease_versions() {
        assert_eq!(parse_version("1.3.14\n"), Some((1, 3, 14)));
        assert_eq!(parse_version("1.3.14-canary.1+abc123"), Some((1, 3, 14)));
        assert_eq!(parse_version("not a version"), None);
        assert_eq!(parse_version("1.3"), None);
    }

    #[test]
    fn rejects_bun_older_than_the_text_lockfile() {
        assert!(parse_version("1.1.29").unwrap() < MIN_BUN);
        assert!(parse_version("1.2.0").unwrap() >= MIN_BUN);
        assert!(parse_version("1.10.0").unwrap() >= MIN_BUN);
    }
}
