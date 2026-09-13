import type { AppEnv } from "../env";

/** "system" follows `prefers-color-scheme` (no stored key); "light"/"dark" is an
 * explicit override, persisted and mirrored onto `<html data-theme>`. */
export type ThemePref = "light" | "dark" | "system";

/** Each theme's `--panel`, duplicated from app.css: the `theme-color` meta
 * names the surface the app paints at the very top of the viewport, which is
 * what Android tints the status bar behind the clock with. */
const THEME_COLOR = { light: "#f8f8f8", dark: "#1b1b1b" } as const;

const DARK_SYSTEM_QUERY = "(prefers-color-scheme: dark)";

/** Whether the theme in force paints the dark surface — an explicit override
 * says so outright, "system" defers to the OS. */
export function isDark(pref: ThemePref, env: AppEnv): boolean {
  if (pref !== "system") return pref === "dark";
  return env.matchMedia(DARK_SYSTEM_QUERY).matches;
}

/** Mirrors index.html's pre-paint bootstrap script: an explicit theme sets
 * `data-theme` (which app.css's attribute selectors read), "system" clears it,
 * and either way index.html's single `theme-color` meta is repointed at the
 * surface now in force. The meta carries no `media` and has no sibling that
 * does — a user agent honors the first `theme-color` whose media matches, so a
 * media-queried pair would outrank whatever we set here and strand the Android
 * status bar on the other theme's color. */
export function applyThemeToDocument(pref: ThemePref, env: AppEnv): void {
  env.setDocumentTheme(
    pref === "system" ? null : pref,
    isDark(pref, env) ? THEME_COLOR.dark : THEME_COLOR.light,
  );
}

/** Installs the listener that keeps the document in step when the OS flips
 * light/dark while the theme is "system" — the one `theme-color` meta can't
 * track that on its own the way a media-queried pair would. Nothing to do for
 * an explicit override: it already ignores the system. Returns the cleanup. */
export function watchSystemTheme(
  env: AppEnv,
  currentTheme: () => ThemePref,
): () => void {
  const systemDark = env.matchMedia(DARK_SYSTEM_QUERY);
  const onChange = () => {
    if (currentTheme() === "system") applyThemeToDocument("system", env);
  };
  systemDark.addEventListener("change", onChange);
  return () => systemDark.removeEventListener("change", onChange);
}
