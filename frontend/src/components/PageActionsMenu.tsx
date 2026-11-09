import type { JSX } from "react";
import { Icons } from "../icons";
import {
  selectCanConvertToPlaylist,
  selectCanRevert,
  selectTab,
} from "../stores/app";
import { useApp, useAppActions } from "../stores/react";
import BaseSubmenu from "./BaseSubmenu";
import SourceOptions from "./SourceOptions";
import { MenuItem, MenuSeparator } from "./ui/Menu";

/** The wrench "query actions" menu body. The Base submenu (which table the query
 * is built on, or full-Querydown mode), then Revert (only while a save has
 * failed, leaving the working query apart from what the backend holds),
 * Convert to playlist (only while the rows on screen are the query's tracks),
 * View SQL and Export results data — and, set apart at the end, the options
 * every query's menus share (Rename, Duplicate, Delete: see
 * {@link SourceOptions}). Rename edits the name in the tab handle.
 *
 * A playlist's menu leaves out everything that's only a query's (the Base
 * submenu, Revert, Convert), and offers View SQL and Export results data, then
 * the same shared options. */
export default function PageActionsMenu(props: { tabId: string }): JSX.Element {
  const playlist = useApp(
    (s) => selectTab(s, props.tabId)?.kind === "playlist",
  );
  const { beginRename } = useAppActions();
  return (
    <>
      {playlist ? (
        <PlaylistActions tabId={props.tabId} />
      ) : (
        <QueryActions tabId={props.tabId} />
      )}
      <MenuSeparator />
      <SourceOptions
        id={props.tabId}
        onRename={() => beginRename(props.tabId)}
      />
    </>
  );
}

/** The rows only a playlist's wrench menu has. */
function PlaylistActions(props: { tabId: string }): JSX.Element {
  const { openViewSql, openExportData } = useAppActions();
  return (
    <>
      <MenuItem
        icon={Icons.ViewSql}
        label="View SQL"
        onClick={() => openViewSql(props.tabId)}
      />
      <MenuItem
        icon={Icons.Export}
        label="Export results data"
        onClick={() => openExportData(props.tabId)}
      />
    </>
  );
}

/** The rows only a query's wrench menu has. */
function QueryActions(props: { tabId: string }): JSX.Element {
  const canRevert = useApp((s) => selectCanRevert(s, props.tabId));
  const canConvert = useApp((s) => selectCanConvertToPlaylist(s, props.tabId));
  const { convertToPlaylist, revertLive, openViewSql, openExportData } =
    useAppActions();
  return (
    <>
      <BaseSubmenu tabId={props.tabId} />
      <MenuSeparator />
      {canRevert && (
        <MenuItem
          icon={Icons.Revert}
          label="Revert changes"
          onClick={() => revertLive(props.tabId)}
        />
      )}
      {canConvert && (
        <MenuItem
          icon={Icons.Playlist}
          label="Convert to playlist"
          command="query.convert_to_playlist"
          onClick={() => convertToPlaylist(props.tabId)}
        />
      )}
      <MenuItem
        icon={Icons.ViewSql}
        label="View SQL"
        onClick={() => openViewSql(props.tabId)}
      />
      <MenuItem
        icon={Icons.Export}
        label="Export results data"
        onClick={() => openExportData(props.tabId)}
      />
    </>
  );
}
