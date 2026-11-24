// The E2E suite's `test`: every test gets its own server on its own copy of
// the template, a browser whose clock is frozen at `E2E_NOW`, guards that fail
// it on errors nobody asserted, and helpers to arrange state through the API
// and read the app back. See `specs/2026-11-e2e-tests/spec.md` §4 and §6.

import fs from "node:fs";
import path from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import { Api, Db } from "./support/api";
import { App } from "./support/app";
import { E2E_NOW, E2E_TZ, FRONTEND, RUN_DIR } from "./support/paths";
import { abortedByUnload } from "./support/unload";
import { copyCollection, startServer, type Server } from "./support/server";

export { expect };

/** An error a guard would fail the test on, which the test expects. */
export type AllowedError = string | RegExp;

interface Fixtures {
  /** This test's server. Started for every test, before the page. */
  server: Server;
  /** Which database the server starts on: the sample library's template (the
   * default), or `"empty"` for a new library with nothing scanned. */
  library: "sample" | "empty";
  /** Whether the server serves a copy of the audio files of this test's own
   * (`server.collection`), which the test may add to and delete from before a
   * rescan, instead of the suite's shared copy, which no test may change. */
  privateCollection: boolean;
  /** The server process's time zone. The browser's is Playwright's own
   * `timezoneId` option; both are UTC unless a test sets them apart. */
  serverTimeZone: string;
  /** Errors the guards let through: page errors and `console.error` text,
   * `/api/` 5xx responses (matched against the URL) and server panics.
   * Set with `test.use({ allowedErrors: [/…/] })` in a test that expects
   * one, such as a rejected query. */
  allowedErrors: AllowedError[];
  /** The app, loaded and ready: the page object (`support/app.ts`). */
  app: App;
  /** The server's API, for arranging a test's preconditions. */
  api: Api;
  /** Read-only SQL against the server's database, for facts the UI can't show. */
  db: Db;
}

function matches(text: string, allowed: readonly AllowedError[]): boolean {
  return allowed.some((a) =>
    typeof a === "string" ? text.includes(a) : a.test(text),
  );
}

/** A file-system-safe name for a test. */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

export const test = base.extend<Fixtures>({
  library: ["sample", { option: true }],
  privateCollection: [false, { option: true }],
  serverTimeZone: [E2E_TZ, { option: true }],
  allowedErrors: [[], { option: true }],

  server: [
    async (
      { library, privateCollection, serverTimeZone, allowedErrors },
      use,
      testInfo,
    ) => {
      const runId = process.env.E2E_RUN_ID ?? String(process.pid);
      const runDir = path.join(
        RUN_DIR,
        runId,
        `${testInfo.workerIndex}-${slug(testInfo.titlePath.slice(1).join(" "))}`,
      );
      fs.rmSync(runDir, { recursive: true, force: true });
      let collection: string | undefined;
      if (privateCollection) {
        collection = path.join(runDir, "collection");
        copyCollection(collection);
      }
      const server = await startServer({
        dbDir: path.join(runDir, "db"),
        template: library === "empty" ? null : undefined,
        collection,
        timeZone: serverTimeZone,
      });
      try {
        await use(server);
      } finally {
        await server.stop();
      }
      const log = server.log();
      const failed = testInfo.status !== testInfo.expectedStatus;
      if (failed) {
        await testInfo.attach("server.log", {
          body: log,
          contentType: "text/plain",
        });
      } else {
        fs.rmSync(runDir, { recursive: true, force: true });
      }
      // Guard: a panic anywhere in the server fails the test, even one the
      // page never noticed.
      const panics = log
        .split("\n")
        .filter((line) => line.includes("panicked at"))
        .filter((line) => !matches(line, allowedErrors));
      if (!failed && panics.length > 0) {
        throw new Error(`The server panicked:\n${panics.join("\n")}`);
      }
    },
    { auto: true },
  ],

  baseURL: async ({ server }, use) => {
    await use(server.baseURL);
  },

  page: async ({ page, allowedErrors }, use, testInfo) => {
    // Frozen, not running: `Date` reads `E2E_NOW` for the whole test, while
    // timers and `performance.now()` run as usual. A test steps it forward
    // with `page.clock.setFixedTime` (playing the same track twice, say).
    await page.clock.setFixedTime(E2E_NOW);

    const errors: string[] = [];
    page.on("pageerror", (error) => {
      const text = `page error: ${error.message}`;
      if (abortedByUnload(page, text)) return;
      if (!matches(text, allowedErrors)) errors.push(text);
    });
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = `console.error: ${message.text()}`;
      if (abortedByUnload(page, text)) return;
      if (!matches(text, allowedErrors)) errors.push(text);
    });
    page.on("response", (response) => {
      const url = response.url();
      if (response.status() < 500 || !new URL(url).pathname.startsWith("/api/"))
        return;
      const text = `${response.status()} from ${url}`;
      if (!matches(text, allowedErrors)) errors.push(text);
    });

    await use(page);

    if (errors.length > 0 && testInfo.status === testInfo.expectedStatus) {
      throw new Error(
        `Unexpected errors during the test:\n${errors.join("\n")}`,
      );
    }
  },

  app: async ({ page }, use) => {
    const app = new App(page);
    await app.load();
    await use(app);
  },

  api: async ({ request }, use) => {
    await use(new Api(request));
  },

  db: async ({ request }, use) => {
    await use(new Db(request));
  },
});

/** How many times {@link look} has been called in each test, for numbering. */
const lookCounts = new WeakMap<object, number>();

/**
 * Saves a screenshot of the page at this step, when asked to with `E2E_LOOK=1`;
 * otherwise does nothing. Asserts nothing, and costs an ordinary run nothing.
 * Put one at each meaningful step of a journey, then run that one test with
 * the variable set and read the PNGs in `test-results/look/<test>/`.
 */
export async function look(page: Page, name: string): Promise<void> {
  if (!process.env.E2E_LOOK) return;
  const info = test.info();
  const n = (lookCounts.get(info) ?? 0) + 1;
  lookCounts.set(info, n);
  const file = path.join(
    FRONTEND,
    "test-results/look",
    slug(info.titlePath.slice(1).join(" ")),
    `${String(n).padStart(2, "0")}-${slug(name)}.png`,
  );
  await page.screenshot({ path: file });
}
