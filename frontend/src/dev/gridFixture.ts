// A small, fixed structured result for the deterministic grid snapshot (§6/§7):
// the five "Lemonade" rows from `whole_app.png`. This is the whole visual
// baseline — a canned fixture for one snapshot, NOT the forbidden large-dataset
// generator. Built through the real `buildResultFromCells` so the seeded grid
// exercises the actual metadata resolution and formatter/prefix/suffix path.

import { defaultColumnMetadata, type ColumnMetadata } from "../query/columns";
import {
  buildResultFromCells,
  type QueryResult,
  type RawColumn,
} from "../query/result";
import type { Formatter } from "../query/format";

function meta(overrides: Partial<ColumnMetadata>): ColumnMetadata {
  return { ...defaultColumnMetadata(), ...overrides };
}

const durationFmt: Formatter = { type: "duration" };
const ratingFmt: Formatter = { type: "number", decimalPlaces: [0, 1] };

/** The canned Lemonade grid result: a hidden id, artist pills, year, album, a
 * `#`-prefixed track number, title, a duration (seconds → M:SS), and a rating
 * (star suffix). Column metadata mirrors the display treatment in
 * `whole_app.png` (widths/fonts/colors/alignment). */
export function lemonadeGridResult(): QueryResult {
  const cols: RawColumn[] = [
    // Hidden id column — dropped from the visible set but still occupies a
    // result-column index (exercises the hide path).
    {
      meta: meta({ hide: true }),
      isList: false,
      raw: ["t1", "t2", "t3", "t4", "t5"],
    },
    {
      meta: meta({ min_width: 130, max_width: 300 }),
      isList: true,
      raw: [
        ["Beyoncé"],
        ["Beyoncé"],
        ["Beyoncé", "Jack White"],
        ["Beyoncé"],
        ["Beyoncé", "The Weeknd"],
      ],
    },
    {
      meta: meta({ min_width: 44, max_width: 50 }),
      isList: false,
      raw: ["2016", "2016", "2016", "2016", "2016"],
    },
    {
      meta: meta({ min_width: 80, max_width: 200 }),
      isList: false,
      raw: ["Lemonade", "Lemonade", "Lemonade", "Lemonade", "Lemonade"],
    },
    {
      meta: meta({
        min_width: 26,
        max_width: 40,
        font_size: "small",
        font_color: "light",
        text_align: "right",
        prefix: "#",
      }),
      isList: false,
      raw: ["1", "2", "3", "4", "5"],
    },
    {
      meta: meta({ min_width: 150, max_width: 420 }),
      isList: false,
      raw: [
        "Pray You Catch Me",
        "Hold Up",
        "Don't Hurt Yourself",
        "Sorry",
        "6 Inch",
      ],
    },
    {
      meta: meta({
        min_width: 40,
        max_width: 50,
        font_size: "small",
        font_color: "light",
        text_align: "right",
        formatter: durationFmt,
      }),
      isList: false,
      raw: ["196", "221", "234", "233", "260"],
    },
    {
      meta: meta({
        min_width: 46,
        max_width: 56,
        text_align: "right",
        suffix: " ☆",
        formatter: ratingFmt,
      }),
      isList: false,
      raw: ["3.5", "4", "4", "4", "4.5"],
    },
  ];
  return buildResultFromCells(5, cols);
}
