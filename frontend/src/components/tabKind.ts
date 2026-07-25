import type { Component } from "solid-js";
import { Icons } from "../icons";
import type { TabKind } from "../state/store";

/** The icon a tab's kind carries wherever tabs are listed — the tab bar's handles
 * and the explorer's "Opened" rows — so one page kind reads the same in both. */
export function tabIcon(kind: TabKind): Component<{ class?: string }> {
  switch (kind) {
    case "query":
      return Icons.Query;
    case "shortcuts":
      return Icons.Keyboard;
  }
}
