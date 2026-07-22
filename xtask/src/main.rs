mod icons;

use std::path::PathBuf;
use std::process::{Command, ExitCode};

fn usage() {
    eprintln!(
        "cargo xtask <command>\n\n\
         Commands:\n  \
           build-release   Build the Solid frontend with Bun/Vite and the production binary\n  \
           clean-web       Remove the frontend/dist directory\n  \
           icons           Regenerate the PWA icon set from branding/logo.svg"
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

fn build_release() -> Result<(), String> {
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

    println!("==> bun install");
    run(Command::new("bun")
        .arg("install")
        .current_dir(&frontend))?;

    // Emits `frontend/dist` (Vite's outDir), which `radiocrate` embeds.
    // `vite-plugin-pwa` (Workbox) generates the service worker and handles
    // precache revisioning, so there is no separate stamping step.
    println!("==> bun run build");
    run(Command::new("bun")
        .args(["run", "build"])
        .current_dir(&frontend))?;

    println!("==> cargo build --release -p radiocrate");
    run(Command::new("cargo")
        .args(["build", "--release", "-p", "radiocrate"])
        .current_dir(&root))?;

    let bin = root.join("target/release/radiocrate");
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
        "clean-web" => clean_web(),
        "icons" => icons::generate(&workspace_root()),
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
