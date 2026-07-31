import { For, type JSX } from "solid-js";
import { Icons } from "../icons";
import {
  useAppState,
  type AudioQualityPref,
  type ThemePref,
} from "../state/store";
import {
  Menu,
  MenuHeading,
  MenuItem,
  MenuSeparator,
  MenuToggleItem,
} from "./ui/Menu";

const THEME_OPTIONS: {
  pref: ThemePref;
  label: string;
  icon: typeof Icons.LightMode;
}[] = [
  { pref: "light", label: "Light", icon: Icons.LightMode },
  { pref: "dark", label: "Dark", icon: Icons.DarkMode },
  { pref: "system", label: "System", icon: Icons.SystemTheme },
];

const AUDIO_QUALITY_OPTIONS: {
  pref: AudioQualityPref;
  label: string;
  icon: typeof Icons.HigherQuality;
}[] = [
  { pref: "higher", label: "Higher quality", icon: Icons.HigherQuality },
  { pref: "lower", label: "Lower bandwidth", icon: Icons.LowerBandwidth },
];

/** The Settings dropdown pinned to the sidebar bottom: gear icon + muted
 * "Settings" label, opening a menu upward (it sits on the bottom edge) with a
 * Light/Dark/System theme picker, a Higher quality/Lower bandwidth audio
 * streaming picker, and the Keyboard shortcuts entry. */
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
      <MenuHeading text="Theme" />
      <For each={THEME_OPTIONS}>
        {(option) => (
          <MenuToggleItem
            kind="radio"
            icon={option.icon}
            label={option.label}
            checked={store.state.theme === option.pref}
            onClick={() => store.setTheme(option.pref)}
          />
        )}
      </For>
      <MenuSeparator />
      <MenuHeading text="Audio streaming" />
      <For each={AUDIO_QUALITY_OPTIONS}>
        {(option) => (
          <MenuToggleItem
            kind="radio"
            icon={option.icon}
            label={option.label}
            checked={store.audioQuality() === option.pref}
            onClick={() => store.setAudioQuality(option.pref)}
          />
        )}
      </For>
      <MenuSeparator />
      <MenuItem
        icon={Icons.Keyboard}
        label="Keyboard shortcuts"
        onClick={() => store.openShortcutsTab()}
      />
    </Menu>
  );
}
