// The two judgements behind a PWA client update — is this client stale, and may
// a downloaded update be applied without asking? — kept apart from the
// service-worker wiring that acts on them (`stores/update.ts`).
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
 * snapshot rather than the stores themselves, so the policy stays a pure
 * function of the facts that matter. `update.ts` builds one from the app and
 * forms stores. */
export interface SessionState {
  /** Whether a track is playing. */
  playing: boolean;
  /** The ids of every open tab, in any order. */
  tabIds: readonly string[];
  /** Whether that tab holds record-editor forms with unsaved changes
   * (`selectModifiedRecords` over the forms store). */
  recordsUnsaved: (tabId: string) => boolean;
}

/** Whether a waiting update may be applied silently, right now.
 *
 * Applying means reloading the page, so this is the question "would a reload
 * cost the user anything?" Open tabs don't: they're kept in `localStorage` —
 * each query's working definition and never-saved duplicates included — so a
 * reload brings them back, each re-running its query when it's next viewed.
 * What a reload does lose is playback, which stops, and unsaved record-editor
 * edits, which live only in memory. Either one routes the update to the banner
 * instead. */
export function shouldApplyNow(session: SessionState): boolean {
  if (session.playing) return false;
  return !session.tabIds.some((id) => session.recordsUnsaved(id));
}
