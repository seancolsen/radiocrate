import type { JSX } from "react";
import { Icons } from "../icons";
import { selectCanRevert, selectIsPersisted } from "../stores/app";
import { useApp, useAppActions } from "../stores/react";
import BaseSubmenu from "./BaseSubmenu";
import { MenuItem, MenuSeparator } from "./ui/Menu";

/** The wrench "query actions" menu body. The Base submenu (which table the query
 * is built on, or full-Querydown mode), then Rename (only for a saved query —
 * an unsaved one is named as it's saved), Duplicate, Revert (only while a save
 * has failed, leaving the working query apart from what the backend holds),
 * View SQL, and Delete (Pin remains deferred). */
export default function PageActionsMenu(props: { tabId: string }): JSX.Element {
  const canRevert = useApp((s) => selectCanRevert(s, props.tabId));
  const persisted = useApp((s) => selectIsPersisted(s, props.tabId));
  const {
    beginRename,
    duplicateQuery,
    revertLive,
    openViewSql,
    requestDelete,
  } = useAppActions();
  return (
    <>
      <BaseSubmenu tabId={props.tabId} />
      <MenuSeparator />
      {persisted && (
        <MenuItem
          icon={Icons.Rename}
          label="Rename"
          onClick={() => beginRename(props.tabId)}
        />
      )}
      <MenuItem
        icon={Icons.Duplicate}
        label="Duplicate"
        onClick={() => duplicateQuery(props.tabId)}
      />
      {canRevert && (
        <MenuItem
          icon={Icons.Revert}
          label="Revert changes"
          onClick={() => revertLive(props.tabId)}
        />
      )}
      <MenuItem
        icon={Icons.ViewSql}
        label="View SQL"
        onClick={() => openViewSql(props.tabId)}
      />
      <MenuSeparator />
      <MenuItem
        icon={Icons.Delete}
        label="Delete"
        danger
        onClick={() => requestDelete(props.tabId)}
      />
    </>
  );
}
