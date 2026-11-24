// Where the E2E suite finds things, and the one instant it runs at.
//
// See `specs/2026-11-e2e-tests/spec.md`. Everything the suite builds or
// writes lives under `target/e2e/`, a named volume in the dev container that
// git already ignores.

import { fileURLToPath } from "node:url";
import path from "node:path";

/** `frontend/`. */
export const FRONTEND = fileURLToPath(new URL("../../..", import.meta.url));
/** The repository root. */
export const REPO_ROOT = path.dirname(FRONTEND);

/** Everything the suite builds or writes. */
export const E2E_DIR = path.join(REPO_ROOT, "target/e2e");
/** The suite's own copy of the sample collection's audio files. The generator
 * backdates their mtimes relative to {@link E2E_NOW}, so they can't be shared
 * with the development database, whose anchor is the real time. */
export const COLLECTION_DIR = path.join(E2E_DIR, "collection");
/** The template database, copied for each test. */
export const TEMPLATE_DIR = path.join(E2E_DIR, "template");
/** The hash of the inputs the template was built from. */
export const TEMPLATE_KEY = path.join(E2E_DIR, "template.key");
/** One directory per test, each holding that test's copy of the template. */
export const RUN_DIR = path.join(E2E_DIR, "run");

/** The database file within a database directory (the backend's fixed name). */
export const DB_FILE = "radiocrate.db";

/** The binary that serves each test: a debug build, which reads
 * `frontend/dist` from disk, so a frontend rebuild needs no recompile. Built
 * by `cargo xtask e2e-build`. */
export const SERVER_BIN = path.join(REPO_ROOT, "target/debug/radiocrate");

/** The sample collection's generator scripts and source files. */
export const SAMPLE_DIR = path.join(REPO_ROOT, "sample-data/realistic");

/** The instant every test runs at: the fixture is generated as if it were
 * now, the browser's `Date` is frozen here, and the server's `now()` is pinned
 * here. "2 minutes ago" then reads the same on every run, and so does every
 * absolute date. */
export const E2E_NOW = new Date("2026-01-15T12:00:00Z");

/** The time zone the generator, the server and the browser all run in.
 * Timestamps in the database are zone-less civil times, written by whichever
 * of them made the row, so the three have to agree. */
export const E2E_TZ = "UTC";
