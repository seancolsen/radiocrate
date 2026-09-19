import {
  useMemo,
  useRef,
  useState,
  type JSX,
  type MouseEvent,
  type RefObject,
} from "react";
import { TREE_INDENT, TREE_PAD, useTreeDrag } from "../gestures/useTreeDrag";
import { Icons } from "../icons";
import {
  buildTree,
  visibleRows,
  type TreeItemRef,
} from "../query/explorerTree";
import { useApp, useAppActions } from "../stores/react";
import FolderRow from "./FolderRow";
import QueryRow from "./QueryRow";
import { ContextMenu } from "./ui/ContextMenu";
import { MenuItem } from "./ui/Menu";

/** A folder's context menu. */
function FolderMenu(props: { id: string }): JSX.Element {
  const actions = useAppActions();
  const item = { kind: "folder", id: props.id } as const;
  return (
    <>
      <MenuItem
        icon={Icons.Query}
        label="Add query"
        onClick={() => actions.addQuery(props.id)}
      />
      <MenuItem
        icon={Icons.Rename}
        label="Rename folder"
        onClick={() => actions.beginTreeRename(item)}
      />
      <MenuItem
        icon={Icons.Delete}
        label="Delete folder"
        danger
        onClick={() => actions.deleteFolder(props.id)}
      />
    </>
  );
}

/** A saved query's context menu: the query-page actions menu's Rename,
 * Duplicate and Delete — with the rename made in place, in the row. */
function QueryMenu(props: { id: string }): JSX.Element {
  const actions = useAppActions();
  const item = { kind: "query", id: props.id } as const;
  return (
    <>
      <MenuItem
        icon={Icons.Rename}
        label="Rename"
        onClick={() => actions.beginTreeRename(item)}
      />
      <MenuItem
        icon={Icons.Duplicate}
        label="Duplicate"
        onClick={() => actions.duplicateQuery(props.id)}
      />
      <MenuItem
        icon={Icons.Delete}
        label="Delete"
        danger
        onClick={() => actions.requestDelete(props.id)}
      />
    </>
  );
}

/** The saved queries, as the tree of folders the user arranges them in: the
 * rows (folders expanded or not, the filter applied), drag-to-rearrange across
 * them, and each item's context menu (a right-click, or a touch held on it and
 * let go).
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
  const renaming = useApp((s) => s.renamingTreeItem);
  const actions = useAppActions();

  const tree = useMemo(() => buildTree(queries, folders), [queries, folders]);
  const rows = useMemo(
    () => visibleRows(tree, expanded, filter),
    [tree, expanded, filter],
  );
  // A filter shows every folder open; the chevrons have nothing to change.
  const filtering = filter.trim() !== "";

  const [menu, setMenu] = useState<{
    item: TreeItemRef;
    x: number;
    y: number;
  } | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const dnd = useTreeDrag({
    listRef,
    scrollRef: props.scrollRef,
    tree,
    rows,
    onDrop: actions.moveTreeItem,
    onHold: (item, x, y) => setMenu({ item, x, y }),
  });
  const drag = dnd.drag;
  const target = drag?.target ?? null;

  return (
    <div ref={listRef} role="tree" aria-label="Queries" className="relative">
      {rows.map((row) => {
        const { node } = row;
        const dragging =
          drag?.item.kind === node.kind && drag.item.id === node.id;
        const item = { kind: node.kind, id: node.id };
        const rename = {
          renaming: renaming?.kind === node.kind && renaming.id === node.id,
          onBeginRename: () => actions.beginTreeRename(item),
          onCommitRename: (name: string) =>
            actions.commitTreeRename(item, name),
          onCancelRename: actions.cancelTreeRename,
        };
        const onContextMenu = (e: MouseEvent<HTMLElement>) => {
          e.preventDefault();
          // A touch resting on the row is picking it up; its menu comes
          // with the release (`onHold`), if the row isn't moved.
          if (dnd.pressing()) return;
          setMenu({ item, x: e.clientX, y: e.clientY });
        };
        if (node.kind === "query") {
          return (
            <QueryRow
              key={`query:${node.id}`}
              name={node.name}
              depth={row.depth}
              dragging={dragging}
              {...rename}
              onPointerDown={(e) => dnd.onPointerDown(e, item)}
              onContextMenu={onContextMenu}
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
            dragging={dragging}
            {...rename}
            dropTarget={target?.kind === "into" && target.folder === node.id}
            onToggle={() => {
              if (!filtering && !dnd.ignoreClick()) {
                actions.toggleFolderExpanded(node.id);
              }
            }}
            onPointerDown={(e) => dnd.onPointerDown(e, item)}
            onContextMenu={onContextMenu}
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
          {menu.item.kind === "folder" ? (
            <FolderMenu id={menu.item.id} />
          ) : (
            <QueryMenu id={menu.item.id} />
          )}
        </ContextMenu>
      )}
    </div>
  );
}
