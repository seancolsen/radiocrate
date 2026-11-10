import type { JSX } from "react";
import { Icons, type IconComponent } from "../icons";
import type { AudioQualityPref, ThemePref } from "../stores/app";
import { useApp, useAppActions } from "../stores/react";
import { SETTINGS } from "../state/settings";
import {
  MenuHeading,
  MenuItem,
  MenuSeparator,
  MenuToggleItem,
} from "./ui/Menu";
import { useCloseMenu } from "./ui/useMenu";

const THEME_OPTIONS: { pref: ThemePref; label: string; icon: IconComponent }[] =
  [
    { pref: "light", label: "Light", icon: Icons.LightMode },
    { pref: "dark", label: "Dark", icon: Icons.DarkMode },
    { pref: "system", label: "System", icon: Icons.SystemTheme },
  ];

const AUDIO_QUALITY_OPTIONS: {
  pref: AudioQualityPref;
  label: string;
  icon: IconComponent;
}[] = [
  { pref: "higher", label: "Higher quality", icon: Icons.HigherQuality },
  { pref: "lower", label: "Lower bandwidth", icon: Icons.LowerBandwidth },
];

/** The Settings menu body: a Light/Dark/System theme picker, a Higher
 * quality/Lower bandwidth audio streaming picker, the Querydown Prelude, Query
 * presets, Keyboard shortcuts, Logging and About entries, and the collection
 * re-scan. */
export default function SettingsMenu(): JSX.Element {
  const theme = useApp((s) => s.theme);
  const audioQuality = useApp((s) => s.audioQuality);
  const rescanning = useApp((s) => s.rescanning);
  const actions = useAppActions();
  const closeMenu = useCloseMenu();
  return (
    <>
      <MenuHeading text="Theme" />
      {THEME_OPTIONS.map((option) => (
        <MenuToggleItem
          key={option.pref}
          kind="radio"
          icon={option.icon}
          label={option.label}
          checked={theme === option.pref}
          onClick={() => actions.setTheme(option.pref)}
        />
      ))}
      <MenuSeparator />
      <MenuHeading text="Audio streaming" />
      {AUDIO_QUALITY_OPTIONS.map((option) => (
        <MenuToggleItem
          key={option.pref}
          kind="radio"
          icon={option.icon}
          label={option.label}
          checked={audioQuality === option.pref}
          onClick={() => actions.setAudioQuality(option.pref)}
        />
      ))}
      <MenuSeparator />
      <MenuItem
        icon={Icons.Querydown}
        label={SETTINGS.querydown_prelude.name}
        onClick={() => actions.openPreludeTab()}
      />
      <MenuItem
        icon={Icons.Presets}
        label="Query presets"
        command="presets.manage"
        onClick={() => actions.openPresetsTab()}
      />
      <MenuItem
        icon={Icons.Keyboard}
        label="Keyboard shortcuts"
        command="shortcuts.configure"
        onClick={() => actions.openShortcutsTab()}
      />
      <MenuItem
        icon={Icons.Log}
        label="Logging"
        onClick={() => actions.openLogTab()}
      />
      <MenuItem
        icon={Icons.About}
        label="About RadioCrate"
        onClick={() => actions.openAbout()}
      />
      <MenuSeparator />
      {/* The one row that outlives its own click: the menu stays up, with this
          row disabled and its icon spinning, until the scan comes back — and
          then it dismisses the menu itself. */}
      <MenuItem
        icon={rescanning ? Icons.Spinner : Icons.AudioFile}
        label="Re-scan collection"
        disabled={rescanning}
        keepOpen
        onClick={() => void actions.rescanCollection().then(closeMenu)}
      />
    </>
  );
}
