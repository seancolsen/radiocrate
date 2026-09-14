import type { JSX } from "react";
import { Icons } from "../icons";
import { selectUpdateNotice } from "../stores/update";
import { useUpdate, useUpdateActions } from "../stores/react";
import IconButton from "./ui/IconButton";

/** The update bar itself, told which notice to show and what its button does —
 * so the visual harness can put either notice on screen without a service
 * worker. {@link UpdateBanner} is the wired version.
 *
 * Both notices say the reload closes open tabs, because it does: tabs are
 * persisted nowhere, so any reload discards them (the same fact behind
 * `shouldApplyNow`'s empty-session rule). Only `"ready"` carries a dismiss
 * button — a stale client may already be talking to an API it doesn't match, so
 * that notice stays put (`dismissUpdate` refuses it anyway). */
export function UpdateBar(props: {
  notice: "stale" | "ready";
  onReload: () => void;
  onDismiss: () => void;
}): JSX.Element {
  return (
    <div
      data-testid="update-banner"
      role="status"
      className="bg-split-active border-edge flex shrink-0 items-center gap-2 border-t px-2 py-1.5"
    >
      <div className="min-w-0 flex-1 text-sm">
        {props.notice === "stale" ? (
          <span className="text-danger font-medium">
            This client is out of date and may not work correctly.
          </span>
        ) : (
          <span className="text-ink">
            A new version of RadioCrate is ready.
          </span>
        )}{" "}
        <span className="text-ink-weak">Reloading closes open tabs.</span>
      </div>
      <button
        type="button"
        className="bg-accent text-panel shrink-0 rounded-md px-3 py-1.5 text-sm"
        onClick={() => props.onReload()}
      >
        {props.notice === "stale" ? "Reload fresh copy" : "Reload"}
      </button>
      {props.notice === "ready" && (
        <IconButton
          icon={Icons.Close}
          label="Dismiss"
          onClick={() => props.onDismiss()}
        />
      )}
    </div>
  );
}

/** The update bar, driven by the update controller: one selector,
 * {@link selectUpdateNotice}, which already folds in the dismissal and
 * non-dismissibility rules. Renders nothing when there's nothing to say.
 *
 * The two notices need different actions. `"ready"` means a worker is waiting,
 * so `applyUpdate()` has something to activate. `"stale"` only means the server
 * has moved on from this client — it fires whether or not a new worker has
 * reached `waiting`, so `applyUpdate()` would be a dead button in exactly the
 * case the notice exists to catch (an SW update blocked, in flight, or wedged).
 * That one gets `resetAppData()`, which tears the worker and its caches down
 * and reloads regardless.
 *
 * No confirm in front of either: the bar states the consequence, and the user
 * pressed a button that says "Reload". The About panel's copy of the escape
 * hatch does confirm, because a click there can be exploratory. */
export default function UpdateBanner(): JSX.Element | null {
  const notice = useUpdate(selectUpdateNotice);
  const actions = useUpdateActions();
  if (!notice) return null;
  return (
    <UpdateBar
      notice={notice}
      onReload={() => {
        if (notice === "ready") actions.applyUpdate();
        else void actions.resetAppData();
      }}
      onDismiss={() => actions.dismissUpdate()}
    />
  );
}
