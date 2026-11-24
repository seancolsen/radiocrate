// The server's API, from the test's side: arrange preconditions through it
// (`api.rpc`), and read back what the UI can't show (`db.query`).

import type { APIRequestContext } from "@playwright/test";
import { tableFromIPC } from "apache-arrow";

/** JSON-RPC over `/api/rpc`, as the app itself calls it. The wire is
 * camelCase; see `api-client/src/client.ts` for the methods and their
 * parameters. */
export class Api {
  private nextId = 1;
  constructor(private readonly request: APIRequestContext) {}

  async rpc<T = unknown>(method: string, params: unknown = null): Promise<T> {
    const response = await this.request.post("/api/rpc", {
      data: { jsonrpc: "2.0", method, params, id: this.nextId++ },
    });
    if (!response.ok()) {
      throw new Error(
        `${method}: HTTP ${response.status()}: ${await response.text()}`,
      );
    }
    const body = (await response.json()) as {
      result?: T;
      error?: { message?: string };
    };
    if (body.error) {
      throw new Error(`${method}: ${body.error.message ?? "rpc error"}`);
    }
    return body.result as T;
  }
}

/** A row of a query's result: its columns by name, as Arrow decodes them
 * (`bigint` for a `BIGINT` such as `count(*)`, a `number` of epoch
 * milliseconds for a timestamp). */
export type Row = Record<string, unknown>;

/** SQL through `/api/query`, decoded from Arrow. For asserting facts the UI
 * doesn't show, and only for reading: a write here goes around the app's
 * change notifications. */
export class Db {
  constructor(private readonly request: APIRequestContext) {}

  async query(sql: string): Promise<Row[]> {
    const response = await this.request.post("/api/query", { data: sql });
    if (!response.ok()) {
      throw new Error(
        `HTTP ${response.status()} for ${sql}: ${await response.text()}`,
      );
    }
    const table = tableFromIPC(await response.body());
    return table.toArray().map((row) => ({ ...row.toJSON() }) as Row);
  }

  /** The single value of a one-row, one-column query. */
  async value(sql: string): Promise<unknown> {
    const rows = await this.query(sql);
    const first = rows[0];
    if (rows.length !== 1 || !first) {
      throw new Error(`${sql} returned ${rows.length} rows, not one`);
    }
    return Object.values(first)[0];
  }
}
