import type { JSX } from "react";
import { Icons } from "../icons";
import { useAppActions, useCommandActions } from "../stores/react";
import SettingsFooter from "./SettingsFooter";
import { useTooltip } from "./ui/Tooltip";
import { usePersistentSidebar } from "./ui/usePersistentSidebar";

/** Opens the command palette, which otherwise only its shortcut leads to; the
 * tooltip is there to teach the shortcut. A drawer gets out of the way: whatever
 * command is picked, it's what happens beneath the drawer that's worth seeing. */
function PaletteButton(): JSX.Element {
  const { togglePalette } = useCommandActions();
  const { setSidebarOpen } = useAppActions();
  const persistent = usePersistentSidebar();
  const tip = useTooltip({
    label: "Command palette",
    command: "palette.open",
    align: "start",
  });
  return (
    <>
      <button
        type="button"
        {...tip.triggerProps}
        className="text-ink-weak hover:bg-edge/40 hover:text-ink flex h-[30px] w-full items-center gap-2 pl-3"
        onClick={() => {
          togglePalette();
          if (!persistent) setSidebarOpen(false);
        }}
      >
        <Icons.Commands className="size-4 shrink-0" />
        <span className="truncate text-[13px]">Command palette</span>
      </button>
      {tip.tooltip}
    </>
  );
}

/** The explorer's footer, set apart from the list above it by its surface: the
 * ways into the commands and the settings. */
export default function ExplorerFooter(): JSX.Element {
  return (
    <footer className="bg-bar shrink-0">
      <PaletteButton />
      <SettingsFooter />
    </footer>
  );
}
