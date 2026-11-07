import { describe, expect, it } from "vitest";
import { columnMetadataFromAnnotation } from "./columns";
import { embedPreview, embedText, visibleCells } from "./embedPreview";

const HIDDEN = columnMetadataFromAnnotation({ hide: "yes" });
const PLAIN = columnMetadataFromAnnotation(null);

describe("embedPreview", () => {
  it("keeps cells with a column left to show", () => {
    expect(embedPreview(["a", "b"], [HIDDEN, PLAIN], ["key"])).toEqual({
      cells: ["a", "b"],
      columns: [HIDDEN, PLAIN],
    });
  });

  it("lets the key stand in for columns that are all hidden", () => {
    expect(embedPreview(["a"], [HIDDEN], ["key"])).toEqual({ cells: ["key"] });
  });

  it("lets the key stand in for no cells at all", () => {
    expect(embedPreview([], [], ["key"])).toEqual({ cells: ["key"] });
  });
});

describe("visibleCells", () => {
  it("skips hidden columns, and each keeps its own position", () => {
    const shown = visibleCells({
      cells: ["a", "b"],
      columns: [HIDDEN, PLAIN],
    });
    expect(shown).toEqual([{ index: 1, value: "b", meta: PLAIN }]);
  });

  it("gives a column nothing annotated the defaults", () => {
    const shown = visibleCells({ cells: ["a"] });
    expect(shown[0]?.meta).toEqual(PLAIN);
  });
});

describe("embedText", () => {
  it("reads as the widget does: formatted, without what's hidden", () => {
    expect(
      embedText({
        cells: ["id", "3.14159", "lead", null],
        columns: [
          HIDDEN,
          columnMetadataFromAnnotation({
            formatter: { type: "number", decimalPlaces: 1 },
          }),
          columnMetadataFromAnnotation({ prefix: "as " }),
          PLAIN,
        ],
      }),
    ).toBe("3.1 as lead");
  });
});
