import type { JSX } from "solid-js";
import { Icons } from "../icons";
import { useAppState } from "../state/store";
import { Menu, MenuItem } from "./ui/Menu";

/** The Settings dropdown pinned to the sidebar bottom: gear icon + muted
 * "Settings" label, opening a menu upward (it sits on the bottom edge) with the
 * Keyboard shortcuts entry. Mirrors `organizer.rs:settings_footer`, whose theme
 * entries have no DOM counterpart yet — the theme follows the system there. */
export default function SettingsFooter(): JSX.Element {
  const store = useAppState();
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
      <MenuItem
        icon={Icons.Keyboard}
        label="Keyboard shortcuts"
        onClick={() => store.openShortcutsTab()}
      />
    </Menu>
  );
}
