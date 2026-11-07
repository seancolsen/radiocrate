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
    align: "end",
  });
  return (
    <>
      <button
        type="button"
        {...tip.triggerProps}
        className="text-ink-weak hover:text-ink flex h-[30px] w-10 shrink-0 items-center justify-center"
        onClick={() => {
          togglePalette();
          if (!persistent) setSidebarOpen(false);
        }}
      >
        <Icons.Commands className="size-4 shrink-0" />
      </button>
      {tip.tooltip}
    </>
  );
}

/** The explorer's footer, set apart from the list above it by its surface: on
 * one line, the settings at the left and the command palette at the right. */
export default function ExplorerFooter(): JSX.Element {
  return (
    <footer className="bg-bar shrink-0">
      <div className="flex">
        <SettingsFooter />
        <PaletteButton />
      </div>
    </footer>
  );
}
