import type { JSX } from "react";
import { Icons } from "../icons";
import type { RpcErrorNotice } from "../stores/app";
import { useApp, useAppActions } from "../stores/react";
import IconButton from "./ui/IconButton";

/** What the user was doing when each JSON-RPC method failed, phrased to finish
 * "… failed." A method missing here falls back to naming the method. */
const ACTIONS: Record<string, string> = {
  "query.list": "Loading your queries",
  "query.add": "Saving the query",
  "query.update_definition": "Saving the query",
  "query.rename": "Renaming the query",
  "query.delete": "Deleting the query",
  "query.record_play": "Recording when the query was played",
  "preset.list": "Loading presets",
  "preset.add": "Saving the preset",
  "preset.update": "Saving the preset",
  "preset.delete": "Deleting the preset",
  "keybinding.list": "Loading keyboard shortcuts",
  "keybinding.set": "Saving the shortcut",
  "keybinding.delete": "Resetting the shortcut",
  "setting.list": "Loading settings",
  "setting.set": "Saving the setting",
  "setting.delete": "Resetting the setting",
  dml: "Writing to the database",
};

/** The failed-RPC bar itself, told which failure to show — so the visual
 * harness can put one on screen without a failing backend.
 * {@link RpcErrorBanner} is the wired version. */
export function RpcErrorBar(props: {
  notice: RpcErrorNotice;
  onDismiss: () => void;
}): JSX.Element {
  const { method, message, count } = props.notice;
  const action = ACTIONS[method] ?? `The ${method} request`;
  return (
    <div
      data-testid="rpc-error-banner"
      role="alert"
      className="bg-split-active border-edge flex shrink-0 items-center gap-2 border-t px-2 py-1.5"
    >
      <div className="min-w-0 flex-1 text-sm">
        <span className="text-danger font-medium">
          {action} failed{count > 1 ? ` (${count} times)` : ""}.
        </span>{" "}
        <span className="text-ink-weak break-words">{message}</span>
      </div>
      <IconButton
        icon={Icons.Close}
        label="Dismiss"
        onClick={() => props.onDismiss()}
      />
    </div>
  );
}

/** The failed-RPC bar, showing the most recent failure the app store recorded
 * (`reportRpcFailure`, fed by the generated client's `onRpcFailure` in
 * `createStores()`). Renders nothing when nothing has failed, or once the user
 * has dismissed it. The call site's own handling is unchanged: a failed record
 * save still says why in the editor, too. */
export default function RpcErrorBanner(): JSX.Element | null {
  const notice = useApp((s) => s.rpcError);
  const { dismissRpcError } = useAppActions();
  if (!notice) return null;
  return <RpcErrorBar notice={notice} onDismiss={dismissRpcError} />;
}
