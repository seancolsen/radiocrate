import { beforeEach, describe, expect, it } from "vitest";
import { setRecordQueryRunner } from "../../query/recordData";
import type { RecordQuery } from "../../query/recordForm";
import { createAppStore, type AppStoreBundle } from "./index";
import { fakeEnv } from "./testEnv";

// The tab opened by "Show artist albums" and its kin is named for the record it
// started from once that record's text has been read. A file of its own, since
// it swaps the record query runner for the whole module registry.

const col = (name: string, type: string) => ({ name, type, nullable: false });

const artist = (id: string) => ({
  table: "artist",
  key: [{ column: "id", value: id }],
});

describe("naming a tab for the record it lists records of", () => {
  let bundle: AppStoreBundle;
  let asked: RecordQuery[];
  let answer: (string | null)[][];

  beforeEach(() => {
    asked = [];
    answer = [];
    setRecordQueryRunner((query) => {
      asked.push(query);
      return Promise.resolve({ rows: answer, columns: [] });
    });
    bundle = createAppStore(fakeEnv());
    bundle.actions.openTab({ id: "a", name: "a", definition: "{}" });
    bundle.store.setState((s) => {
      s.schema.json = "{}";
      s.schema.tables = [
        {
          name: "artist",
          columns: [
            col("id", "UUID"),
            col("sort_name", "VARCHAR"),
            col("name", "VARCHAR"),
          ],
          uniqueConstraints: [["id"]],
        },
      ];
    });
  });

  const names = () => bundle.store.getState().tabs.map((t) => t.name);

  it("prefixes the artist's name once it has been read", async () => {
    answer = [["Floyd, Pink", "Pink Floyd"]];
    bundle.actions.showArtistRecords("a", [artist("x")], "album");
    // Named for what it lists meanwhile.
    expect(names()).toEqual(["a", "albums"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(names()).toEqual(["a", "Pink Floyd: albums"]);
    expect(asked[0]).toMatchObject({
      base: "artist",
      filter: `id:="x"`,
      display: "$sort_name $name",
    });
  });

  it("leaves a tab the user has renamed meanwhile alone", async () => {
    answer = [[null, "Pink Floyd"]];
    bundle.actions.showArtistRecords("a", [artist("x")], "track");
    const id = bundle.store.getState().tabs[1].id;
    bundle.actions.beginRename(id);
    bundle.actions.setRenameBuffer("Mine");
    bundle.actions.commitRename();
    await new Promise((r) => setTimeout(r, 0));
    expect(names()).toEqual(["a", "Mine"]);
  });

  it("stays plain when the record has nothing to describe it", async () => {
    answer = [[null, ""]];
    bundle.actions.showArtistRecords("a", [artist("x")], "track");
    await new Promise((r) => setTimeout(r, 0));
    expect(names()).toEqual(["a", "tracks"]);
  });

  it("doesn't look for a description of several artists", () => {
    bundle.actions.showArtistRecords("a", [artist("x"), artist("y")], "track");
    expect(asked).toEqual([]);
    expect(names()).toEqual(["a", "tracks"]);
  });
});
