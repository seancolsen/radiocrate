import { Icons } from "../icons";
import { useAppState } from "../state/store";

/** The query-page toolbar: a thin bar under the tab bar on the panel surface,
 * with a hairline bottom divider. This phase it holds exactly one control — a
 * refresh button that re-runs the active tab's saved query (§6). No wrench,
 * Filter/Sort/Display, ⋮, or "N results". */
export default function QueryToolbar(props: { tabId: string }) {
  const store = useAppState();
  return (
    <div class="bg-panel border-edge flex h-[38px] shrink-0 items-center border-b px-1.5">
      <button
        type="button"
        aria-label="Refresh"
        class="text-ink-weak hover:bg-hover hover:text-ink flex size-7 items-center justify-center rounded"
        onClick={() => store.runQuery(props.tabId)}
      >
        <Icons.Refresh class="size-5" />
      </button>
    </div>
  );
}
