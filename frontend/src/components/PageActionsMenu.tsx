import type { JSX } from "react";
import { Icons } from "../icons";
import { selectCanRevert, selectIsPersisted, selectTab } from "../stores/app";
import { useApp, useAppActions } from "../stores/react";
import BaseSubmenu from "./BaseSubmenu";
import { MenuItem, MenuSeparator } from "./ui/Menu";

/** The wrench "query actions" menu body. The Base submenu (which table the query
 * is built on, or full-Querydown mode), then Rename (only for a saved query —
 * an unsaved one is named as it's saved), Duplicate, Revert (only while a save
 * has failed, leaving the working query apart from what the backend holds),
 * View SQL, and Delete (Pin remains deferred).
 *
 * A playlist's menu leaves out everything that's only a query's (the Base
 * submenu, Revert), and offers Rename and View SQL. */
export default function PageActionsMenu(props: { tabId: string }): JSX.Element {
  const playlist = useApp(
    (s) => selectTab(s, props.tabId)?.kind === "playlist",
  );
  return playlist ? (
    <PlaylistActions tabId={props.tabId} />
  ) : (
    <QueryActions tabId={props.tabId} />
  );
}

/** A playlist's wrench menu body. */
function PlaylistActions(props: { tabId: string }): JSX.Element {
  const { beginRename, openViewSql } = useAppActions();
  return (
    <>
      <MenuItem
        icon={Icons.Rename}
        label="Rename"
        onClick={() => beginRename(props.tabId)}
      />
      <MenuItem
        icon={Icons.ViewSql}
        label="View SQL"
        onClick={() => openViewSql(props.tabId)}
      />
    </>
  );
}

/** A query's wrench menu body. */
function QueryActions(props: { tabId: string }): JSX.Element {
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
