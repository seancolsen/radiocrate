// The two judgements behind a PWA client update — is this client stale, and may
// a downloaded update be applied without asking? — kept apart from the
// service-worker wiring that acts on them (`state/update.ts`).
//
// Both are pure functions of values passed in, which is what makes them
// testable: `update.ts` imports `virtual:pwa-register`, a module that only
// exists inside a Vite build, so nothing importable from a unit test can live
// there.

/** The build id a server reports when it has no embedded frontend to compare a
 * client against — `api_schema::DEV_BUILD_ID`. Two cases produce it: the
 * standalone dev server (whose client comes from Vite and is current by
 * definition), and a binary whose embedded `dist/` carries no `build-id.txt`
 * (a packaging fault, which the server warns about at startup). */
export const DEV_BUILD_ID = "dev";

/** Whether the running client didn't come from the running binary — the two
 * build ids differ.
 *
 * {@link DEV_BUILD_ID} from the server means *skip the check*, not "mismatch":
 * there is nothing to compare against, so the answer is no. The check fails open
 * on purpose. Reading that sentinel as a mismatch would make the update banner
 * permanent under `bun run dev` and would turn a packaging fault into a nag no
 * end user could act on. */
export function isClientStale(
  clientBuildId: string,
  serverBuildId: string,
): boolean {
  if (serverBuildId === DEV_BUILD_ID) return false;
  return clientBuildId !== serverBuildId;
}

/** What {@link shouldApplyNow} needs to know about the session: a narrow
 * snapshot rather than the store itself, so the policy stays a pure function of
 * four facts. `update.ts` builds one of these from the app store. */
export interface SessionState {
  /** Whether a track is playing (`store.state.playback.playing`). */
  playing: boolean;
  /** The ids of every open tab, in any order. */
  tabIds: readonly string[];
  /** Whether that tab's query has unsaved edits (`store.isUnsaved`). */
  tabUnsaved: (tabId: string) => boolean;
  /** Whether that tab holds record-editor forms with unsaved changes
   * (`modifiedRecords` from the record form stash). */
  recordsUnsaved: (tabId: string) => boolean;
}

/** Whether a waiting update may be applied silently, right now.
 *
 * Applying means reloading the page, so this is the question "would a reload
 * cost the user anything?" — and the answer is yes for any session that has
 * *anything* going on. Playback stops, unsaved record edits and unsaved query
 * definitions are lost, and, because open tabs are persisted nowhere
 * (`localStorage` holds only prefs), even a spotless tab is discarded. So the
 * last clause is the strict one: silent application is confined to a genuinely
 * empty session.
 *
 * That is true almost exactly at cold boot, which is the moment that matters —
 * the user restarts the server, opens the app, and the pending update lands
 * before they have done anything. Every other session routes to the banner
 * instead. (Persisting open tabs would let this relax considerably; noted in the
 * plan as the follow-up.)
 *
 * The earlier clauses are then redundant with the last one today, and kept
 * deliberately: they say what the policy is protecting, and they are what
 * remains meaningful if tab persistence ever lifts the empty-session
 * requirement. */
export function shouldApplyNow(session: SessionState): boolean {
  if (session.playing) return false;
  if (session.tabIds.some((id) => session.recordsUnsaved(id))) return false;
  if (session.tabIds.some((id) => session.tabUnsaved(id))) return false;
  return session.tabIds.length === 0;
}
