// Semantic icon vocabulary — the React counterpart of `../icons.ts`.
//
// Call sites name a UI *concept* (`Query`, `Close`, `Refresh`, …) and never a
// raw glyph, so an icon choice is made once here and reused everywhere.
//
// unplugin-icons' `compiler` option is global to the plugin (stage 0's icon
// spike), and the Solid tree already claims `"solid"`. Rather than a second
// plugin instance, each icon here is imported with `?raw` — the same markup
// unplugin-icons would compile a component around — and wrapped in a plain
// `<svg>` carrying the same attributes (`viewBox`, `width="1.2em"`,
// `height="1.2em"`) and inner markup, so the pixels match exactly. At cutover
// (stage 10), switch the plugin to `compiler: "jsx", jsx: "react"` and this
// file can import the generated components directly instead.

import type { JSX, SVGProps } from "react";

import Query from "~icons/material-symbols/manage-search?raw";
import ExplorerOpen from "~icons/material-symbols/left-panel-open?raw";
import ExplorerClose from "~icons/material-symbols/left-panel-close?raw";
import Close from "~icons/material-symbols/close?raw";
import Add from "~icons/material-symbols/add?raw";
import Refresh from "~icons/material-symbols/refresh?raw";
import ExpandOpen from "~icons/material-symbols/expand-more?raw";
import ExpandClosed from "~icons/material-symbols/chevron-right?raw";
import Settings from "~icons/material-symbols/settings?raw";
import Save from "~icons/material-symbols/save?raw";
import Build from "~icons/material-symbols/build?raw";
import Filter from "~icons/material-symbols/filter-alt?raw";
import Sort from "~icons/material-symbols/swap-vert?raw";
import Display from "~icons/material-symbols/key-visualizer?raw";
import More from "~icons/material-symbols/more-vert?raw";
import Custom from "~icons/material-symbols/auto-fix-high?raw";
import Preset from "~icons/material-symbols/link?raw";
import Unsaved from "~icons/material-symbols/emergency?raw";
import Revert from "~icons/material-symbols/undo?raw";
import Clear from "~icons/material-symbols/backspace?raw";
import Shuffle from "~icons/material-symbols/shuffle?raw";
import Delete from "~icons/material-symbols/delete?raw";
import ViewSql from "~icons/material-symbols/manufacturing?raw";
import Base from "~icons/material-symbols/psychiatry?raw";
import Table from "~icons/material-symbols/table?raw";
import Querydown from "~icons/material-symbols/code?raw";
// One glyph, two concepts: `Rename` and `Edit` share the same icon.
import Rename from "~icons/material-symbols/edit?raw";
import Edit from "~icons/material-symbols/edit?raw";
import Duplicate from "~icons/material-symbols/content-copy?raw";
import Play from "~icons/material-symbols/play-arrow?raw";
import Pause from "~icons/material-symbols/pause?raw";
import Next from "~icons/material-symbols/skip-next?raw";
import Locate from "~icons/material-symbols/my-location?raw";
import Keyboard from "~icons/material-symbols/keyboard-alt?raw";
import About from "~icons/material-symbols/info?raw";
// The record editor's field-label glyphs, one per value category.
import FieldText from "~icons/material-symbols/notes?raw";
import FieldNumber from "~icons/material-symbols/tag?raw";
import FieldId from "~icons/material-symbols/fingerprint?raw";
import FieldLink from "~icons/material-symbols/link?raw";
import FieldRecords from "~icons/material-symbols/table?raw";
import FieldTime from "~icons/material-symbols/schedule?raw";
import FieldBoolean from "~icons/material-symbols/check-box?raw";
import FieldOther from "~icons/material-symbols/data-object?raw";
import LightMode from "~icons/material-symbols/light-mode?raw";
import DarkMode from "~icons/material-symbols/dark-mode?raw";
import SystemTheme from "~icons/material-symbols/settings-brightness?raw";
import HigherQuality from "~icons/material-symbols/high-quality?raw";
import LowerBandwidth from "~icons/material-symbols/data-saver-on?raw";

/** What every icon in {@link Icons} is: a component taking ordinary SVG props
 * (`className` chief among them — every call site sizes and colors an icon
 * that way) and rendering the glyph. */
export type IconComponent = (props: SVGProps<SVGSVGElement>) => JSX.Element;

/** Wraps one `?raw`-imported icon's markup in a component. `raw` is always a
 * single self-closing-content `<svg …>…</svg>` string emitted by
 * unplugin-icons, so pulling `viewBox` and the inner markup back out and
 * re-attaching them to a real `<svg>` reproduces exactly what the Solid
 * compiler would have rendered — the wrapper's own props (`className`,
 * `aria-label`, …) spread last so a call site can override `viewBox` or size
 * if it ever needs to. */
function svgIcon(raw: string): IconComponent {
  const viewBox = /\bviewBox="([^"]*)"/.exec(raw)?.[1] ?? "0 0 24 24";
  const inner = /<svg\b[^>]*>([\s\S]*)<\/svg>/.exec(raw)?.[1] ?? "";
  return function Icon(props: SVGProps<SVGSVGElement>): JSX.Element {
    return (
      <svg
        viewBox={viewBox}
        width="1.2em"
        height="1.2em"
        {...props}
        dangerouslySetInnerHTML={{ __html: inner }}
      />
    );
  };
}

export const Icons = {
  Query: svgIcon(Query), // query rows + tab handle icon
  ExplorerOpen: svgIcon(ExplorerOpen), // sidebar toggle when closed
  ExplorerClose: svgIcon(ExplorerClose), // sidebar toggle when open
  Close: svgIcon(Close), // tab close ×, opened-row ×
  Add: svgIcon(Add), // new-tab (+)
  Refresh: svgIcon(Refresh), // Queries-section reload + toolbar run
  ExpandOpen: svgIcon(ExpandOpen), // expanded section chevron
  ExpandClosed: svgIcon(ExpandClosed), // collapsed section chevron
  Settings: svgIcon(Settings), // static Settings footer
  Save: svgIcon(Save), // toolbar save (shown while unsaved)
  Build: svgIcon(Build), // wrench: query-actions menu trigger
  Filter: svgIcon(Filter), // Filter section toggle
  Sort: svgIcon(Sort), // Sort section toggle
  Display: svgIcon(Display), // Display section toggle
  More: svgIcon(More), // ⋮ menu trigger (split button + custom input)
  Custom: svgIcon(Custom), // "Custom …" options-menu entry
  Preset: svgIcon(Preset), // preset tab / options-menu preset rows
  Unsaved: svgIcon(Unsaved), // red ✱ dirty-preset marker
  Revert: svgIcon(Revert), // undo: revert changes / revert preset edit
  Clear: svgIcon(Clear), // clear custom input
  Shuffle: svgIcon(Shuffle), // Shuffle built-in preset
  Delete: svgIcon(Delete), // delete (stubbed this session)
  ViewSql: svgIcon(ViewSql), // View SQL menu entry
  Base: svgIcon(Base), // Change-base menu entry
  Table: svgIcon(Table), // a table row in the base submenu
  Querydown: svgIcon(Querydown), // full-querydown mode: its Base-submenu entry and toolbar toggle
  Rename: svgIcon(Rename), // rename query (wrench menu + double-click)
  Edit: svgIcon(Edit), // edit a record (results context menu, record editor title)
  Duplicate: svgIcon(Duplicate), // duplicate query (wrench menu)
  Play: svgIcon(Play), // now-playing bar: resume
  Pause: svgIcon(Pause), // now-playing bar: pause
  Next: svgIcon(Next), // now-playing menu: skip to the next queued track
  Locate: svgIcon(Locate), // now-playing menu: jump to the playing track's row
  Keyboard: svgIcon(Keyboard), // shortcuts editor: "Record keys" search toggle
  About: svgIcon(About), // Settings footer: "About RadioCrate" (versions + update actions)
  FieldText: svgIcon(FieldText), // record editor: a text field's label
  FieldNumber: svgIcon(FieldNumber), // record editor: a numeric field's label
  FieldId: svgIcon(FieldId), // record editor: a UUID field's label
  FieldLink: svgIcon(FieldLink), // record editor: a scalar linked record field's label
  FieldRecords: svgIcon(FieldRecords), // record editor: a multi-record field's label
  FieldTime: svgIcon(FieldTime), // record editor: a date/time field's label
  FieldBoolean: svgIcon(FieldBoolean), // record editor: a boolean field's label
  FieldOther: svgIcon(FieldOther), // record editor: a field of any other type
  LightMode: svgIcon(LightMode), // Settings footer: Light theme option
  DarkMode: svgIcon(DarkMode), // Settings footer: Dark theme option
  SystemTheme: svgIcon(SystemTheme), // Settings footer: System theme option
  HigherQuality: svgIcon(HigherQuality), // Settings footer: Higher quality streaming option
  LowerBandwidth: svgIcon(LowerBandwidth), // Settings footer: Lower bandwidth streaming option
};
