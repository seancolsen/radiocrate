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

export const Icons = {
  Query, // query rows + tab handle icon
  ExplorerOpen, // sidebar toggle when closed
  ExplorerClose, // sidebar toggle when open
  Close, // tab close ×, opened-row ×
  Add, // new-tab (+)
  Refresh, // Queries-section reload
  ExpandOpen, // expanded section chevron
  ExpandClosed, // collapsed section chevron
  Settings, // static Settings footer
};
