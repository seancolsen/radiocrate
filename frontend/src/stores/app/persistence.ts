import type { AudioQualityPref } from "../../audio/engine";
import type { AppEnv } from "../env";
import type { ThemePref } from "./theme";

// Every persisted preference reads/writes through `env.storage` rather than
// `window.localStorage` directly (state management rule 7), so store unit
// tests can pass a fake. Each getter swallows a storage failure (private-mode
// denial) and falls back to the default, exactly as the read does today.

const SIDEBAR_KEY = "sidebarOpen";

export function storedSidebarOpen(env: AppEnv): boolean {
  try {
    const v = env.storage.getItem(SIDEBAR_KEY);
    if (v === "true") return true;
    if (v === "false") return false;
  } catch {
    // Private-mode localStorage denial — fall back to the default.
  }
  return false;
}

export function persistSidebar(env: AppEnv, open: boolean): void {
  try {
    env.storage.setItem(SIDEBAR_KEY, open ? "true" : "false");
  } catch {
    // ignore
  }
}

const THEME_KEY = "theme";

export function storedTheme(env: AppEnv): ThemePref {
  try {
    const v = env.storage.getItem(THEME_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    // Private-mode localStorage denial — fall back to system.
  }
  return "system";
}

export function persistTheme(env: AppEnv, pref: ThemePref): void {
  try {
    if (pref === "system") env.storage.removeItem(THEME_KEY);
    else env.storage.setItem(THEME_KEY, pref);
  } catch {
    // ignore
  }
}

const AUDIO_QUALITY_KEY = "audioQuality";

export function storedAudioQuality(env: AppEnv): AudioQualityPref {
  try {
    const v = env.storage.getItem(AUDIO_QUALITY_KEY);
    if (v === "lower") return v;
  } catch {
    // Private-mode localStorage denial — fall back to the default.
  }
  return "higher";
}

export function persistAudioQuality(env: AppEnv, pref: AudioQualityPref): void {
  try {
    if (pref === "higher") env.storage.removeItem(AUDIO_QUALITY_KEY);
    else env.storage.setItem(AUDIO_QUALITY_KEY, pref);
  } catch {
    // ignore
  }
}

/** Width bounds for the record-editor sidebar, in CSS px. The maximum is also
 * capped against the live viewport while dragging (see `RecordEditorPanel`), so
 * these are just the absolute limits a persisted value is trusted within. */
export const RECORD_SIDEBAR_MIN_WIDTH = 240;
export const RECORD_SIDEBAR_MAX_WIDTH = 800;
const RECORD_SIDEBAR_DEFAULT_WIDTH = 340;
const RECORD_SIDEBAR_KEY = "recordSidebarWidth";

export function clampRecordSidebarWidth(px: number): number {
  return Math.max(
    RECORD_SIDEBAR_MIN_WIDTH,
    Math.min(RECORD_SIDEBAR_MAX_WIDTH, Math.round(px)),
  );
}

export function storedRecordSidebarWidth(env: AppEnv): number {
  try {
    const v = Number(env.storage.getItem(RECORD_SIDEBAR_KEY));
    if (Number.isFinite(v) && v > 0) return clampRecordSidebarWidth(v);
  } catch {
    // Private-mode localStorage denial — fall back to the default.
  }
  return RECORD_SIDEBAR_DEFAULT_WIDTH;
}

export function persistRecordSidebarWidth(env: AppEnv, px: number): void {
  try {
    env.storage.setItem(RECORD_SIDEBAR_KEY, String(px));
  } catch {
    // ignore
  }
}
