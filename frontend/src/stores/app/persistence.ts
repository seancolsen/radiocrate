import type { AudioQualityPref } from "../../audio/engine";
import {
  definitionFromStored,
  definitionToStored,
  type QueryDefinition,
} from "../../query/definition";
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

/** An open tab as a previous visit left it: a query tab with both of its
 * definitions (so unsaved edits survive), or the keyboard-shortcuts editor,
 * which carries nothing of its own. */
export type StoredTab =
  | {
      kind: "query";
      id: string;
      name: string;
      saved: QueryDefinition;
      live: QueryDefinition;
      persisted: boolean;
    }
  | { kind: "shortcuts" };

/** The open tabs a previous visit left, in tab-bar order, and the id of the one
 * that was active. */
export interface StoredTabs {
  tabs: StoredTab[];
  activeTabId: string | null;
}

const OPEN_TABS_KEY = "openTabs";
/** Bump when the record's shape changes incompatibly: a record of any other
 * version restores nothing. */
const OPEN_TABS_VERSION = 1;

/** The record as it sits in storage: definitions in their stored string form,
 * the same encoding the backend keeps a saved query in. */
interface OpenTabsRecord {
  version: number;
  activeTabId: string | null;
  tabs: Array<
    | {
        kind: "query";
        id: string;
        name: string;
        saved: string;
        live: string;
        persisted: boolean;
      }
    | { kind: "shortcuts" }
  >;
}

/** The open tabs to restore. Nothing unreadable is trusted: no record, another
 * version or a corrupt value restores nothing, and a malformed or duplicate
 * entry is skipped. */
export function storedTabs(env: AppEnv): StoredTabs {
  const none: StoredTabs = { tabs: [], activeTabId: null };
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
  for (const entry of record.tabs as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const t = entry as Record<string, unknown>;
    if (t.kind === "shortcuts" && !shortcuts) {
      shortcuts = true;
      tabs.push({ kind: "shortcuts" });
    } else if (
      t.kind === "query" &&
      typeof t.id === "string" &&
      typeof t.name === "string" &&
      typeof t.saved === "string" &&
      typeof t.live === "string" &&
      !ids.has(t.id)
    ) {
      ids.add(t.id);
      tabs.push({
        kind: "query",
        id: t.id,
        name: t.name,
        saved: definitionFromStored(t.saved),
        live: definitionFromStored(t.live),
        persisted: t.persisted !== false,
      });
    }
  }
  const active = record.activeTabId;
  return { tabs, activeTabId: typeof active === "string" ? active : null };
}

/** Writes the open tabs through, or clears the record once none are left. */
export function persistTabs(
  env: AppEnv,
  tabs: readonly Tab[],
  activeTabId: string | null,
): void {
  try {
    if (tabs.length === 0) {
      env.storage.removeItem(OPEN_TABS_KEY);
      return;
    }
    const record: OpenTabsRecord = {
      version: OPEN_TABS_VERSION,
      activeTabId,
      tabs: tabs.map((t) =>
        t.kind === "query"
          ? {
              kind: "query",
              id: t.id,
              name: t.name,
              saved: definitionToStored(t.saved),
              live: definitionToStored(t.live),
              persisted: t.persisted,
            }
          : { kind: "shortcuts" },
      ),
    };
    env.storage.setItem(OPEN_TABS_KEY, JSON.stringify(record));
  } catch {
    // Denied or over quota: this session just won't come back after a reload.
  }
}
