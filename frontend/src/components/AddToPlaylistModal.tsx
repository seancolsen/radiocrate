import { useMemo, useState, type JSX } from "react";
import { buildTree, pruneTree, visibleRows } from "../query/explorerTree";
import { useApp, useAppActions, useStores } from "../stores/react";
import FolderRow from "./FolderRow";
import SourceRow from "./SourceRow";
import { Modal } from "./ui/Modal";

/** What the explorer's rows are handed for the drag and rename gestures, which
 * the dialog's tree has none of. */
const STILL_ROW = {
  renaming: false,
  dragging: false,
  dropTarget: false,
  onBeginRename: () => {},
  onCommitRename: () => {},
  onCancelRename: () => {},
  onPointerDown: () => {},
  onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
};

/** How many tracks the dialog adds, as it says it. */
function tracksLabel(n: number): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? "track" : "tracks"}`;
}

/** The "Add to playlist…" dialog, raised from a result row's menu (or the
 * multi-select toolbar's): the sources tree, showing only playlists — and only
 * the folders with a playlist somewhere below them. Clicking a playlist adds
 * the tracks to its end and closes the dialog; Escape, a click outside, or
 * the × closes it adding nothing.
 *
 * On a playlist's page, the playlist the tracks were chosen from is left out:
 * the spec has no flow for adding a playlist's tracks to itself. */
export default function AddToPlaylistModal(): JSX.Element | null {
  const pending = useApp((s) => s.pendingAddToPlaylist);
  const { cancelAddToPlaylist } = useAppActions();
  if (!pending) return null;
  return (
    <Modal
      title="Add to playlist"
      subtitle={tracksLabel(pending.trackIds.length)}
      onClose={cancelAddToPlaylist}
      width="320px"
    >
      <AddToPlaylistBody fromTabId={pending.fromTabId} />
    </Modal>
  );
}

/** The dialog's contents, its own component because its folders' expansion
 * is seeded once, as it opens, from the explorer's — and kept to itself from
 * then on, so expanding a folder here doesn't expand it in the explorer. */
function AddToPlaylistBody(props: { fromTabId: string }): JSX.Element {
  const stores = useStores();
  const sources = useApp((s) => s.sources.data);
  const folders = useApp((s) => s.folders.data);
  const { confirmAddToPlaylist } = useAppActions();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => stores.app.store.getState().expandedFolders,
  );

  const { fromTabId } = props;
  const tree = useMemo(
    () =>
      pruneTree(
        buildTree(sources, folders),
        // A playlist's tab id is its source id.
        (source) => source.kind === "playlist" && source.id !== fromTabId,
      ),
    [sources, folders, fromTabId],
  );
  const rows = useMemo(() => visibleRows(tree, expanded, ""), [tree, expanded]);

  const toggle = (id: string) =>
    setExpanded((open) => {
      const next = new Set(open);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div
      role="tree"
      aria-label="Playlists"
      className="border-edge max-h-[60vh] overflow-y-auto rounded-md border py-1"
    >
      {rows.map((row) => {
        const { node } = row;
        return node.kind === "source" ? (
          <SourceRow
            key={`source:${node.id}`}
            id={node.id}
            kind={node.source.kind}
            open={false}
            active={false}
            name={node.name}
            depth={row.depth}
            {...STILL_ROW}
            onOpen={() => confirmAddToPlaylist(node.id)}
          />
        ) : (
          <FolderRow
            key={`folder:${node.id}`}
            name={node.name}
            depth={row.depth}
            expanded={row.expanded}
            {...STILL_ROW}
            onToggle={() => toggle(node.id)}
          />
        );
      })}
      {rows.length === 0 && (
        <div className="text-ink-weak flex h-[26px] items-center px-3 text-sm">
          No playlists
        </div>
      )}
    </div>
  );
}
