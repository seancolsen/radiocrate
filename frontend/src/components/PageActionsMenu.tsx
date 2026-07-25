import { Show, type JSX } from "solid-js";
import { Icons } from "../icons";
import { useAppState } from "../state/store";
import { MenuItem, MenuSeparator } from "./ui/Menu";

/** The wrench "query actions" menu body. Rename, Duplicate, Revert (only while
 * the working query differs from its saved form), View SQL, and Delete
 * (Change base, Pin, and Convert-to-full remain deferred). */
export default function PageActionsMenu(props: { tabId: string }): JSX.Element {
  const store = useAppState();
  return (
    <>
      <MenuItem
        icon={Icons.Rename}
        label="Rename"
        onClick={() => store.beginRename(props.tabId)}
      />
      <MenuItem
        icon={Icons.Duplicate}
        label="Duplicate"
        onClick={() => store.duplicateQuery(props.tabId)}
      />
      <Show when={store.canRevert(props.tabId)}>
        <MenuItem
          icon={Icons.Revert}
          label="Revert changes"
          onClick={() => store.revertLive(props.tabId)}
        />
      </Show>
      <MenuItem
        icon={Icons.ViewSql}
        label="View SQL"
        onClick={() => store.openViewSql(props.tabId)}
      />
      <MenuSeparator />
      <MenuItem
        icon={Icons.Delete}
        label="Delete"
        danger
        onClick={() => store.requestDelete(props.tabId)}
      />
    </>
  );
}
