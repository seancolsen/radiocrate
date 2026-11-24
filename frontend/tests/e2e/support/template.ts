// The template database every test copies: the realistic sample library,
// generated as if it were `E2E_NOW`, and rebuilt only when what it's built
// from changes.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  COLLECTION_DIR,
  E2E_DIR,
  E2E_NOW,
  E2E_TZ,
  REPO_ROOT,
  SAMPLE_DIR,
  SERVER_BIN,
  TEMPLATE_DIR,
  TEMPLATE_KEY,
} from "./paths";

/** What the template is built from. A change to any of these rebuilds it. */
const INPUTS = [
  "sample-data/realistic/generator",
  "backend/src/migrations",
  "backend/src/scanner",
  "backend/src/db.rs",
];

/** Every file under `p` (or `p` itself), sorted, skipping caches. */
function files(p: string): string[] {
  const stat = fs.statSync(p);
  if (!stat.isDirectory()) return [p];
  return fs
    .readdirSync(p, { withFileTypes: true })
    .filter((e) => e.name !== "__pycache__" && !e.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => files(path.join(p, e.name)));
}

/** A hash of every input's path and contents, and of the instant. */
export function templateKey(): string {
  const hash = createHash("sha256");
  hash.update(`now=${E2E_NOW.toISOString()} tz=${E2E_TZ}\n`);
  for (const input of INPUTS) {
    for (const file of files(path.join(REPO_ROOT, input))) {
      hash.update(path.relative(REPO_ROOT, file));
      hash.update("\0");
      hash.update(fs.readFileSync(file));
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

/** `E2E_NOW` as the generator's `--now` takes it: a civil time, read in the
 * generator's own time zone (which is `E2E_TZ`). */
function generatorNow(): string {
  return E2E_NOW.toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "");
}

/** Builds the template if it's missing or its inputs have changed since it
 * was built. Returns whether it built. */
export function ensureTemplate(): boolean {
  const key = templateKey();
  const current = fs.existsSync(TEMPLATE_KEY)
    ? fs.readFileSync(TEMPLATE_KEY, "utf8").trim()
    : null;
  if (current === key && fs.existsSync(TEMPLATE_DIR)) return false;

  console.log("[e2e] Building the template database…");
  fs.mkdirSync(E2E_DIR, { recursive: true });
  fs.rmSync(TEMPLATE_KEY, { force: true });

  // A fresh copy of the audio files every time: the generator backdates
  // their mtimes, and a file left over from an older definition would be
  // scanned as part of the library.
  fs.rmSync(COLLECTION_DIR, { recursive: true, force: true });
  fs.cpSync(path.join(SAMPLE_DIR, "collection"), COLLECTION_DIR, {
    recursive: true,
    filter: (src) => path.basename(src) !== ".radiocrate",
  });

  // Built beside the template and moved into place, so an interrupted build
  // never leaves a half-made template behind.
  const building = `${TEMPLATE_DIR}.building`;
  fs.rmSync(building, { recursive: true, force: true });
  const result = spawnSync(
    path.join(SAMPLE_DIR, "generator/generate_database.py"),
    [
      "--now",
      generatorNow(),
      "--collection",
      COLLECTION_DIR,
      "--db-dir",
      building,
      "--server-bin",
      SERVER_BIN,
      // Ids derived from content, so a sort that ties falls back the same
      // way on every rebuild (spec §3.4).
      "--stable-ids",
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, TZ: E2E_TZ },
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Building the E2E template failed (exit ${result.status}):\n` +
        `${result.stdout}\n${result.stderr}${result.error ?? ""}`,
    );
  }
  fs.rmSync(TEMPLATE_DIR, { recursive: true, force: true });
  fs.renameSync(building, TEMPLATE_DIR);
  fs.writeFileSync(TEMPLATE_KEY, `${key}\n`);
  return true;
}
