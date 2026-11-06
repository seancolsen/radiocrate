import type { JSX } from "react";
import { Icons } from "../icons";
import { Menu } from "./ui/Menu";
import { cx } from "./ui/cx";
import SettingsMenu from "./SettingsMenu";

/** The Settings dropdown in the explorer's footer: gear icon + muted "Settings"
 * label, opening {@link SettingsMenu} upward (it sits on the bottom edge). */
export default function SettingsFooter(): JSX.Element {
  return (
    <Menu
      side="above"
      align="start"
      width="180px"
      className="min-w-0 flex-1"
      trigger={(api) => (
        <button
          type="button"
          aria-label="Settings"
          aria-expanded={api.open}
          className={cx(
            "text-ink-weak hover:bg-edge/40 hover:text-ink flex h-[30px] w-full shrink-0 items-center gap-2 pl-3",
            { "bg-edge/40 text-ink": api.open },
          )}
          onClick={() => api.toggle()}
        >
          <Icons.Settings className="size-4" />
          <span className="text-[13px]">Settings</span>
        </button>
      )}
    >
      <SettingsMenu />
    </Menu>
  );
}
