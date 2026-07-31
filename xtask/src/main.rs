mod gen_api;
mod icons;

use std::path::PathBuf;
use std::process::{Command, ExitCode};

fn usage() {
    eprintln!(
        "cargo xtask <command>\n\n\
         Commands:\n  \
           build-release      Build the Solid frontend with Bun/Vite and the production binary\n  \
           build-release-pi   Cross-compile the production binary for the Raspberry Pi 4 (aarch64)\n  \
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

/// The Querydown revision `RadioCrate` builds its JS compiler binding from. Pinned
/// deliberately so the compiled SQL behavior stays consistent with the
/// schema/PRELUDE the frontend expects. See
/// `plans/2026-07-migrate-ui-to-dom/phase-03.md` §2.
const QUERYDOWN_REPO: &str = "https://github.com/seancolsen/querydown";
const QUERYDOWN_REV: &str = "aa4c06c";

/// Builds the Querydown JS binding (`querydown-js`) from a pinned Querydown
/// checkout with `wasm-pack` and vendors the generated `pkg/` into
/// `frontend/vendor/querydown-js/`, where `frontend/package.json`'s local `file:`
/// dependency points. This runs *before* `bun install` so the dependency
/// resolves. The vendored dir is a build artifact (gitignored); this is the one
/// step that (re)generates it. Not a `duckdb-sys` build — safe and fast.
fn build_querydown_js() -> Result<(), String> {
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
                "`{tool}` is required to build querydown-js ({hint})."
            ));
        }
    }

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

    // Vendor the generated package into frontend/vendor/querydown-js/.
    let pkg = src.join("bindings/js/pkg");
    let dest = root.join("frontend/vendor/querydown-js");
    if dest.exists() {
        std::fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    for name in [
        "querydown_js.js",
        "querydown_js.d.ts",
        "querydown_js_bg.wasm",
        "querydown_js_bg.wasm.d.ts",
        "package.json",
        "README.md",
        "LICENSE",
    ] {
        std::fs::copy(pkg.join(name), dest.join(name))
            .map_err(|e| format!("copying {name}: {e}"))?;
    }
    println!("Vendored querydown-js to {}", dest.display());
    Ok(())
}

/// Builds `frontend/dist`, which `radiocrate` embeds via `rust-embed`. Shared
/// by both the native and cross-compiled release builds — only the final
/// `cargo`/`cross` invocation differs between them.
fn build_frontend() -> Result<(), String> {
    let root = workspace_root();
    let frontend = root.join("frontend");

    let bun_check = Command::new("bun").arg("--version").output();
    if bun_check.is_err() || !bun_check.unwrap().status.success() {
        return Err(
            "`bun` is required. Install with: curl -fsSL https://bun.sh/install | bash\n\
             See https://bun.sh for other install methods."
                .into(),
        );
    }

    // Build + vendor the Querydown JS binding first, so the frontend's local
    // `file:` dependency on it resolves during `bun install` below.
    build_querydown_js()?;

    println!("==> bun install");
    run(Command::new("bun").arg("install").current_dir(&frontend))?;

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
/// Targets musl, not glibc: the default cross image for the gnueabihf target
/// links against a newer glibc than Raspberry Pi OS Bookworm ships, so the
/// binary fails at runtime with a `GLIBC_2.38' not found` error; musl statics
/// links libc instead, sidestepping that entirely (see DEVELOPMENT.md).
/// Requires `cross` (Docker-based) — see DEVELOPMENT.md — because
/// `duckdb-sys` and `audiopus_sys` compile bundled C/C++ from source and need
/// a real cross toolchain, not just a Rust target. Must be run on a host with
/// a Docker daemon (not from inside this project's own dev container, which
/// doesn't nest Docker).
fn build_release_pi() -> Result<(), String> {
    let root = workspace_root();

    let cross_check = Command::new("cross").arg("--version").output();
    if cross_check.is_err() || !cross_check.unwrap().status.success() {
        return Err(
            "`cross` is required. Install with:\n  \
             cargo install cross --git https://github.com/cross-rs/cross --locked\n\
             and make sure a Docker daemon is running. See DEVELOPMENT.md."
                .into(),
        );
    }

    build_frontend()?;

    const TARGET: &str = "armv7-unknown-linux-musleabihf";
    println!("==> cross build --profile release-pi --target {TARGET} -p radiocrate");
    run(Command::new("cross")
        // `cross` re-derives settings like `rustc-wrapper` from the *effective
        // Cargo config* (including ~/.cargo/config.toml) and injects them into
        // the container itself — so a host-wide sccache setup breaks the build
        // (the cross image doesn't have `sccache` installed) even after
        // clearing the env vars below, since those only cover ambient env
        // forwarding, not config-derived settings. The `--config` overrides
        // take the highest precedence in Cargo's own resolution and empty
        // string is cargo's documented way to disable a wrapper.
        .env_remove("RUSTC_WRAPPER")
        .env_remove("RUSTC_WORKSPACE_WRAPPER")
        .env_remove("CARGO_BUILD_RUSTC_WRAPPER")
        .env_remove("CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER")
        // Matches the `+neon` target-feature in .cargo/config.toml so the
        // bundled C/C++ builds (Opus, DuckDB) use the same FPU as the Rust
        // code they link against. Forwarded into the container via
        // Cross.toml's passthrough list.
        .env("CFLAGS_armv7_unknown_linux_musleabihf", "-mfpu=neon")
        .env("CXXFLAGS_armv7_unknown_linux_musleabihf", "-mfpu=neon")
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
