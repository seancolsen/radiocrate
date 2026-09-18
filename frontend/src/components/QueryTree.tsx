import { useMemo, useRef, useState, type JSX, type RefObject } from "react";
import { TREE_INDENT, TREE_PAD, useTreeDrag } from "../gestures/useTreeDrag";
import { Icons } from "../icons";
import { buildTree, visibleRows } from "../query/explorerTree";
import { useApp, useAppActions } from "../stores/react";
import FolderRow from "./FolderRow";
import QueryRow from "./QueryRow";
import { ContextMenu } from "./ui/ContextMenu";
import { MenuItem } from "./ui/Menu";

/** The saved queries, as the tree of folders the user arranges them in: the
 * rows (folders expanded or not, the filter applied), drag-to-rearrange across
 * them, and a folder's right-click menu.
 *
 * `scrollRef` is the element the rows scroll in, which a drag scrolls when it
 * nears the top or bottom. */
export default function QueryTree(props: {
  scrollRef: RefObject<HTMLElement | null>;
}): JSX.Element {
  const queries = useApp((s) => s.queries.data);
  const folders = useApp((s) => s.folders.data);
  const expanded = useApp((s) => s.expandedFolders);
  const filter = useApp((s) => s.queryFilter);
  const renamingFolder = useApp((s) => s.renamingFolder);
  const actions = useAppActions();

  const tree = useMemo(() => buildTree(queries, folders), [queries, folders]);
  const rows = useMemo(
    () => visibleRows(tree, expanded, filter),
    [tree, expanded, filter],
  );
  // A filter shows every folder open; the chevrons have nothing to change.
  const filtering = filter.trim() !== "";

  const listRef = useRef<HTMLDivElement>(null);
  const dnd = useTreeDrag({
    listRef,
    scrollRef: props.scrollRef,
    tree,
    rows,
    onDrop: actions.moveTreeItem,
  });
  const drag = dnd.drag;
  const target = drag?.target ?? null;

  const [menu, setMenu] = useState<{
    folder: string;
    x: number;
    y: number;
  } | null>(null);

  return (
    <div ref={listRef} role="tree" aria-label="Queries" className="relative">
      {rows.map((row) => {
        const { node } = row;
        const dragging =
          drag?.item.kind === node.kind && drag.item.id === node.id;
        const item = { kind: node.kind, id: node.id };
        if (node.kind === "query") {
          return (
            <QueryRow
              key={`query:${node.id}`}
              name={node.name}
              depth={row.depth}
              dragging={dragging}
              onPointerDown={(e) => dnd.onPointerDown(e, item)}
              onOpen={() => {
                if (dnd.ignoreClick()) return;
                actions.openTab({
                  id: node.id,
                  name: node.name,
                  definition: node.query.definition,
                });
              }}
            />
          );
        }
        return (
          <FolderRow
            key={`folder:${node.id}`}
            name={node.name}
            depth={row.depth}
            expanded={row.expanded}
            renaming={renamingFolder === node.id}
            dragging={dragging}
            dropTarget={target?.kind === "into" && target.folder === node.id}
            onToggle={() => {
              if (!filtering && !dnd.ignoreClick()) {
                actions.toggleFolderExpanded(node.id);
              }
            }}
            onBeginRename={() => actions.beginFolderRename(node.id)}
            onCommitRename={(name) => actions.commitFolderRename(node.id, name)}
            onCancelRename={actions.cancelFolderRename}
            onPointerDown={(e) => dnd.onPointerDown(e, item)}
            onContextMenu={(e) => {
              e.preventDefault();
              // A touch resting on the row is picking it up, not asking for
              // a menu.
              if (dnd.pressing()) return;
              setMenu({ folder: node.id, x: e.clientX, y: e.clientY });
            }}
          />
        );
      })}

      {rows.length === 0 && filtering && (
        <div className="text-ink-weak flex h-[26px] items-center pl-8 text-sm">
          No matching queries
        </div>
      )}

      {target?.kind === "between" && (
        <div
          aria-hidden="true"
          className="bg-accent pointer-events-none absolute right-1 h-0.5 -translate-y-1/2 rounded-full"
          style={{
            top: drag?.lineTop,
            left: TREE_PAD + target.depth * TREE_INDENT,
          }}
        />
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <MenuItem
            icon={Icons.Rename}
            label="Rename folder"
            onClick={() => actions.beginFolderRename(menu.folder)}
          />
          <MenuItem
            icon={Icons.Delete}
            label="Delete folder"
            danger
            onClick={() => actions.deleteFolder(menu.folder)}
          />
        </ContextMenu>
      )}
    </div>
  );
}
