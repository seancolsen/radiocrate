# Development & testing

This project ships a Docker setup so you can do development and testing inside a container. The main reason is to run **Claude Code with full permissions** (`claude --dangerously-skip-permissions`) safely.

## How it's wired up

- The project directory is bind-mounted at `/workspace` inside the container, so edits on the host (or by the agent in the container) are immediately visible on both sides.
- Build artifacts are kept in a named volume mounted at `/workspace/target`, so the container's builds **don't clobber your host `./target`** and persist across container runs.
- The cargo registry and git caches are persisted in named volumes, so crates aren't re-downloaded every time.
- The host `~/.claude` and `~/.claude.json` are mounted into the container, so the container reuses your existing Claude Code login.

## First-time setup

Build the image (takes a few minutes — it compiles `wasm-pack` tooling and installs Node/Claude Code):

```sh
docker compose build
```

If your host UID/GID aren't 1000:1000, pass them explicitly:

```sh
docker compose build --build-arg USER_UID=$(id -u) --build-arg USER_GID=$(id -g)
```

## Daily use

Open an interactive shell in the container:

```sh
docker compose run --rm dev
```

`--rm` removes the container when you exit; the named volumes (build cache, crate cache) survive, so the next run is fast.

Inside the container you're at `/workspace` with the full toolchain so you can run cargo commands.

### Running Claude Code with full permissions

From inside the container shell:

```sh
claude --dangerously-skip-permissions
```

Because the container is isolated and only your project (plus caches) is mounted, you can let the agent run commands without approving each one.

To jump straight into Claude Code without a separate shell step:

```sh
docker compose run --rm dev claude --dangerously-skip-permissions
```

## Visual snapshot tests (production frontend — SolidJS)

The production frontend in [`frontend/`](../frontend) is a SolidJS SPA. Its
whole-app visual snapshots are [Playwright](https://playwright.dev) full-page
screenshots, captured in **both light and dark** and committed under
`frontend/tests/visual/__screenshots__/` as the regression baselines. Playwright
writes a transient `*-actual.png` on a mismatch (gitignored); only the committed
baselines are tracked.

The frontend is pure JS (no `Cargo.toml`), driven by [Bun](https://bun.sh). From
`frontend/`:

```sh
bun install                # first time / after dependency changes
bun run typecheck          # tsgo --noEmit
bun run lint               # ESLint + eslint-plugin-solid
bun run format:check       # Prettier
bun run build              # Vite → frontend/dist (+ Workbox sw.js, manifest)
bun run test:visual        # Playwright — compare against committed baselines
bun run test:visual:update # regenerate + commit the baselines
```

Playwright's browser needs a one-time install (`bunx playwright install chromium`,
plus its OS libraries via `bunx playwright install-deps chromium`). Screenshots
are only reproducible in the same (container) environment CI uses — font/GPU
drift on another machine produces spurious diffs.

## Optional: VS Code / Codespaces dev container

If you use VS Code, [.devcontainer/devcontainer.json](../.devcontainer/devcontainer.json) lets you run your **whole editor** inside this same container instead of opening a shell with `docker compose run`. It's a supplement — it reuses the exact same `docker-compose.yml` (Dockerfile, cache volumes, UID matching, entrypoint), so nothing about the CLI workflow above changes.

With the **Dev Containers** extension installed, open the Command Palette and choose **"Dev Containers: Reopen in Container."** VS Code builds/starts the compose service, installs `rust-analyzer` and the Claude Code extension inside it, and reopens the workspace at `/workspace`. Your terminal, language server, and Claude Code now all run in the container — so the agent's command execution is confined there too, which is the same isolation goal as running `claude --dangerously-skip-permissions` in the shell.

Notes specific to the dev container:

- It sets `overrideCommand: true` so VS Code keeps the container alive with its own keep-alive process; our `entrypoint.sh` still runs first, so the cache-volume ownership fix still applies.
- The shared `~/.claude` credential mount works the same locally. In **cloud Codespaces** there's no host `~/.claude` to mount, so you'd log into Claude Code separately inside the Codespace.
- This file is only meaningful to VS Code / Codespaces / the `devcontainer` CLI. Plain `docker compose` users can ignore it.

## Maintenance

- Rebuild the image after changing the `Dockerfile`:

    `docker compose build`
  
- Wipe the cached build artifacts and crates (forces a clean rebuild):

    `docker compose down -v`

- Bump the Rust version by editing the `FROM rust:1.91-bookworm` line in the `Dockerfile` to match a new host toolchain.

## Cross-compiling for the Raspberry Pi (home-lab deployment)

The production binary (`radiocrate`) can be cross-compiled from an x86
laptop for a Raspberry Pi 4 Model B (BCM2711, Cortex-A72, 32-bit Raspberry Pi
OS userland, target triple `armv7-unknown-linux-musleabihf`). Two dependencies
— `duckdb-sys` and `audiopus_sys` — compile bundled C/C++ from source, so this
needs a real cross C/C++ toolchain, not just `rustup target add`. We use
[`cross`](https://github.com/cross-rs/cross), which runs the build inside a
Docker image that already has the right armhf gcc/g++ and sysroot wired up
for `cc-rs`/`cmake-rs`.

**musl, not glibc.** The obvious triple to reach for is
`armv7-unknown-linux-gnueabihf` (glibc), but the default `cross` image for it
links against a newer glibc (2.38) than Raspberry Pi OS Bookworm ships (2.36)
— the resulting binary fails at runtime with
`version 'GLIBC_2.38' not found (required by ./radiocrate)`, since glibc only
guarantees backward compatibility, not forward. `armv7-unknown-linux-musleabihf`
statically links musl libc into the binary instead, so it has *no* runtime
dependency on the Pi's system libc at all — this also means the deployed
binary is fully self-contained (no shared libs to worry about) and immune to
this whole class of problem if the Pi's OS is ever upgraded. The tradeoff:
musl's allocator is simpler than glibc's and can be somewhat slower for
allocation-heavy workloads (worth keeping in mind given DuckDB's query engine
allocates heavily) — acceptable here for a home-lab deployment, but revisit if
you ever see allocator-bound performance issues.

**Confirming the target triple: don't trust `uname -m` alone.** Raspberry Pi
OS's 32-bit image still boots a 64-bit-capable kernel (the `-v8` kernel
variant), and `uname -m` reports the *kernel's* architecture, not the
userland's — so it prints `aarch64` even on a fully 32-bit userland. The
reliable check is the actual bitness of an installed binary:

```sh
file /bin/bash
```

If that says `ELF 32-bit ... ARM, EABI5 ... interpreter /lib/ld-linux-armhf.so.3`,
you're on the 32-bit userland and want `armv7-unknown-linux-musleabihf` (as
below). If it says `ELF 64-bit ... ARM aarch64 ... interpreter
/lib/ld-linux-aarch64.so.1`, you're on 64-bit Raspberry Pi OS and want
`aarch64-unknown-linux-musl` instead (or `aarch64-unknown-linux-gnu` if you'd
rather match glibc precisely for that case — check the target glibc version
first) — swap the target triple everywhere below (`.cargo/config.toml`,
`Cross.toml`, `xtask`'s `build_release_pi`) if that's your case.

**This must run on a host with a Docker daemon** — not from inside this
project's own dev container (above), which doesn't nest Docker. Run it
directly on your laptop.

### One-time setup (on your x86 laptop, not in the dev container)

1. Install Docker (if you don't already have it).
2. Install `cross` (the crates.io release lags behind fixes, so install from git):

    ```sh
    cargo install cross --git https://github.com/cross-rs/cross --locked
    ```

3. That's it — `cross` installs the `armv7-unknown-linux-musleabihf` Rust
   target itself inside its build container; you don't need
   `rustup target add` on the host.

### Building

```sh
cargo xtask build-release-pi
```

This builds the frontend (same as `build-release`), then runs:

```sh
cross build --profile release-pi --target armv7-unknown-linux-musleabihf -p radiocrate
```

producing a single self-contained, statically-linked binary (the frontend is
embedded via `rust-embed`) at:

```
target/armv7-unknown-linux-musleabihf/release-pi/radiocrate
```

Copy that one file to the Pi and run it — no other assets needed.

If you have `sccache` (or any other `rustc-wrapper`) configured globally on
your host, `cargo xtask build-release-pi` strips those env vars before
invoking `cross` — the cross container doesn't have `sccache` installed, and
`cross` would otherwise forward the setting in and break the build with
`could not execute process "sccache rustc -vV"`.

### Notes / things to revisit if hardware changes

- **CPU tuning is hardware-specific.** [`.cargo/config.toml`](../.cargo/config.toml)
  sets `-C target-cpu=cortex-a72` for the `armv7-unknown-linux-musleabihf`
  target, matching the Pi 4's Cortex-A72 cores. If you ever deploy to
  different hardware (e.g. a Pi 5's Cortex-A76, or a 64-bit Raspberry Pi OS
  install), both this flag *and* the target triple need to change — CPU
  tuning is per-microarchitecture, and a mismatch can make LLVM emit
  instructions the actual CPU doesn't support, not just miss optimizations.
- **`release-pi` profile** (root `Cargo.toml`) enables fat LTO,
  `codegen-units = 1`, and symbol stripping for a smaller/faster binary. It's
  a separate profile from `release` specifically so this doesn't slow down
  ordinary x86 release builds — worthwhile here only because this is built
  rarely, not on every iteration.
- **NEON.** The generic `armv7-unknown-linux-musleabihf` Rust target defaults
  to `vfpv3-d16` (no NEON SIMD), since that target also covers ARMv7 hardfloat
  boards without it. The Pi 4's Cortex-A72 does have NEON, so
  `.cargo/config.toml` adds `-C target-feature=+neon`, and [`Cross.toml`](../Cross.toml)
  + `xtask`'s `build_release_pi` forward matching `-mfpu=neon` `CFLAGS`/`CXXFLAGS`
  into the container for the bundled C/C++ builds (Opus, DuckDB). Without the
  C-side flag, compiling Opus's ARM NEON intrinsics file fails with "target
  specific option mismatch" even though the Rust side builds fine. You'll see
  a `warning: unstable feature specified for '-Ctarget-feature': 'neon'` during
  the build — that's expected and harmless (32-bit ARM's `neon` feature isn't
  on rustc's stable allowlist, but it still works when passed explicitly).
- **Link order (`-lc` at the end).** `audiopus_sys` registers `opus` as a
  dynamic-style link dependency even though we only build a static
  `libopus.a`, so rustc places `-lc` *before* it in the final link command.
  GNU `ld` resolves archives in one left-to-right pass, so it fails with
  `undefined reference to 'lrintf'`/`'atoi'` — real musl functions it just
  can't see anymore by the time it reaches `libopus.a`. The `link-arg=-lc` in
  `.cargo/config.toml` appends `-lc` again at the very end so the linker
  re-scans it after everything else.
- If a future dependency needs a system library (via `pkg-config`) rather
  than building bundled C/C++, the default `cross` image may not have the
  `armhf` dev package installed; you'd then extend `Cross.toml` with a custom
  Dockerfile. Not needed today — `duckdb-sys` and `audiopus_sys` both vendor
  and build their own C/C++ sources.

## Inspecting the query API endpoint

The query API streams Arrow IPC binary format to the browser. This is great for performance, but cumbersome for troubleshooting.

To inspect the return value of this API, do the following:

1. Find a request in your dev tools and choose "Copy as cURL".
1. Paste into your terminal, appending "-o response.arrow" to run the API request and save the response to an arrow file.
1. Start duckdb in the same directory and run:

    ```
    INSTALL arrow FROM community;
    LOAD arrow
    SELECT * FROM read_arrow('response.arrow');
    ```

