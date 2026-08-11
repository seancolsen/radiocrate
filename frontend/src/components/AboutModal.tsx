import { createSignal, onMount, Show, type JSX } from "solid-js";
import type { AppVersion } from "api-client";
import { useAppState } from "../state/store";
import {
  checkForUpdate,
  clientBuildId,
  resetAppData,
  versionInfo,
} from "../state/update";
import { DEV_BUILD_ID, isClientStale } from "../state/updatePolicy";
import { Modal } from "./ui/Modal";

/** One label/value row of the version table. */
function Row(props: { label: string; value: string }): JSX.Element {
  return (
    <>
      <dt class="text-ink-weak text-sm">{props.label}</dt>
      <dd class="text-ink font-mono text-xs break-all">{props.value}</dd>
    </>
  );
}

/** What the panel says about the two build ids — the whole point of showing
 * them. Kept as its own component so the wording for "no answer yet" and for a
 * dev server (which has no embedded client to compare against, so staleness is
 * unanswerable rather than false) sit next to each other. */
function VersionVerdict(props: {
  clientBuildId: string;
  version: AppVersion | undefined;
  checking: boolean;
}): JSX.Element {
  return (
    <Show
      when={props.version}
      fallback={
        <p class="text-ink-weak mt-3 text-sm">
          {props.checking ? "Checking…" : "Couldn’t reach the server."}
        </p>
      }
    >
      {(version) => (
        <Show
          when={version().buildId !== DEV_BUILD_ID}
          fallback={
            <p class="text-ink-weak mt-3 text-sm">
              Development server — it serves no embedded client, so there is
              nothing to compare against.
            </p>
          }
        >
          <Show
            when={isClientStale(props.clientBuildId, version().buildId)}
            fallback={
              <p class="text-ink-weak mt-3 text-sm">
                This client is up to date.
              </p>
            }
          >
            <p class="text-danger mt-3 text-sm font-medium">
              This client didn’t come from the server that’s running. Reload to
              get the current one.
            </p>
          </Show>
        </Show>
      )}
    </Show>
  );
}

/** The About dialog: which client this is, which binary is serving it, and
 * whether those two agree — the first thing to look at when a client seems
 * stuck on an old build. Takes its values as props (rather than reading the
 * update controller) so the visual harness can pin them; {@link AboutModal} is
 * the wired version.
 *
 * "Reload fresh copy" is the escape hatch: it drops the service worker and its
 * caches and reloads. The name is deliberate — it touches nothing on the server
 * and no user data, and a name like "Reset app data" would stop anyone from
 * pressing it. It still confirms, because it closes open tabs and a click here
 * can be exploratory. */
export function AboutDialog(props: {
  clientBuildId: string;
  version: AppVersion | undefined;
  checking?: boolean;
  onCheck: () => void;
  onReloadFresh: () => void;
  onClose: () => void;
}): JSX.Element {
  const [confirming, setConfirming] = createSignal(false);

  return (
    <Modal onClose={() => props.onClose()} width="420px">
      <h2 class="text-ink mb-3 text-base font-semibold">About RadioCrate</h2>
      <dl class="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-1">
        <Row
          label="Server version"
          value={props.version?.serverVersion ?? "—"}
        />
        <Row label="Server build" value={props.version?.buildId ?? "—"} />
        <Row label="This client" value={props.clientBuildId} />
      </dl>
      <VersionVerdict
        clientBuildId={props.clientBuildId}
        version={props.version}
        checking={props.checking ?? false}
      />
      <Show
        when={confirming()}
        fallback={
          <div class="mt-4 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              class="text-ink hover:bg-hover rounded-md px-3 py-1.5 text-sm"
              onClick={() => setConfirming(true)}
            >
              Reload fresh copy
            </button>
            <button
              type="button"
              disabled={props.checking ?? false}
              class="text-ink hover:bg-hover rounded-md px-3 py-1.5 text-sm disabled:opacity-40"
              onClick={() => props.onCheck()}
            >
              Check for updates
            </button>
            <button
              type="button"
              class="bg-accent text-panel rounded-md px-3 py-1.5 text-sm"
              onClick={() => props.onClose()}
            >
              Close
            </button>
          </div>
        }
      >
        <p class="text-ink mt-4 text-sm">
          Download the app again from the server?{" "}
          <span class="text-ink-weak">
            Nothing on the server changes, and no settings are lost — but open
            tabs will close.
          </span>
        </p>
        <div class="mt-3 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            class="text-ink hover:bg-hover rounded-md px-3 py-1.5 text-sm"
            onClick={() => setConfirming(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            class="bg-accent text-panel rounded-md px-3 py-1.5 text-sm"
            onClick={() => props.onReloadFresh()}
          >
            Reload fresh copy
          </button>
        </div>
      </Show>
    </Modal>
  );
}

/** The About dialog wired to the update controller and the store's open flag —
 * raised by the Settings menu and by the `app.check_for_updates` command.
 *
 * Opening it runs a check, so the ids on screen are the current answer rather
 * than whatever the last foreground check left behind; the button re-runs the
 * same thing on demand. */
function AboutModalBody(): JSX.Element {
  const store = useAppState();
  const [checking, setChecking] = createSignal(false);

  const check = async () => {
    setChecking(true);
    try {
      await checkForUpdate();
    } finally {
      setChecking(false);
    }
  };

  onMount(() => void check());

  return (
    <AboutDialog
      clientBuildId={clientBuildId()}
      version={versionInfo()}
      checking={checking()}
      onCheck={() => void check()}
      onReloadFresh={() => void resetAppData()}
      onClose={() => store.closeAbout()}
    />
  );
}

/** The About dialog's mount point: an app-wide overlay, like the command
 * palette. */
export default function AboutModal(): JSX.Element {
  const store = useAppState();
  return (
    <Show when={store.state.aboutOpen}>
      <AboutModalBody />
    </Show>
  );
}
