// Compiles Querydown queries with the vendored WASM compiler and prints the SQL,
// or the error, for each one. This is how the /querydown-issue skill tries
// queries against Querydown's sample schemas without building anything.
//
//   bun .claude/skills/querydown-issue/probe.ts [--schema S] [--dialect D] '<query>'...
//
// --schema   issue (default) | library | radiocrate | path/to/schema.json
//            issue and library are Querydown's sample schemas, read from the
//            checkout at target/querydown-src. radiocrate is the record
//            fixture's schema (src/dev/recordFixture.ts), with links inferred.
// --dialect  postgres (default; the Querydown CLI's default too) | duckdb
//
// Each query is a whole Querydown query (`#issues …`). Definitions such as
// `@x = 'v'` can go on lines ahead of it.

import { existsSync, readFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "../../..");
const vendor = join(root, "frontend/vendor/querydown-js");
const samples = join(root, "target/querydown-src/compiler/resources/test");

const { default: init, compile } = (await import(
  join(vendor, "querydown_js.js")
)) as typeof import("../../../frontend/vendor/querydown-js/querydown_js");

let schemaArg = "issue";
let dialect = "postgres";
const queries: string[] = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--schema") schemaArg = args[++i] ?? schemaArg;
  else if (args[i] === "--dialect") dialect = args[++i] ?? dialect;
  else queries.push(args[i]!);
}

async function loadSchema(name: string): Promise<string> {
  if (name === "radiocrate") {
    const fixture = (await import(
      join(root, "frontend/src/dev/recordFixture.ts")
    )) as { FIXTURE_SCHEMA_JSON: string };
    return fixture.FIXTURE_SCHEMA_JSON;
  }
  const path =
    name === "issue" || name === "library"
      ? join(samples, `${name}_schema.json`)
      : name;
  if (!existsSync(path)) {
    throw new Error(
      `No schema at ${path}. Clone Querydown into target/querydown-src (see the skill's step 1).`,
    );
  }
  return readFileSync(path, "utf8");
}

await init({ module_or_path: readFileSync(join(vendor, "querydown_js_bg.wasm")) });
const schema = await loadSchema(schemaArg);
if (queries.length === 0) console.error("No queries given.");
for (const query of queries) {
  console.log(`--- ${query}`);
  try {
    console.log(compile(schema, dialect, query).sql);
  } catch (err) {
    console.log("ERROR", JSON.stringify(err));
  }
}
