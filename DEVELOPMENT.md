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

