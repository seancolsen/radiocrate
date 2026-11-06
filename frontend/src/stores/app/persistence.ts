import type { Preset } from "api-client";
import type { AudioQualityPref } from "../../audio/engine";
import {
  definitionFromStored,
  definitionToStored,
  usesPreset,
  type QueryDefinition,
} from "../../query/definition";
import {
  playlistDefinitionFromStored,
  playlistDefinitionToStored,
  type PlaylistDefinition,
} from "../../query/playlist";
import type { AppEnv } from "../env";
import type { Tab } from "./state";
import type { ThemePref } from "./theme";

// Everything persisted — the preferences and the open tabs — reads/writes
// through `env.storage` rather than `window.localStorage` directly (state
// management rule 7), so store unit tests can pass a fake. Each getter swallows
// a storage failure (private-mode denial) and falls back to the default.

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

/** A sidebar width read from storage, clamped; anything unreadable is `fallback`. */
function storedWidth(
  env: AppEnv,
  key: string,
  clamp: (px: number) => number,
  fallback: number,
): number {
  try {
    const v = Number(env.storage.getItem(key));
    if (Number.isFinite(v) && v > 0) return clamp(v);
  } catch {
    // Private-mode localStorage denial — fall back to the default.
  }
  return fallback;
}

function persistWidth(env: AppEnv, key: string, px: number): void {
  try {
    env.storage.setItem(key, String(px));
  } catch {
    // ignore
  }
}

/** Width bounds for the explorer sidebar, in CSS px. Like the record editor's
 * below, the maximum is also capped against the live viewport. */
const EXPLORER_MIN_WIDTH = 160;
const EXPLORER_MAX_WIDTH = 600;
const EXPLORER_DEFAULT_WIDTH = 200;
const EXPLORER_WIDTH_KEY = "explorerWidth";

export function clampExplorerWidth(px: number): number {
  return Math.max(
    EXPLORER_MIN_WIDTH,
    Math.min(EXPLORER_MAX_WIDTH, Math.round(px)),
  );
}

export function storedExplorerWidth(env: AppEnv): number {
  return storedWidth(
    env,
    EXPLORER_WIDTH_KEY,
    clampExplorerWidth,
    EXPLORER_DEFAULT_WIDTH,
  );
}

export function persistExplorerWidth(env: AppEnv, px: number): void {
  persistWidth(env, EXPLORER_WIDTH_KEY, px);
}

/** Width bounds for the record-editor sidebar, in CSS px. The maximum is also
 * capped against the live viewport while dragging (see `RecordEditorPanel`), so
 * these are just the absolute limits a persisted value is trusted within. */
const RECORD_SIDEBAR_MIN_WIDTH = 240;
const RECORD_SIDEBAR_MAX_WIDTH = 800;
const RECORD_SIDEBAR_DEFAULT_WIDTH = 340;
const RECORD_SIDEBAR_KEY = "recordSidebarWidth";

export function clampRecordSidebarWidth(px: number): number {
  return Math.max(
    RECORD_SIDEBAR_MIN_WIDTH,
    Math.min(RECORD_SIDEBAR_MAX_WIDTH, Math.round(px)),
  );
}

export function storedRecordSidebarWidth(env: AppEnv): number {
  return storedWidth(
    env,
    RECORD_SIDEBAR_KEY,
    clampRecordSidebarWidth,
    RECORD_SIDEBAR_DEFAULT_WIDTH,
  );
}

export function persistRecordSidebarWidth(env: AppEnv, px: number): void {
  persistWidth(env, RECORD_SIDEBAR_KEY, px);
}

const EXPANDED_FOLDERS_KEY = "expandedFolders";

/** The explorer folders left expanded (by id). Anything unreadable restores
 * none — every folder starts collapsed. */
export function storedExpandedFolders(env: AppEnv): ReadonlySet<string> {
  try {
    const raw = env.storage.getItem(EXPANDED_FOLDERS_KEY);
    const ids: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(ids)
        ? ids.filter((id): id is string => typeof id === "string")
        : [],
    );
  } catch {
    // Private-mode denial, or a value that isn't JSON.
    return new Set();
  }
}

export function persistExpandedFolders(
  env: AppEnv,
  ids: ReadonlySet<string>,
): void {
  try {
    if (ids.size === 0) env.storage.removeItem(EXPANDED_FOLDERS_KEY);
    else env.storage.setItem(EXPANDED_FOLDERS_KEY, JSON.stringify([...ids]));
  } catch {
    // Denied or over quota — the folders just start collapsed next time.
  }
}

/** An open tab as a previous visit left it: a query or playlist tab with both
 * of its definitions (so unsaved edits survive), or the keyboard-shortcuts
 * editor, which carries nothing of its own. */
export type StoredTab =
  | {
      kind: "query";
      id: string;
      name: string;
      saved: QueryDefinition;
      live: QueryDefinition;
      persisted: boolean;
      folder: string | null;
      pristine?: boolean;
    }
  | {
      kind: "playlist";
      id: string;
      playlistId: string;
      name: string;
      saved: PlaylistDefinition;
      live: PlaylistDefinition;
    }
  | { kind: "shortcuts" }
  | { kind: "presets" }
  | { kind: "prelude" };

/** The open tabs a previous visit left, in tab-bar order, and the id of the one
 * that was active. */
export interface StoredTabs {
  tabs: StoredTab[];
  activeTabId: string | null;
  /** The unsaved presets those tabs use, which exist nowhere else. */
  unsavedPresets: Preset[];
}

const OPEN_TABS_KEY = "openTabs";
/** Bump when the record's shape changes incompatibly: a record of any other
 * version restores nothing. Adding a tab kind isn't such a change — an older
 * build skips an entry of a kind it doesn't know — and bumping would close
 * every open tab. */
const OPEN_TABS_VERSION = 1;

/** The record as it sits in storage: definitions in their stored string form,
 * the same encoding the backend keeps a saved query in. */
interface OpenTabsRecord {
  version: number;
  activeTabId: string | null;
  /** Absent from records written before queries could use unsaved presets. */
  unsavedPresets?: Preset[];
  tabs: Array<
    | {
        kind: "query";
        id: string;
        name: string;
        saved: string;
        live: string;
        persisted: boolean;
        /** Absent from records written before unsaved queries kept one. */
        folder?: string | null;
        /** Present (and `true`) only for a query the user hasn't touched. */
        pristine?: boolean;
      }
    | {
        kind: "playlist";
        id: string;
        playlistId: string;
        name: string;
        saved: string;
        live: string;
      }
    | { kind: "shortcuts" }
    | { kind: "presets" }
    | { kind: "prelude" }
  >;
}

/** The open tabs to restore. Nothing unreadable is trusted: no record, another
 * version or a corrupt value restores nothing, and a malformed or duplicate
 * entry is skipped. */
export function storedTabs(env: AppEnv): StoredTabs {
  const none: StoredTabs = { tabs: [], activeTabId: null, unsavedPresets: [] };
  let record: Partial<OpenTabsRecord>;
  try {
    const raw = env.storage.getItem(OPEN_TABS_KEY);
    if (!raw) return none;
    record = JSON.parse(raw) as Partial<OpenTabsRecord>;
  } catch {
    // Private-mode denial, or a value that isn't JSON — start empty.
    return none;
  }
  if (record?.version !== OPEN_TABS_VERSION || !Array.isArray(record.tabs)) {
    return none;
  }

  const tabs: StoredTab[] = [];
  const ids = new Set<string>();
  let shortcuts = false;
  let presets = false;
  let prelude = false;
  for (const entry of record.tabs as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const t = entry as Record<string, unknown>;
    if (t.kind === "shortcuts" && !shortcuts) {
      shortcuts = true;
      tabs.push({ kind: "shortcuts" });
    } else if (t.kind === "presets" && !presets) {
      presets = true;
      tabs.push({ kind: "presets" });
    } else if (t.kind === "prelude" && !prelude) {
      prelude = true;
      tabs.push({ kind: "prelude" });
    } else if (
      t.kind === "query" &&
      typeof t.id === "string" &&
      typeof t.name === "string" &&
      typeof t.saved === "string" &&
      typeof t.live === "string" &&
      !ids.has(t.id)
    ) {
      ids.add(t.id);
      const persisted = t.persisted !== false;
      tabs.push({
        kind: "query",
        id: t.id,
        name: t.name,
        saved: definitionFromStored(t.saved),
        live: definitionFromStored(t.live),
        persisted,
        folder: typeof t.folder === "string" ? t.folder : null,
        ...(t.pristine === true && { pristine: true }),
      });
    } else if (
      t.kind === "playlist" &&
      typeof t.id === "string" &&
      typeof t.playlistId === "string" &&
      typeof t.name === "string" &&
      typeof t.saved === "string" &&
      typeof t.live === "string" &&
      !ids.has(t.id)
    ) {
      ids.add(t.id);
      tabs.push({
        kind: "playlist",
        id: t.id,
        playlistId: t.playlistId,
        name: t.name,
        saved: playlistDefinitionFromStored(t.saved),
        live: playlistDefinitionFromStored(t.live),
      });
    }
  }
  const active = record.activeTabId;
  return {
    tabs,
    activeTabId: typeof active === "string" ? active : null,
    unsavedPresets: Array.isArray(record.unsavedPresets)
      ? record.unsavedPresets
      : [],
  };
}

/** Writes the open tabs through, or clears the record once none are left. */
export function persistTabs(
  env: AppEnv,
  tabs: readonly Tab[],
  activeTabId: string | null,
  unsavedPresets: readonly Preset[],
): void {
  try {
    if (tabs.length === 0) {
      env.storage.removeItem(OPEN_TABS_KEY);
      return;
    }
    const record: OpenTabsRecord = {
      version: OPEN_TABS_VERSION,
      activeTabId,
      unsavedPresets: unsavedPresets.filter((preset) =>
        tabs.some(
          (t) =>
            (t.kind === "query" || t.kind === "playlist") &&
            usesPreset(t.live, preset.id),
        ),
      ),
      tabs: tabs.map((t): OpenTabsRecord["tabs"][number] => {
        switch (t.kind) {
          case "query":
            return {
              kind: "query",
              id: t.id,
              name: t.name,
              saved: definitionToStored(t.saved),
              live: definitionToStored(t.live),
              persisted: t.persisted,
              folder: t.folder,
              ...(t.pristine && { pristine: true }),
            };
          case "playlist":
            return {
              kind: "playlist",
              id: t.id,
              playlistId: t.playlistId,
              name: t.name,
              saved: playlistDefinitionToStored(t.saved),
              live: playlistDefinitionToStored(t.live),
            };
          case "shortcuts":
            return { kind: "shortcuts" };
          case "presets":
            return { kind: "presets" };
          case "prelude":
            return { kind: "prelude" };
        }
      }),
    };
    env.storage.setItem(OPEN_TABS_KEY, JSON.stringify(record));
  } catch {
    // Denied or over quota: this session just won't come back after a reload.
  }
}
