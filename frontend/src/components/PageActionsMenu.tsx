import { Show, type JSX } from "solid-js";
import { Icons } from "../icons";
import { useAppState } from "../state/store";
import { MenuItem, MenuSeparator } from "./ui/Menu";

/** The wrench "query actions" menu body. This session wires the items that act
 * on frontend-owned state without un-ported subsystems: "Revert changes" (only
 * while the working query differs from its saved form) and "View SQL". "Delete"
 * is rendered (a backend write) but stubbed non-functional. Change base, Rename,
 * Duplicate, Pin, and Convert-to-full are deferred (see the plan's non-goals). */
export default function PageActionsMenu(props: { tabId: string }): JSX.Element {
  const store = useAppState();
  return (
    <>
      <Show when={store.isUnsaved(props.tabId)}>
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
        onClick={() => {
          /* Stubbed this session — deletion is a backend write (deferred). */
        }}
      />
    </>
  );
}
