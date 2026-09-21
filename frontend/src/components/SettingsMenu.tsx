import type { JSX } from "react";
import { Icons, type IconComponent } from "../icons";
import type { AudioQualityPref, ThemePref } from "../stores/app";
import { useApp, useAppActions } from "../stores/react";
import { SETTINGS, SETTING_KEYS } from "../state/settings";
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
 * quality/Lower bandwidth audio streaming picker, one entry per configurable
 * setting (each opening its editor dialog), the Keyboard shortcuts and About
 * entries, and the collection re-scan. */
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
      {/* Driven by the settings catalogue, so a new setting shows up here with
          its name and needs no entry of its own. */}
      {SETTING_KEYS.map((key) => (
        <MenuItem
          key={key}
          icon={Icons.Querydown}
          label={SETTINGS[key].name}
          onClick={() => actions.openSetting(key)}
        />
      ))}
      <MenuItem
        icon={Icons.Keyboard}
        label="Keyboard shortcuts"
        onClick={() => actions.openShortcutsTab()}
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
