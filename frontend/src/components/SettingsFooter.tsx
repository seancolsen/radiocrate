import { type JSX } from "solid-js";
import { Icons } from "../icons";
import { Menu } from "./ui/Menu";
import SettingsMenu from "./SettingsMenu";

/** The Settings dropdown pinned to the explorer's bottom: gear icon + muted
 * "Settings" label, opening {@link SettingsMenu} upward (it sits on the bottom
 * edge). */
export default function SettingsFooter(): JSX.Element {
  return (
    <Menu
      side="above"
      align="start"
      width="180px"
      class="w-full shrink-0"
      trigger={(api) => (
        <button
          type="button"
          aria-label="Settings"
          aria-expanded={api.open}
          class="text-ink-weak hover:bg-hover hover:text-ink flex h-[30px] w-full shrink-0 items-center gap-2 pl-3"
          classList={{ "bg-hover text-ink": api.open }}
          onClick={() => api.toggle()}
        >
          <Icons.Settings class="size-4" />
          <span class="text-[13px]">Settings</span>
        </button>
      )}
    >
      <SettingsMenu />
    </Menu>
  );
}
