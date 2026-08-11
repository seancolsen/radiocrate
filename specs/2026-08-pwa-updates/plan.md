# PWA client updates

Implementation plan for making the installed PWA pick up a new client when the
server binary is upgraded.

## Status

Phases carry a status line; update it as they land so a session starting cold
doesn't have to reconstruct progress from `git log`.

| Phase | Status |
| ----- | ------ |
| 1 — Build identity | done |
| 2 — `app.version` RPC | done |
| 3 — Update controller | not started |
| 4 — UI | not started |
| 5 — Escape hatch | not started |
| 6 — Tests | not started |
| 7 — Cache headers | done |
| 8 — Skew guard | not started |

Phases 3–8 are meant to land across two further sessions: **3 + 8 + the
`shouldApplyNow()` unit test** in one, **4 + 5 + the two visual stories** in the
next. They are strictly sequential — 3 needs the generated `appVersion()` client
from phase 2, and 4 needs the signals phase 3 exports.

**Read this first if you're picking up phase 3:** `bun run dev` disables the
service worker entirely (`vite-plugin-pwa` only injects it on build), so none of
the update behavior is observable under the dev server. Verify against `bun run
build` + `vite preview`, or the real binary.

## The problem

`registerType: "prompt"` (`frontend/vite.config.ts`) parks a new service worker
in the `waiting` state and calls `onNeedRefresh()` so the app can offer a
reload. That callback is empty (`frontend/src/main.tsx:13`), and the only way to
activate the waiting worker is `window.radiocrate.applyUpdate()`, which nothing
in the UI calls and which is unreachable from an installed Android PWA. The new
client is downloaded and then never applied.

Relaunching the app doesn't help. A waiting worker activates only once every
client under the old worker is gone, and an Android PWA routinely keeps a client
alive across what feels like a full close. Even on a genuinely clean launch the
old worker serves the cached shell *first* and only then discovers the new
`sw.js`, so the earliest an update could ever land is the second launch.

Nothing re-checks while the app runs, either: no polling, no check on
foreground. A resident PWA never learns the server restarted.

## What makes this tractable here

`rust-embed` bakes `frontend/dist` into the binary (`radiocrate/src/main.rs:9`),
so the server and the client it serves are one artifact. There is no deploy skew
and no CDN. "Is this client stale?" has an exact answer, not a heuristic one —
which the design below leans on.

## Success criteria

1. Upgrade the binary, restart it, open the app: the user is on the new client,
   with no instructions and no interaction, in the common case.
2. An update never interrupts playback or discards unsaved edits without asking.
3. When something *is* wrong, the user can see the client and server versions
   and can force a clean reload without a desktop browser.
4. No `Cargo.toml` changes anywhere — builds stay cheap (see `CLAUDE.md`).

## Design decisions

### Build identity: a build id emitted by Vite, embedded in the binary

The frontend build computes a build id and writes it to two places: a `define`d
`__BUILD_ID__` constant compiled into the JS, and `dist/build-id.txt`. Because
`cargo xtask build-release` builds the frontend before `cargo build`
(`xtask/src/main.rs:150`), `rust-embed` picks up that file in the same run. The
server reads it from `Assets` at startup and reports it.

So the client compares its own compiled-in `__BUILD_ID__` against the id the
server reports. They match if and only if the running client came from the
running binary. No git dependency at comparison time, no drift possible.

The id itself: `git rev-parse --short HEAD`, plus `-dev-<epoch-ms>` when the
working tree is dirty or git is unavailable. This mirrors `radiocrate/build.rs`,
stays deterministic for release builds off a clean commit, and still changes on
every rebuild while iterating.

### Detection and application are separate concerns

The version RPC is the *detection* channel — cheap, fast, and diagnosable. On a
mismatch it calls `registration.update()` to make the service worker go fetch.
The service worker remains the *application* channel: `onNeedRefresh` is the
authoritative "new code is downloaded and ready to activate."

Keeping these apart means a wedged SW update check can't hide the fact that the
server moved on, and the About panel can show a real reason rather than a
shrug.

### Application policy: auto-apply when idle, prompt otherwise

A single predicate, `shouldApplyNow()`, gates automatic application:

- nothing is playing (`store.state.playback.playing`)
- no records have unsaved edits (`modifiedRecords()` from
  `frontend/src/components/record/formStash.ts`)
- no tab has unsaved changes (`store.isUnsaved(tabId)` for every open tab)
- **no tabs are open at all**

That last clause matters more than it looks. Open tabs are not persisted —
`localStorage` holds only prefs (sidebar, theme, audio quality, sidebar width) —
so *any* reload discards the user's open tabs, even one that interrupts nothing.
Restricting silent application to a genuinely empty session is what keeps
auto-apply from being a hostile surprise.

In practice the predicate is true exactly at cold boot, which is the moment that
matters: the user restarts the server, opens the app, and the pending update
applies before they've done anything. Everything else routes to the banner.

(Persisting open tabs across reloads would let this policy relax considerably.
Out of scope here; noted as a follow-up.)

## Phases

### Phase 1 — Build identity

**`frontend/vite.config.ts`**

- Compute the build id once at config load: `git rev-parse --short HEAD` via
  `node:child_process`, `git status --porcelain` for the dirty check, falling
  back to `dev-<epoch-ms>`.
- `define: { __BUILD_ID__: JSON.stringify(buildId) }`.
- A small inline plugin with a `closeBundle` hook writing the same string to
  `dist/build-id.txt`.
- Exclude `build-id.txt` from the Workbox precache
  (`workbox.globIgnores`) — it must always come from the network, and it isn't
  fetched by the client anyway (the server reads it, not the browser).

**`frontend/src/vite-env.d.ts`** (create if absent): `declare const __BUILD_ID__: string;`

Note for the harness: stories that display a build id must stub it, or visual
snapshots will churn on every commit. See Phase 6.

### Phase 2 — `app.version` RPC

Deliberately threaded as plain `String`s so `radiocrate` needs no new dependency
and no `Cargo.toml` is touched.

**`api-schema/src/lib.rs`**

- `AppVersion { build_id: String, server_version: String }` with the usual
  `#[derive(Debug, Clone, Serialize, Deserialize, TS)]` +
  `#[serde(rename_all = "camelCase")]`.
- Add to `type_decls()`.
- `METHODS` entry: `{ wire: "app.version", func: "appVersion", params: None, result: "AppVersion" }`.

**`backend/src/server.rs`**

- `AppState` gains `pub build_id: String` and `pub server_version: String`.
- `app_state(conn, collection_path, build_id, server_version)`.

**`backend/src/rpc.rs`**

- Arm in `dispatch_legacy`: `"app.version" => serde_json::to_value(AppVersion {...})`.
  No DB access, so it needs neither `state.read` nor `state.write`.

**`radiocrate/src/main.rs`**

- Read the build id from the embedded assets at startup:
  `Assets::get("build-id.txt")` → UTF-8 → trim, defaulting to `"unknown"`.
- Server version: the existing `concat!(env!("CARGO_PKG_VERSION"), " (", env!("GIT_HASH"), ")")`.
- Pass both into `server::app_state`.

Then `cargo xtask gen-api` and commit the regenerated `api-client/`.

#### As built: the `dev` sentinel

Two cases have no embedded frontend to compare against, and both resolve to
`api_schema::DEV_BUILD_ID` (`"dev"`), re-exported from `backend` so `radiocrate`
needs no `api-schema` dependency of its own:

- **The standalone dev server** (`backend::server::serve`) embeds no frontend —
  its client comes from Vite and is current by definition.
- **A binary whose embedded `dist/` has no `build-id.txt`**, which means a
  packaging fault rather than a stale client. It also prints a startup warning.

**Phase 3 must treat `buildId === "dev"` as "skip the staleness check"**, not as
a mismatch. Getting this wrong makes the banner permanent under `bun run dev`
and, worse, turns a build packaging fault into an unactionable nag for end
users. The check fails open on purpose.

Also note `vitest.config.ts` defines `__BUILD_ID__` as `"test"`, so a module
reading it stays importable from unit tests without pinning a moving value.

### Phase 3 — The update controller

New module `frontend/src/state/update.ts`, owning everything about the SW
lifecycle. `main.tsx` shrinks to a single `initUpdates()` call.

Surface:

- `updateReady()` — a signal, true when a worker is waiting.
- `versionInfo()` — last `app.version` result, for the About panel.
- `applyUpdate()` — `updateSW(true)`.
- `dismissUpdate()` — hide the banner for this session.
- `checkForUpdate()` — one `app.version` call; on `buildId !== __BUILD_ID__`,
  call `registration.update()`.
- `resetAppData()` — Phase 5.

Wiring:

- Keep `registerType: "prompt"`. `onNeedRefresh` sets `updateReady(true)`, then
  applies immediately if `shouldApplyNow()`, else leaves the banner to it.
- `onRegisteredSW(url, reg)` stashes the registration and starts the timers.
- `visibilitychange` → when `document.visibilityState === "visible"`, run
  `checkForUpdate()`. This is the main win for a resident Android PWA.
- `setInterval(checkForUpdate, 30 * 60 * 1000)` for long foreground sessions.
- Keep `window.radiocrate.applyUpdate` as-is; it's a useful debug seam.

`shouldApplyNow()` reads the store, so the controller needs store access —
initialize it from inside `Root()` (or pass an accessor) rather than at module
scope, so it isn't reading a store that doesn't exist yet.

### Phase 4 — UI

**`frontend/src/components/UpdateBanner.tsx`** — a slim bar rendered in `Main()`
in `App.tsx`, directly above `<NowPlaying />`, shown when `updateReady() &&
!dismissed()`. "A new version of RadioCrate is ready." + a "Reload" button + a
dismiss. Wording should say the reload closes open tabs, since it does.

**`frontend/src/components/AboutModal.tsx`** — built on the existing
`ui/Modal.tsx`. Shows server version, server build id, client build id, a
match/mismatch line, a "Check for updates" button, and the Phase 5 reset action.
This is the single most useful thing for a self-hoster debugging a stuck client.

**`frontend/src/components/SettingsMenu.tsx`** — an "About RadioCrate" item
after the separator, alongside "Keyboard shortcuts".

**`frontend/src/commands/registry.ts`** — an `app.check_for_updates` command so
it's palette-reachable. No default chord.

### Phase 5 — Escape hatch

`resetAppData()` in the update controller:

1. `navigator.serviceWorker.getRegistrations()` → `unregister()` each.
2. `caches.keys()` → `caches.delete()` each.
3. `location.reload()`.

Leave `localStorage` alone — theme and audio prefs are not the problem, and
losing them makes the action feel destructive.

Name it **"Reload fresh copy"**, not "Reset app data". It touches nothing on the
server and no user data; the name should say so, or nobody will dare press it.
Put a short confirm in front of it noting that open tabs will close.

### Phase 6 — Tests

**Unit (vitest)** — `shouldApplyNow()` as a table: playing, unsaved record,
unsaved tab, open-but-clean tab, empty session. This is the piece with real
logic in it and the piece most likely to regress.

**Visual (Playwright)** — per `CLAUDE.md`, one story per component:

- `update/banner` — the banner over a seeded query page.
- `about/modal` — the About modal, shot through its Portal.

Both stories must stub the build id and version strings to fixed values.
`mockApi.ts` needs an `app.version` handler returning a constant, and the story
must inject a constant client build id rather than reading `__BUILD_ID__` —
otherwise every commit rewrites both baselines.

**Not covered by automated tests:** the service worker lifecycle itself. Testing
real SW activation in CI is disproportionate to the value. It's verified by hand
(below).

**Manual verification** — the thing that actually proves this works:

1. `cargo xtask build-release`, run the binary, install the PWA on Android.
2. Change something visible, rebuild, restart the binary.
3. Fully close and reopen the app → new client, no prompt. *(the core case)*
4. Leave the app open, restart the server with a new build, background and
   foreground the app → banner appears within seconds.
5. Same, but with a track playing → banner, not a reload.
6. Same, but with unsaved record edits → banner, not a reload.
7. About panel shows matching ids after an update, mismatched before.

Note that `vite-plugin-pwa` disables the SW in dev, so none of this is
observable under `bun run dev` — test against the real binary or `vite preview`.

### Phase 7 — Cache-header polish

`radiocrate/src/main.rs:59-67` documents the frontend as having "stable
(unhashed) file names". It doesn't — `dist/assets/` is content-hashed
(`index-BsXt-K9s.js`). Blanket `no-cache` is safe but wasteful, and the comment
will mislead the next person to reason about caching.

- `/assets/*` → `public, max-age=31536000, immutable` (content-hashed, safe).
- Everything else, and **especially** `sw.js`, `index.html`, and
  `manifest.webmanifest` → `no-cache`. A cached `sw.js` defeats the entire
  update mechanism; this is the one line that must not be gotten wrong.
- Rewrite the comment to match reality.

### Phase 8 — Version-skew guard (advisory)

An old client against a new server can hit changed RPC shapes. Once Phase 3
lands, the mismatch is already detected — the question is only how hard to push.

Recommendation: **advisory, not forced.** On mismatch the banner appears with
stronger wording ("This client is out of date and may not work correctly"), and
is not dismissible. A forced mid-edit reload is worse than the API error it
prevents, and the auto-apply-when-idle path already resolves the mismatch at the
next cold start.

Escalate to a forced reload only if an RPC fails *and* the build ids differ —
at that point the session is already broken, so there's nothing left to protect.

## Order of work

Phases 1 and 2 are the foundation and land together (the build id is useless
without something reporting it). Phase 3 is the behavioral fix and is where the
value is — after it, the core case works with no UI at all. Phases 4–5 are the
user-facing surface. Phases 6–8 are hardening and can land independently.

Suggested commits:

1. Build id emitted by Vite, read by the server, exposed as `app.version` (1+2).
2. Update controller: real `onNeedRefresh`, idle policy, foreground checks (3).
3. Banner, About modal, settings entry, command (4).
4. Reload-fresh-copy escape hatch (5).
5. Tests + stories (6).
6. Cache headers and the stale comment (7).
7. Skew guard (8).

## Validation

No `Cargo.toml` changes are planned, so per `CLAUDE.md` cargo is cheap here:
`cargo check`, `cargo clippy`, `cargo fmt`, and `cargo test -p backend`. If the
plan drifts into touching `backend/Cargo.toml` or the workspace root, stop and
hand the build back.

Frontend, from `frontend/`: `bun run typecheck`, `bun run lint`, `bun run
format:check`, `bun run test:unit`, `bun run test:visual`.

## Risks and open questions

- **Reloading discards open tabs.** This is the constraint shaping the whole
  policy. Persisting open tabs would let auto-apply run far more freely and is
  the highest-value follow-up.
- **iOS.** Testing has been on Android. iOS evicts service workers and caches
  more aggressively; the design should degrade fine (more frequent full fetches,
  not staleness), but it's unverified.
- **Build id when `.git` is absent.** A release built from a tarball gets a
  timestamp id. Correct behavior, but two such builds of identical code look
  different to each other. Acceptable — `cargo xtask build-release` runs in a
  checkout.
- **`vite.config.ts` shelling out to git** makes the config non-hermetic. It's
  guarded by a fallback and matches what `radiocrate/build.rs` already does.
