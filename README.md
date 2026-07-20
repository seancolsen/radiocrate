# RadioCrate

A client-server app for managing and playing your personal collection of music files.

## Workspace layout

| Crate | Kind | Purpose |
|---|---|---|
| [`backend`](backend) | lib + bin (`radiocrate-server`) | Server logic (axum, DuckDB, scanner, audio stream). The bin is the dev API server. |
| [`frontend`](frontend) | lib + bin (`radiocrate-ui`) | egui app. The lib is shared between the native desktop bin and the WASM build. |
| [`radiocrate`](radiocrate) | bin (`radiocrate`) | **Production single binary** — depends on the `backend` lib and embeds the WASM frontend. |
| [`xtask`](xtask) | bin | Build orchestration (`cargo xtask build-release`). |

## Development

Build artifacts are split into two binaries so the UI can iterate without rebuilding the backend (and vice versa). The native UI talks to the API over HTTP on `localhost:3000`.

### Run the API server

```sh
cargo run -p backend -- /path/to/music
```

Options:

- `--port <PORT>` (default `3000`)
- `--no-scan` — skip the full collection scan on startup

### Run the native desktop UI

In a separate terminal:

```sh
cargo run -p frontend
```

Options:

- `--scale <FLOAT>` — UI scale factor (e.g. `--scale 1.5`)

The desktop UI sends queries to `http://localhost:3000` and streams Arrow IPC responses back.

## Production build

The production binary is a single executable that starts a web server, serves the API under `/api/*`, and serves the egui frontend (compiled to WASM) at `/`. All static assets (HTML, JS shim, WASM, etc.) are embedded into the binary.

### One-time setup

```sh
rustup target add wasm32-unknown-unknown
cargo install --locked trunk
```

### Build

```sh
cargo xtask build-release
```

This runs three steps:

1. `trunk build --release` in [frontend/](frontend) — compiles the egui app to WASM and emits `frontend/dist/`.
2. Stamps `dist/sw.js` with a hash of the build and the list of files to precache (see [Installing as an app](#installing-as-an-app)).
3. `cargo build --release -p radiocrate` — builds the production binary, embedding `frontend/dist/` via `rust-embed`.

The resulting binary is at `target/release/radiocrate`.

### Run

```sh
./target/release/radiocrate /path/to/music
```

Options match the dev API server (`--port`, `--no-scan`). The web UI is served at `http://localhost:<port>/`; the API at `http://localhost:<port>/api/*`.

### Clean the WASM build

```sh
cargo xtask clean-web
```

## Installing as an app

RadioCrate is a Progressive Web App: from a browser you can install it to a home
screen, dock or app launcher, after which it runs in its own window with no
browser chrome, its own icon and launch screen, and a service worker that caches
the app itself so it starts without waiting on the network. Playback keeps
driving the OS media controls — lock screen, notification shade, headset
buttons — as it already did in a tab.

### It has to be served over HTTPS

Browsers only allow service workers and installation on a **secure context**:
`https://`, or `http://localhost`. Reaching the server at a bare LAN address
like `http://192.168.1.20:3000` gives you neither on Android Chrome or iOS
Safari — the app still works, it just can't be installed.

RadioCrate doesn't terminate TLS itself; every installation lives on a different
hostname, so that's the administrator's job. Nothing the frontend serves names a
host — the manifest, the service worker scope and every asset URL are
host-relative — so no configuration is needed on our side whichever route you
take:

- **Home lab or laptop** — a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
  pointed at `http://localhost:<port>`. Certificates are handled for you and
  nothing needs to be exposed to the internet directly.
- **VPS** — [Caddy](https://caddyserver.com/) in front of the binary, which
  provisions and renews Let's Encrypt certificates automatically.

### Installing

- **Android (Chrome)** — the ⋮ menu → *Install app* / *Add to Home screen*.
- **Desktop Linux, Windows, macOS (Chrome/Edge)** — the install icon in the
  address bar, or ⋮ → *Cast, save and share* → *Install page as app*.
- **iOS/iPadOS (Safari)** — Share → *Add to Home Screen*. Safari is the only
  browser on iOS that can do this.

### What works offline

The app shell only: the HTML, the WASM bundle and its loader, the icons and the
manifest. That's what makes a cold launch instant, and it means opening the app
away from the server gets you the real UI rather than a browser error page.

Your library and your audio are **not** cached — they're served from `/api`,
which the service worker deliberately never touches (cached query results would
go stale invisibly, and caching audio would break seeking, which relies on range
requests). Without a reachable server the app opens but can't load or play
anything.

### Updating

A new build changes the stamped build id, so the service worker re-downloads
everything. It installs in the background and takes over on the next cold start
rather than mid-session — a surprise reload during playback is worse than being
one version behind for one launch. To take an update immediately, run
`radiocrate.applyUpdate()` in the devtools console.

### Regenerating the icons

Every icon, favicon and iOS launch image is rasterized from
[branding/logo.svg](branding/logo.svg) into `frontend/assets/icons/` (committed,
since the production build embeds them). After changing the logo:

```sh
cargo xtask icons
```

That also rewrites the block of `apple-touch-startup-image` `<link>` tags in
[frontend/index.html](frontend/index.html), which has to name every supported
device explicitly.

## Code formatting

Uses `rustfmt` with project-specific settings in [rustfmt.toml](rustfmt.toml).

```sh
cargo fmt
```

To check formatting without modifying files:

```sh
cargo fmt --check
```

## Linting

Uses `clippy` with workspace-level lint rules defined in [Cargo.toml](Cargo.toml).

```sh
cargo clippy
```
