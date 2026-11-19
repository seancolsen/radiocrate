import type { JSX } from "react";
import { useAppActions } from "../stores/react";

/** What a new query shows where its rows would be, until the user touches it
 * (`QueryTab.pristine`): a "Show all results" button, for when every row of
 * the base is what's wanted after all. The base itself is picked where it
 * always is, in the wrench menu's "Base ▸" — which doesn't count as touching
 * the query either. */
export default function NewQueryPrompt(props: { tabId: string }): JSX.Element {
  const { runQuery } = useAppActions();

  return (
    <div
      data-testid="new-query-prompt"
      className="bg-panel flex min-h-0 flex-1 flex-col items-center overflow-auto px-4 pt-10"
    >
      <button
        type="button"
        className="control text-ink border-edge hover:bg-hover rounded-md"
        onClick={() => runQuery(props.tabId)}
      >
        Show all results
      </button>
    </div>
  );
}
