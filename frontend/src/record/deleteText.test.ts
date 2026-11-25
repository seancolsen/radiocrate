import { describe, expect, it } from "vitest";
import type { PlanItem, Relationship } from "./deletePlan";
import {
  audioFileCount,
  audioFilesLabel,
  audioFilesNote,
  blockedNote,
  deleteTitle,
  itemLabel,
  itemNote,
  missingNote,
  totalsNote,
} from "./deleteText";

function relationship(
  from: string,
  to: string,
  required = false,
): Relationship {
  const dot = from.lastIndexOf(".");
  return {
    id: `${from}>${to}`,
    fromTable: from.slice(0, dot),
    fromColumn: from.slice(dot + 1),
    toTable: to,
    toColumn: "id",
    required,
  };
}

function item(
  kind: PlanItem["kind"],
  rel: Relationship,
  count: number,
): PlanItem {
  return {
    id: `${kind}:${rel.id}`,
    kind,
    relationship: rel,
    table: kind === "orphans" ? rel.toTable : rel.fromTable,
    count,
    checked: rel.required,
    required: kind === "referencing" && rel.required,
  };
}

describe("the dialog's title", () => {
  it("counts more than one record", () => {
    expect(deleteTitle("track", 1)).toBe("Delete track");
    expect(deleteTitle("track", 1234)).toBe("Delete 1,234 tracks");
  });

  it("calls a table the app has no noun for by its name", () => {
    expect(deleteTitle("gig", 2)).toBe("Delete 2 gig");
    expect(deleteTitle("/lastfm/scrobble", 1)).toBe("Delete scrobble");
  });
});

describe("a line of the plan", () => {
  it("says records that must go can't be kept", () => {
    const credits = item(
      "referencing",
      relationship("credit.track", "track", true),
      6,
    );
    expect(itemLabel(credits)).toBe("Delete 6 credits");
    expect(itemNote(credits)).toBe("A credit can’t be kept without its track.");
    expect(
      itemNote(item("referencing", relationship("album.x", "y", true), 1)),
    ).toBe("An album can’t be kept without its x.");
  });

  it("says what keeping records leaves them without", () => {
    const tracks = relationship("track.album", "album");
    expect(itemNote(item("referencing", tracks, 12))).toBe(
      "Otherwise they’re kept, with no album.",
    );
    expect(itemNote(item("referencing", tracks, 1))).toBe(
      "Otherwise it’s kept, with no album.",
    );
    expect(
      itemNote(
        item(
          "referencing",
          relationship("/app/source.source_folder", "/app/source_folder"),
          2,
        ),
      ),
    ).toBe("Otherwise they’re kept, with no source folder.");
  });

  it("says what an orphan is left without", () => {
    const files = item("orphans", relationship("track.file", "file", true), 1);
    expect(itemLabel(files)).toBe("Delete 1 file");
    expect(itemNote(files)).toBe("It would be left with no tracks.");
    expect(
      itemNote(item("orphans", relationship("credit.artist", "artist"), 3)),
    ).toBe("They would be left with no credits.");
  });
});

describe("the notes around the plan", () => {
  it("totals a deletion that goes beyond what was asked for", () => {
    const summary = {
      table: "track",
      items: [],
      blocked: [],
      deletedByTable: {},
    };
    expect(
      totalsNote({ ...summary, found: 2, deleteCount: 2, updateCount: 0 }),
    ).toBeUndefined();
    expect(
      totalsNote({ ...summary, found: 2, deleteCount: 14, updateCount: 0 }),
    ).toBe("In all, 14 records are deleted.");
    expect(
      totalsNote({ ...summary, found: 1, deleteCount: 1, updateCount: 20000 }),
    ).toBe("In all, 1 record is deleted and 20,000 are changed.");
  });

  it("offers to delete the audio of the files the deletion takes", () => {
    const summary = {
      table: "track",
      items: [],
      blocked: [],
      found: 2,
      deleteCount: 6,
      updateCount: 0,
    };
    expect(audioFileCount({ ...summary, deletedByTable: { track: 2 } })).toBe(
      0,
    );
    expect(
      audioFileCount({ ...summary, deletedByTable: { track: 2, file: 2 } }),
    ).toBe(2);
    expect(audioFilesLabel(1)).toBe("Delete the audio file from disk");
    expect(audioFilesLabel(1200)).toBe(
      "Delete the 1,200 audio files from disk",
    );
    expect(audioFilesNote(1)).toBe(
      "Otherwise it stays, and the next scan adds it back.",
    );
    expect(audioFilesNote(2)).toBe(
      "Otherwise they stay, and the next scan adds them back.",
    );
  });

  it("says when records have gone already", () => {
    expect(missingNote("track", 3, 3)).toBeUndefined();
    expect(missingNote("track", 1, 0)).toBe(
      "This track has already been deleted.",
    );
    expect(missingNote("track", 3, 0)).toBe(
      "These tracks have already been deleted.",
    );
    expect(missingNote("track", 3, 2)).toBe(
      "1 of the 3 tracks has already been deleted.",
    );
  });

  it("names the table that stands in the way", () => {
    expect(
      blockedNote({
        relationship: relationship("note.track", "track"),
        count: 2,
      }),
    ).toBe(
      "2 note refer to what’s being deleted, and can be neither deleted nor changed from here: nothing identifies one record of “note”.",
    );
  });
});
