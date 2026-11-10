import type { JSX } from "react";
import { Icons } from "../icons";
import { RECORD_NAVIGATIONS } from "../query/recordNavigation";
import type { RecordGroup } from "../stores/app";
import { useAppActions } from "../stores/react";
import { MenuItem } from "./ui/Menu";

/** The menu entries leading on from `groups`' records to the records they
 * lead to — "Show album tracks", "Show artist tracks", "Show artist albums" —
 * each opening those in a new query tab beside `tabId`.
 *
 * Every menu that offers them renders this, a result row's and an embedded
 * record's alike, so the same records are always offered the same ways, in the
 * same order, doing the same thing (`query/recordNavigation.ts` lists them;
 * `navigateRecords` runs them). */
export default function RecordNavigationItems(props: {
  tabId: string;
  groups: readonly RecordGroup[];
}): JSX.Element {
  const { navigateRecords } = useAppActions();
  return (
    <>
      {RECORD_NAVIGATIONS.map((nav) => {
        const group = props.groups.find((g) => g.table === nav.table);
        if (!group || group.records.length === 0) return null;
        return (
          <MenuItem
            key={nav.id}
            icon={Icons.Query}
            label={nav.label}
            onClick={() => navigateRecords(props.tabId, nav.id, group.records)}
          />
        );
      })}
    </>
  );
}
