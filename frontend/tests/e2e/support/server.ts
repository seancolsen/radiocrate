// One test's server: a `radiocrate` process on its own copy of the template.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  COLLECTION_DIR,
  DB_FILE,
  E2E_NOW,
  E2E_TZ,
  SERVER_BIN,
  TEMPLATE_DIR,
} from "./paths";

/** How long a server has to log that it's listening. It usually takes about
 * a quarter of a second. */
const READY_TIMEOUT_MS = 20_000;

export interface Server {
  baseURL: string;
  /** The collection of audio files the server serves. */
  collection: string;
  /** Everything the server has logged so far. */
  log(): string;
  /** Stops the server and waits for it to exit. */
  stop(): Promise<void>;
}

export interface ServerOptions {
  /** The directory to hold this server's database. Created; must not exist. */
  dbDir: string;
  /** The database to start from: the template's (the default), or `null` for
   * none, so the server migrates a new, empty library. */
  template?: string | null;
  /** The collection to serve: the suite's shared copy (the default), or a
   * directory of this test's own, for a test that adds or deletes files. */
  collection?: string;
  /** The server process's time zone (`TZ`): `E2E_TZ` unless a test is about
   * a server and a browser in different zones. */
  timeZone?: string;
}

/** A port nothing is listening on, from the OS. Another process could take it
 * before the server binds it, so {@link startServer} retries on a clash. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** Copies the suite's collection to `dest`, mtimes and all, so the template's
 * database still matches every file in it: a rescan of the copy finds nothing
 * changed until the test changes something. */
export function copyCollection(dest: string): void {
  fs.cpSync(COLLECTION_DIR, dest, {
    recursive: true,
    preserveTimestamps: true,
  });
}

export async function startServer(options: ServerOptions): Promise<Server> {
  const template =
    options.template === undefined
      ? path.join(TEMPLATE_DIR, DB_FILE)
      : options.template;
  fs.mkdirSync(options.dbDir, { recursive: true });
  if (template !== null) {
    fs.copyFileSync(template, path.join(options.dbDir, DB_FILE));
  }
  for (let attempt = 1; ; attempt++) {
    try {
      return await spawnServer(
        options.dbDir,
        options.collection ?? COLLECTION_DIR,
        options.timeZone ?? E2E_TZ,
        await freePort(),
      );
    } catch (error) {
      if (attempt >= 3 || !String(error).includes("Address already in use")) {
        throw error;
      }
    }
  }
}

async function spawnServer(
  dbDir: string,
  collection: string,
  timeZone: string,
  port: number,
): Promise<Server> {
  const child = spawn(
    SERVER_BIN,
    [
      "--color",
      "never",
      "serve",
      collection,
      "--db-dir",
      dbDir,
      "--no-scan",
      "--port",
      String(port),
      "--fixed-now",
      E2E_NOW.toISOString(),
    ],
    {
      env: { ...process.env, TZ: timeZone },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (output += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (output += d));

  await waitUntilListening(child, () => output);
  return {
    baseURL: `http://127.0.0.1:${port}`,
    collection,
    log: () => output,
    stop: () => stop(child),
  };
}

function waitUntilListening(
  child: ChildProcess,
  output: () => string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (why: string) => {
      cleanup();
      child.kill("SIGKILL");
      reject(new Error(`The server ${why}. Its output:\n${output()}`));
    };
    const onData = () => {
      if (/ INFO .*: listening\b/.test(output())) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null) =>
      fail(`exited (${code}) before listening`);
    const timer = setTimeout(
      () => fail(`didn't start listening within ${READY_TIMEOUT_MS} ms`),
      READY_TIMEOUT_MS,
    );
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", onExit);
    onData();
  });
}

function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("exit", () => {
      clearTimeout(kill);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
