import { Icons, type IconComponent } from "../icons";
import type { TabKind } from "../stores/app";

/** The icon a tab's kind carries wherever tabs are listed — the tab bar's handles
 * and the explorer's "Opened" rows — so one page kind reads the same in both. */
export function tabIcon(kind: TabKind): IconComponent {
  switch (kind) {
    case "query":
      return Icons.Query;
    case "shortcuts":
      return Icons.Keyboard;
  }
}
