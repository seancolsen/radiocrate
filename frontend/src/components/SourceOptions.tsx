import type { JSX } from "react";
import { Icons } from "../icons";
import { selectTab } from "../stores/app";
import { useApp, useAppActions } from "../stores/react";
import { MenuItem } from "./ui/Menu";

/** What every query or playlist offers wherever its menu is raised — the
 * wrench menu on its page, its row in the explorer's Sources, its row under
 * "Opened", and its tab handle — so that the same three rows, in the same
 * order, are there in every one: Rename, Duplicate and Delete.
 *
 * `id` is the query's or playlist's (a tab's id is its source's), open or only
 * listed, saved or not. Duplicating a query opens an unsaved copy; duplicating
 * a playlist saves one. Delete asks first.
 *
 * Rename is the one that differs: the name is edited in place, wherever the
 * menu was raised from — in the tree row, the Opened row or the tab handle —
 * so the caller says how to start it. */
export default function SourceOptions(props: {
  id: string;
  onRename: () => void;
}): JSX.Element {
  const playlist = useApp(
    (s) =>
      (selectTab(s, props.id)?.kind ??
        s.sources.data.find((x) => x.id === props.id)?.kind) === "playlist",
  );
  const { duplicatePlaylist, duplicateQuery, requestDelete } = useAppActions();
  return (
    <>
      <MenuItem icon={Icons.Rename} label="Rename" onClick={props.onRename} />
      <MenuItem
        icon={Icons.Duplicate}
        label="Duplicate"
        onClick={() =>
          playlist ? duplicatePlaylist(props.id) : duplicateQuery(props.id)
        }
      />
      <MenuItem
        icon={Icons.Delete}
        label="Delete"
        danger
        onClick={() => requestDelete(props.id)}
      />
    </>
  );
}
