import type { JSX } from "react";
import { selectQueryTab } from "../stores/app";
import { useApp, useAppActions } from "../stores/react";

/** What a new query shows where its rows would be, until the user touches it
 * (`QueryTab.pristine`): its base table, to pick before building on it — which
 * neither runs the query nor counts as touching it — and a "Show all results"
 * button, for when every row of the base is what's wanted after all. */
export default function NewQueryPrompt(props: { tabId: string }): JSX.Element {
  const tables = useApp((s) => s.schema.tables);
  const base = useApp(
    (s) => selectQueryTab(s, props.tabId)?.live.base.trim() ?? "",
  );
  const { setBase, runQuery } = useAppActions();
  const selectId = `new-query-base-${props.tabId}`;
  // Until the schema loads, the base the query already has is the only choice.
  const names = tables.some((t) => t.name === base)
    ? tables.map((t) => t.name)
    : [base, ...tables.map((t) => t.name)];

  return (
    <div
      data-testid="new-query-prompt"
      className="bg-panel flex min-h-0 flex-1 flex-col items-center gap-4 overflow-auto px-4 pt-10"
    >
      <div className="flex items-center gap-3">
        <label htmlFor={selectId} className="text-ink text-sm">
          Base
        </label>
        <select
          id={selectId}
          className="control bg-panel border-edge text-ink focus:border-accent h-[26px] rounded-md py-0 outline-none"
          value={base}
          onChange={(e) => setBase(props.tabId, e.currentTarget.value)}
        >
          {names.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
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
