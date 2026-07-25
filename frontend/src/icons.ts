// Semantic icon vocabulary.
//
// Mirrors `frontend-old-egui/src/icons.rs`: call sites name a UI *concept*
// (`Query`, `Close`, `Refresh`, …) and never a raw glyph, so an icon choice is
// made once here and reused everywhere. Each import is a build-time-inlined
// Solid SVG component (via unplugin-icons) that fills with `currentColor`, so
// the theme tokens style it and size comes from a `size-*` utility / font size.
//
// In Iconify's `material-symbols` set the base name is the *filled* variant
// (matching egui's filled Material Symbols); `-outline` would be the unfilled one.

import Query from "~icons/material-symbols/manage-search";
import ExplorerOpen from "~icons/material-symbols/left-panel-open";
import ExplorerClose from "~icons/material-symbols/left-panel-close";
import Close from "~icons/material-symbols/close";
import Add from "~icons/material-symbols/add";
import Refresh from "~icons/material-symbols/refresh";
import ExpandOpen from "~icons/material-symbols/expand-more";
import ExpandClosed from "~icons/material-symbols/chevron-right";
import Settings from "~icons/material-symbols/settings";
import Save from "~icons/material-symbols/save";
import Build from "~icons/material-symbols/build";
import Filter from "~icons/material-symbols/filter-alt";
import Sort from "~icons/material-symbols/swap-vert";
import Display from "~icons/material-symbols/key-visualizer";
import More from "~icons/material-symbols/more-vert";
import Custom from "~icons/material-symbols/auto-fix-high";
import Preset from "~icons/material-symbols/link";
import Unsaved from "~icons/material-symbols/emergency";
import Revert from "~icons/material-symbols/undo";
import Clear from "~icons/material-symbols/backspace";
import Shuffle from "~icons/material-symbols/shuffle";
import Delete from "~icons/material-symbols/delete";
import ViewSql from "~icons/material-symbols/manufacturing";
import Base from "~icons/material-symbols/psychiatry";
import Table from "~icons/material-symbols/table";
// One glyph, two concepts — as in `icons.rs`, where `RENAME` and `EDIT` are both
// `ICON_EDIT`.
import Rename from "~icons/material-symbols/edit";
import Edit from "~icons/material-symbols/edit";
import Duplicate from "~icons/material-symbols/content-copy";
import Play from "~icons/material-symbols/play-arrow";
import Pause from "~icons/material-symbols/pause";
import Next from "~icons/material-symbols/skip-next";
import Locate from "~icons/material-symbols/my-location";
import Keyboard from "~icons/material-symbols/keyboard-alt";

export const Icons = {
  Query, // query rows + tab handle icon
  ExplorerOpen, // sidebar toggle when closed
  ExplorerClose, // sidebar toggle when open
  Close, // tab close ×, opened-row ×
  Add, // new-tab (+)
  Refresh, // Queries-section reload + toolbar run
  ExpandOpen, // expanded section chevron
  ExpandClosed, // collapsed section chevron
  Settings, // static Settings footer
  Save, // toolbar save (shown while unsaved)
  Build, // wrench: query-actions menu trigger
  Filter, // Filter section toggle
  Sort, // Sort section toggle
  Display, // Display section toggle
  More, // ⋮ menu trigger (split button + custom input)
  Custom, // "Custom …" options-menu entry
  Preset, // preset tab / options-menu preset rows
  Unsaved, // red ✱ dirty-preset marker
  Revert, // undo: revert changes / revert preset edit
  Clear, // clear custom input
  Shuffle, // Shuffle built-in preset
  Delete, // delete (stubbed this session)
  ViewSql, // View SQL menu entry
  Base, // Change-base menu entry
  Table, // a table row in the base submenu
  Rename, // rename query (wrench menu + double-click)
  Edit, // edit a record (results context menu, record editor title)
  Duplicate, // duplicate query (wrench menu)
  Play, // now-playing bar: resume
  Pause, // now-playing bar: pause
  Next, // now-playing menu: skip to the next queued track
  Locate, // now-playing menu: jump to the playing track's row
  Keyboard, // shortcuts editor: "Record keys" search toggle
};
