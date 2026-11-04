import { useEffect, useState, useSyncExternalStore } from "react";
import {
  DIAGNOSTIC_SETTLE_MS,
  nextShown,
  sameDiagnostic,
  type QueryDiagnostic,
} from "../../query/diagnostics";
import { querydownLoaded, querydownReady } from "../../query/querydown";
import { selectPrelude } from "../../stores/app";
import { useApp } from "../../stores/react";

/** Subscribes to the compiler finishing its load (starting it, if nothing has
 * yet): it's loaded once, and never unloads. */
function subscribeLoaded(onLoad: () => void): () => void {
  let live = true;
  void querydownReady().then(() => {
    if (live) onLoad();
  });
  return () => {
    live = false;
  };
}

/** What checking Querydown as it's typed needs: the schema, and the prelude
 * in force — or `undefined` until both the schema and the compiler have
 * loaded, when there's no checking anything. */
export function useCheckContext():
  { schemaJson: string; prelude: string } | undefined {
  const loaded = useSyncExternalStore(subscribeLoaded, querydownLoaded);
  const schemaJson = useApp((s) => s.schema.json);
  const prelude = useApp(selectPrelude);
  return loaded && schemaJson !== undefined
    ? { schemaJson, prelude }
    : undefined;
}

/** The problem to show for text being edited, given `latest`, the problem
 * with it as it stands (or `null`): slow to complain, quick to forgive, as
 * the query page's error strip is (see `nextShown`). A problem there from the
 * start — an editor opened on broken text — shows at once. */
export function useSettledDiagnostic(
  latest: QueryDiagnostic | null,
): QueryDiagnostic | null {
  const [shown, setShown] = useState(latest);
  const next = nextShown(shown, latest);
  // Showing what doesn't wait — a fix, or the same problem moved along — is
  // remembered at once, so a problem that comes back after it was fixed waits
  // all over again.
  if (!next.settle && !sameDiagnostic(next.show, shown)) setShown(next.show);
  useEffect(() => {
    if (!next.settle) return;
    const timer = setTimeout(() => setShown(latest), DIAGNOSTIC_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [latest, next.settle]);
  return next.show;
}
