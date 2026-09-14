import type { JSX } from "react";
import { Icons } from "../icons";
import { selectCanRevert } from "../stores/app";
import { useApp, useAppActions } from "../stores/react";
import BaseSubmenu from "./BaseSubmenu";
import { MenuItem, MenuSeparator } from "./ui/Menu";

/** The wrench "query actions" menu body. The Base submenu (which table the query
 * is built on, or full-Querydown mode), then Rename, Duplicate, Revert (only
 * while the working query differs from its saved form), View SQL, and Delete
 * (Pin remains deferred). */
export default function PageActionsMenu(props: { tabId: string }): JSX.Element {
  const canRevert = useApp((s) => selectCanRevert(s, props.tabId));
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
      <MenuItem
        icon={Icons.Rename}
        label="Rename"
        onClick={() => beginRename(props.tabId)}
      />
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
