// Runs once before the suite: refuses a stale server binary, rebuilds the
// frontend and the template database when their inputs have changed, and
// holds the suite to its pixel budget.
//
// It never runs cargo. Building the binary is `cargo xtask e2e-build`, which
// agents may run only under the conditions `CLAUDE.md` sets; running it from
// here would get around them whenever the suite ran after a dependency change.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { E2E_DIR, FRONTEND, REPO_ROOT, RUN_DIR, SERVER_BIN } from "./paths";
import { ensureTemplate } from "./template";

/** The most pixel snapshots the whole suite may hold. A test that needs one
 * more replaces an existing one, or raises this in the same change, where a
 * reviewer sees it. See the spec's §6.2. */
export const PIXEL_BUDGET = 12;

/** What the server binary is compiled from. */
const BACKEND_SOURCES = [
  "backend/src",
  "backend/Cargo.toml",
  "radiocrate/src",
  "radiocrate/Cargo.toml",
  "api-schema/src",
  "introspection/src",
  "Cargo.lock",
];

/** What `bun run build` reads. */
const FRONTEND_SOURCES = [
  "src",
  "public",
  "index.html",
  "vite.config.ts",
  "vendor",
  "package.json",
  "bun.lock",
  "../api-client/src",
];

/** The newest mtime among the files at `paths` (relative to `root`), with the
 * file it belongs to. */
function newest(
  root: string,
  paths: readonly string[],
): { mtime: number; file: string } {
  let best = { mtime: 0, file: "" };
  const visit = (p: string) => {
    if (!fs.existsSync(p)) return;
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(p)) {
        if (entry === "node_modules") continue;
        visit(path.join(p, entry));
      }
    } else if (stat.mtimeMs > best.mtime) {
      best = { mtime: stat.mtimeMs, file: p };
    }
  };
  for (const p of paths) visit(path.join(root, p));
  return best;
}

function checkBinary(): void {
  const fix = "Build it with `cargo xtask e2e-build` (from the repo root).";
  if (!fs.existsSync(SERVER_BIN)) {
    throw new Error(`No server binary at ${SERVER_BIN}. ${fix}`);
  }
  const built = fs.statSync(SERVER_BIN).mtimeMs;
  const source = newest(REPO_ROOT, BACKEND_SOURCES);
  if (source.mtime > built) {
    throw new Error(
      `The server binary is older than the backend sources ` +
        `(${path.relative(REPO_ROOT, source.file)} changed since it was built), ` +
        `so the suite would test the old code. ${fix}`,
    );
  }
}

function buildFrontend(): void {
  const stamp = path.join(FRONTEND, "dist/build-id.txt");
  const built = fs.existsSync(stamp) ? fs.statSync(stamp).mtimeMs : 0;
  const source = newest(FRONTEND, FRONTEND_SOURCES);
  if (source.mtime <= built) return;
  console.log(
    `[e2e] ${path.relative(FRONTEND, source.file)} is newer than dist/; running bun run build…`,
  );
  const result = spawnSync("bun", ["run", "build"], {
    cwd: FRONTEND,
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (result.status !== 0) {
    throw new Error(`bun run build failed (exit ${result.status})`);
  }
}

function checkPixelBudget(): void {
  const dir = path.join(FRONTEND, "tests/e2e/__screenshots__");
  const count = fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { recursive: true, encoding: "utf8" })
        .filter((f) => f.endsWith(".png")).length
    : 0;
  if (count > PIXEL_BUDGET) {
    throw new Error(
      `tests/e2e/__screenshots__ holds ${count} pixel baselines, over the budget ` +
        `of ${PIXEL_BUDGET}. Replace an existing one, or raise PIXEL_BUDGET in ` +
        `tests/e2e/support/globalSetup.ts in the same change.`,
    );
  }
}

/** Removes the run directories of earlier runs whose process has gone — what's
 * left there is a failed test's database, kept until the next run. */
function sweepRuns(): void {
  if (!fs.existsSync(RUN_DIR)) return;
  for (const entry of fs.readdirSync(RUN_DIR)) {
    const pid = Number(entry);
    if (Number.isInteger(pid) && pid !== process.pid && alive(pid)) continue;
    fs.rmSync(path.join(RUN_DIR, entry), { recursive: true, force: true });
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Holds a lock on `target/e2e/` while `f` runs, so two suites started at once
 * don't build the frontend or the template over each other. */
async function locked<T>(f: () => T): Promise<T> {
  fs.mkdirSync(E2E_DIR, { recursive: true });
  const lock = path.join(E2E_DIR, "setup.lock");
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch {
      // A lock older than any setup takes is left over from a killed run.
      const age = Date.now() - fs.statSync(lock).mtimeMs;
      if (age > 10 * 60_000) fs.rmSync(lock, { recursive: true, force: true });
      if (Date.now() > deadline)
        throw new Error(`Timed out waiting for ${lock}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  try {
    return f();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

export default async function globalSetup(): Promise<void> {
  checkPixelBudget();
  checkBinary();
  await locked(() => {
    buildFrontend();
    ensureTemplate();
    sweepRuns();
  });
  // Names this run's directory under `target/e2e/run/`. Workers inherit it.
  process.env.E2E_RUN_ID = String(process.pid);
}
