// Semantic icon vocabulary.
//
// Call sites name a UI *concept* (`Query`, `Close`, `Refresh`, …) and never a
// raw glyph, so an icon choice is made once here and reused everywhere.
//
// Each `~icons/*` import is compiled at build time by unplugin-icons
// (`compiler: "jsx", jsx: "react"` in `vite.config.ts`, through SVGR) into a
// React component rendering the glyph as an inline `<svg viewBox="…"
// width="1.2em" height="1.2em">` filled with `currentColor`. The caller's props
// (`className`, `aria-label`, …) spread onto that `<svg>`.

import type { ComponentType, SVGProps } from "react";

import { cx } from "./components/ui/cx";

import Query from "~icons/material-symbols/manage-search";
import Playlist from "~icons/material-symbols/queue-music";
import Folder from "~icons/material-symbols/folder";
import FolderOpen from "~icons/material-symbols/folder-open";
import NewFolder from "~icons/material-symbols/create-new-folder";
import ExplorerOpen from "~icons/material-symbols/left-panel-open";
import ExplorerClose from "~icons/material-symbols/left-panel-close";
import Close from "~icons/material-symbols/close";
import Add from "~icons/material-symbols/add";
import Refresh from "~icons/material-symbols/refresh";
import Hide from "~icons/material-symbols/visibility-off";
import Show from "~icons/material-symbols/visibility";
import ExpandOpen from "~icons/material-symbols/expand-more";
import ExpandClosed from "~icons/material-symbols/chevron-right";
import PagePrevious from "~icons/material-symbols/chevron-left";
import Settings from "~icons/material-symbols/settings";
import Save from "~icons/material-symbols/save";
import Build from "~icons/material-symbols/build";
import Search from "~icons/material-symbols/search";
import Filter from "~icons/material-symbols/filter-alt";
import Sort from "~icons/material-symbols/swap-vert";
import Display from "~icons/material-symbols/key-visualizer";
import More from "~icons/material-symbols/more-vert";
import Custom from "~icons/material-symbols/auto-fix-high";
import Merge from "~icons/material-symbols/merge";
import Unsaved from "~icons/material-symbols/emergency";
import QueryError from "~icons/material-symbols/error-outline";
// One glyph, two concepts: `Revert` and `Undo` share the same icon.
import Revert from "~icons/material-symbols/undo";
import Undo from "~icons/material-symbols/undo";
import Redo from "~icons/material-symbols/redo";
import Clear from "~icons/material-symbols/backspace";
import Shuffle from "~icons/material-symbols/shuffle";
import Delete from "~icons/material-symbols/delete";
import Check from "~icons/material-symbols/check";
import ViewSql from "~icons/material-symbols/manufacturing";
import Export from "~icons/material-symbols/file-export";
// One glyph, two concepts: `Copy` and `Duplicate` share the same icon.
import Copy from "~icons/material-symbols/content-copy";
import Download from "~icons/material-symbols/download";
import CheckAll from "~icons/material-symbols/check-small";
import UncheckAll from "~icons/material-symbols/close-small";
import Base from "~icons/material-symbols/psychiatry";
import Table from "~icons/material-symbols/table";
import Querydown from "~icons/material-symbols/code";
import BasicText from "~icons/material-symbols/abc";
// One glyph, two concepts: `Rename` and `Edit` share the same icon.
import Rename from "~icons/material-symbols/edit";
import Edit from "~icons/material-symbols/edit";
import Duplicate from "~icons/material-symbols/content-copy";
import SelectMultiple from "~icons/material-symbols/select-check-box";
import SelectNone from "~icons/material-symbols/check-box-outline-blank";
import SelectSome from "~icons/material-symbols/indeterminate-check-box";
import SelectAll from "~icons/material-symbols/check-box";
import SelectRange from "~icons/material-symbols/height";
import Rate from "~icons/material-symbols/star";
import Album from "~icons/material-symbols/album";
import Artists from "~icons/material-symbols/group";
import Artist from "~icons/material-symbols/person";
import OpenInTab from "~icons/material-symbols/open-in-new";
import Play from "~icons/material-symbols/play-arrow";
import Pause from "~icons/material-symbols/pause";
import Next from "~icons/material-symbols/skip-next";
import Locate from "~icons/material-symbols/my-location";
import QueueNext from "~icons/material-symbols/queue-play-next";
import QueueLast from "~icons/material-symbols/add-to-queue";
import Unqueue from "~icons/material-symbols/remove-from-queue";
import ClearQueue from "~icons/material-symbols/clear-all";
import Keyboard from "~icons/material-symbols/keyboard-alt";
import Commands from "~icons/material-symbols/terminal";
import Presets from "~icons/material-symbols/tune";
import Structure from "~icons/material-symbols/architecture";
import Tables from "~icons/material-symbols/database-outline";
import Fields from "~icons/material-symbols/list-alt-outline";
import About from "~icons/material-symbols/info";
import Help from "~icons/material-symbols/help-outline";
import Log from "~icons/material-symbols/receipt-long";
import StartLogging from "~icons/material-symbols/radio-button-checked";
import StopLogging from "~icons/material-symbols/stop-circle";
import PaintRoller from "~icons/material-symbols/imagesearch-roller";
import Replace from "~icons/material-symbols/find-replace";
import MatchCase from "~icons/material-symbols/match-case";
import MatchWord from "~icons/material-symbols/match-word";
import RegularExpression from "~icons/material-symbols/regular-expression";
// The record editor's field-label glyphs, one per value category.
import FieldText from "~icons/material-symbols/notes";
import FieldNumber from "~icons/material-symbols/tag";
import FieldId from "~icons/material-symbols/fingerprint";
import FieldLink from "~icons/material-symbols/link";
import FieldRecords from "~icons/material-symbols/table";
import FieldTime from "~icons/material-symbols/schedule";
import FieldBoolean from "~icons/material-symbols/check-box";
import FieldOther from "~icons/material-symbols/data-object";
import FieldQuery from "~icons/material-symbols/saved-search";
import FieldComputed from "~icons/material-symbols/function";
import LightMode from "~icons/material-symbols/light-mode";
import DarkMode from "~icons/material-symbols/dark-mode";
import SystemTheme from "~icons/material-symbols/settings-brightness";
import HigherQuality from "~icons/material-symbols/high-quality";
import LowerBandwidth from "~icons/material-symbols/data-saver-on";
import AudioFile from "~icons/material-symbols/audio-file";
import ProgressActivity from "~icons/material-symbols/progress-activity";
import TextSearch from "~icons/material-symbols/find-in-page";
import LinkedComparison from "~icons/material-symbols/compare-arrows";
import RecordPicker from "~icons/material-symbols/ads-click";
import CustomComparisons from "~icons/material-symbols/rule";
import CustomComparison from "~icons/material-symbols/equal";

/** What every icon in {@link Icons} is: a component taking ordinary SVG props
 * (`className` chief among them — every call site sizes and colors an icon
 * that way) and rendering the glyph. */
export type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

/** The one icon that isn't a bare glyph: the busy indicator carries its own
 * rotation, so a surface that only gets to *name* an icon — a menu row swapping
 * its leading icon while its action runs — gets a spinning one. */
const Spinner: IconComponent = ({ className, ...props }) => (
  <ProgressActivity className={cx("animate-spin", className)} {...props} />
);

/** Querydown's logo (`branding/logo-optimized.svg` in the Querydown repo, as
 * its site's `icon.svg` draws it too): a magnifier and a down arrow in a
 * rounded frame, in `currentColor` with the frame's white fill left out. Wider
 * than tall, it's centered in the same 1.2em square as every other glyph. */
const QuerydownLogo: IconComponent = (props) => (
  <svg
    viewBox="0 0 210 130"
    width="1.2em"
    height="1.2em"
    fill="currentColor"
    {...props}
  >
    <path d="m64.9 31.01c-8.722 0-17.44 3.299-24.04 9.896-13.19 13.19-13.19 34.89 0 48.08 10.3 10.3 25.76 12.56 38.33 6.785l12.66 13.87 14.78-13.48-12.56-13.77c7.76-13.04 6.054-30.32-5.123-41.49-6.597-6.597-15.32-9.896-24.04-9.896zm0 19.88c3.562 0 7.125 1.389 9.9 4.164 5.551 5.551 5.551 14.25 0 19.8-5.551 5.551-14.25 5.551-19.8 0-5.551-5.551-5.551-14.25 0-19.8 2.775-2.775 6.336-4.164 9.898-4.164zm85.7 48.11-30-33h20v-35h20v35h20zm-134.6-88c-2.761 0-5 2.239-5 5v98c0 2.761 2.239 5 5 5h178c2.761 0 5-2.239 5-5v-98c0-2.761-2.239-5-5-5zm-15 5c0-8.284 6.716-15 15-15h178c8.284 0 15 6.716 15 15v98c0 8.284-6.716 15-15 15h-178c-8.284 0-15-6.716-15-15z" />
  </svg>
);

export const Icons = {
  Query, // query rows + tab handle icon
  Playlist, // playlist rows + tab handle icon
  Folder, // a collapsed explorer folder
  FolderOpen, // an expanded explorer folder
  NewFolder, // Sources "+" menu: new folder
  ExplorerOpen, // sidebar toggle when closed
  ExplorerClose, // sidebar toggle when open
  Close, // tab close ×, opened-row ×
  Add, // "+": add a new item
  Refresh, // Sources-section reload + toolbar run
  Hide, // record editor: hide a field, or hide the hidden fields again
  Show, // record editor: un-hide a field, or show the hidden fields
  ExpandOpen, // expanded section chevron
  ExpandClosed, // collapsed section chevron
  PagePrevious, // a pager: the page before
  PageNext: ExpandClosed, // a pager: the page after
  Back: PagePrevious, // record editor: go back to the record edited before
  Record: Table, // record editor: records in hand, being dragged
  Settings, // static Settings footer
  Save, // toolbar save (shown while unsaved, or after a failed save)
  Undo, // toolbar undo (step the query back)
  Redo, // toolbar redo (step it forward again)
  Build, // wrench: query-actions menu trigger
  Search, // Sources search toggle
  Filter, // Filter section toggle
  Sort, // Sort section toggle
  Display, // Display section toggle
  More, // ⋮ menu trigger (split button + custom input)
  Custom, // "Custom …" options-menu entry
  Merge, // "Inline into custom": a preset folded into the custom Querydown
  Unsaved, // red ✱ dirty-preset marker
  QueryError, // a problem with a query (the error strip)
  Revert, // undo: revert changes / revert preset edit
  Clear, // clear custom input
  Shuffle, // Shuffle built-in preset
  Delete, // delete or remove: sources, folders, records, a playlist's tracks
  Check, // a playlist's "Keep only these tracks" and "Commit this track order"
  ViewSql, // View SQL menu entry
  Export, // "Export results data" menu entry
  Copy, // export dialog: "Copy to clipboard"
  Download, // export dialog: "Download CSV"
  CheckAll, // export dialog: "Check all" columns
  UncheckAll, // export dialog: "Uncheck all" columns
  Base, // Change-base menu entry
  Table, // a table row in the base submenu
  Querydown, // full-querydown mode: its Base-submenu entry and toolbar toggle
  QuerydownFilter: QuerydownLogo, // a filter read as Querydown (its strategy toggle)
  BasicTextFilter: BasicText, // a filter read as basic text (its strategy toggle)
  Rename, // rename query (wrench menu + double-click)
  Edit, // edit a record (results context menu, record editor title)
  Duplicate, // duplicate query (wrench menu)
  SelectMultiple, // results row menu: enter multi-select mode
  SelectNone, // multi-select toolbar: no rows selected ("Select all")
  SelectSome, // multi-select toolbar: some rows selected ("Select all")
  SelectAll, // multi-select toolbar: every row selected ("Clear selection")
  SelectRange, // multi-select toolbar: the range-mode toggle
  Rate, // results row menu: the "Rate track" submenu
  Album, // results row menu: a track's "Album" submenu
  Artists, // results row menu: the "Artists" submenu (credited artists)
  Artist, // results row menu: one artist in the "Artists" submenu
  OpenInTab, // record editor: open a multi-record field's records as a query tab
  Play, // now-playing bar: resume
  Pause, // now-playing bar: pause
  Next, // now-playing menu: skip to the next queued track
  Locate, // now-playing menu: jump to the playing track's row
  QueueNext, // results row menu: queue tracks ahead of the queue
  QueueLast, // results row menu: queue tracks after the queue
  Unqueue, // results row menu: take tracks out of the queue
  ClearQueue, // now-playing menu: empty the queue
  Keyboard, // shortcuts editor: "Record keys" search toggle
  Commands, // the explorer footer's way into the command palette
  Presets, // "Manage presets", on a builder section's menu
  Structure, // the Data structure page: its Settings-menu entry and tab handle
  Tables, // the Data structure page: the list of the database's tables
  Fields, // the Data structure page: a table's fields
  TextSearch, // the Data structure page: a table's text search
  LinkedComparison, // the Data structure page: a table's linked record comparison
  RecordPicker, // the Data structure page: a table's record picker
  CustomComparisons, // the Data structure page: a table's custom comparisons
  CustomComparison, // the Data structure page: one custom comparison
  About, // Settings footer: "About RadioCrate" (versions + update actions)
  Help, // a "?" help: a tooltip (the prelude's editor) or a popover (the log)
  Log, // the Logging page: its Settings-menu entry and tab handle
  StartLogging, // Logging page toolbar: "Start logging"
  StopLogging, // Logging page toolbar: "Stop logging"
  PaintRoller, // record editor: take one distinct value for every record
  Find: Search, // record editor: a text field's find-and-replace toggle
  Replace, // record editor: find and replace's "Replace" button
  MatchCase, // find and replace: the "Match case" toggle
  MatchWord, // find and replace: the "Match whole word" toggle
  RegularExpression, // find and replace: the "Use regular expression" toggle
  FieldText, // record editor: a text field's label
  FieldNumber, // record editor: a numeric field's label
  FieldId, // record editor: a UUID field's label
  FieldLink, // record editor: a scalar linked record field's label
  FieldRecords, // record editor: a multi-record field's label
  FieldTime, // record editor: a date/time field's label
  FieldBoolean, // record editor: a boolean field's label
  FieldOther, // record editor: a field of any other type
  FieldQuery, // record editor: a contextual query's field
  FieldComputed, // record editor: a computed column's field
  LightMode, // Settings footer: Light theme option
  DarkMode, // Settings footer: Dark theme option
  SystemTheme, // Settings footer: System theme option
  HigherQuality, // Settings footer: Higher quality streaming option
  LowerBandwidth, // Settings footer: Lower bandwidth streaming option
  AudioFile, // Settings footer: "Re-scan collection"
  Spinner, // an action in flight (the re-scan, while it runs)
} satisfies Record<string, IconComponent>;
