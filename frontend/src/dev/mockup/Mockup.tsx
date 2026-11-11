import { useLayoutEffect, useRef, type JSX } from "react";
import type { Theme } from "../themedPage";
import type { Stores } from "../../stores/createStores";
import { IDLE_PLAYBACK } from "../../stores/app";
import { useApp, useStores } from "../../stores/react";
import { FILTER_DEF, PLAYLIST_SOURCE, SOURCES_FIXTURE } from "../fixtures";
import { lemonadeGridResult } from "../gridFixture";
import { FIXTURE_SCHEMA_JSON, installRecordFixture } from "../recordFixture";
import TabBar from "../../components/TabBar";
import QueryToolbar from "../../components/QueryToolbar";
import QueryResults from "../../components/QueryResults";
import RecordEditorPanel from "../../components/RecordEditorPanel";
import NowPlaying from "../../components/NowPlaying";

// The mockup: a miniature of the whole app, for seeing the colors that only
// show in place — the tab bar's active edge, the toolbar's open section, the
// canvas-painted results (artist pills, the selected row, the playing row's
// ring), the record editor on the selected track, and the now-playing bar —
// over the dev harness's stand-in backend, seeded the way its stories seed it.
// Deliberately not snapshot-tested: it's for looking at, and a full-app shot
// would churn with every layout change.

const [LEMONADE] = SOURCES_FIXTURE;
const TRACKS = ["track-1", "track-2", "track-3", "track-4", "track-5"];

function seed(stores: Stores): void {
  const { actions } = stores.app;
  actions.setSchemaJson(FIXTURE_SCHEMA_JSON);
  // The timeline's cached-audio overlay only draws while logging is on.
  stores.app.store.setState((s) => {
    s.logging = true;
  });
  installRecordFixture(0);

  // A playlist tab behind the active one, and the active one's filter open
  // (the toggle's on state, its preset tab). Deliberately without a problem:
  // that dims the results, and the specimens above show its colors already.
  actions.openTab(PLAYLIST_SOURCE);
  actions.openTab({ id: LEMONADE.id, name: LEMONADE.name, definition: "" });
  const id = LEMONADE.id;
  actions.setTabDefinitions(id, FILTER_DEF, FILTER_DEF);
  actions.toggleBuilderSection(id, "filter");

  const { result, lineage } = lemonadeGridResult({
    recordKeys: { track: TRACKS },
  });
  actions.setResults(id, result, lineage);
  actions.clickRow(id, 2, { shift: false, ctrl: false });
  actions.setRecordEditorRecords(id, "track", [
    { table: "track", key: [{ column: "id", value: "track-3" }] },
  ]);
  actions.seedNowPlaying(
    {
      sourceTabId: id,
      id: "track-1",
      rowIndex: 0,
      title: "Pray You Catch Me",
      artists: ["Beyoncé"],
    },
    {
      ...IDLE_PLAYBACK,
      playing: true,
      position: 74,
      duration: 196,
      hasNext: true,
      buffered: [[0, 150]],
    },
  );
}

function AppInMiniature(): JSX.Element | null {
  const stores = useStores();
  // As in the harness: the seed builds on the canned query and preset lists,
  // so it waits for both, then runs once, before paint.
  const queriesReady = useApp((s) => s.sources.status === "ready");
  const presetsReady = useApp((s) => s.presetsStatus === "ready");
  const seeded = useRef(false);
  useLayoutEffect(() => {
    if (!queriesReady || !presetsReady || seeded.current) return;
    seeded.current = true;
    seed(stores);
  }, [queriesReady, presetsReady, stores]);
  if (!queriesReady || !presetsReady) return null;

  return (
    <div className="border-edge flex h-[600px] flex-col overflow-hidden rounded-md border">
      <TabBar />
      <div className="bg-panel flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <QueryToolbar tabId={LEMONADE.id} />
          <QueryResults tabId={LEMONADE.id} />
        </div>
        <RecordEditorPanel tabId={LEMONADE.id} />
      </div>
      <NowPlaying />
    </div>
  );
}

export default function Mockup(props: { theme: Theme }): JSX.Element {
  const other: Theme = props.theme === "light" ? "dark" : "light";
  return (
    <div className="bg-panel text-ink">
      <header className="flex items-baseline gap-3 px-4 pt-3 pb-2">
        <h1 className="text-base font-semibold capitalize">{props.theme}</h1>
        <a
          className="text-ink-weak text-xs underline"
          href={`?theme=${props.theme}`}
          target="_top"
        >
          alone
        </a>
        <a
          className="text-ink-weak text-xs underline"
          href={`?theme=${other}`}
          target="_top"
        >
          {other} alone
        </a>
        <a className="text-ink-weak text-xs underline" href="?" target="_top">
          side by side
        </a>
        <a
          className="text-ink-weak text-xs underline"
          href="/kitchen-sink.html"
          target="_top"
        >
          kitchen sink
        </a>
      </header>
      <div className="px-4 pb-4">
        <AppInMiniature />
      </div>
    </div>
  );
}
