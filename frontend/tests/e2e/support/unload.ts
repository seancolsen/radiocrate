// While a page is being torn down for a reload, the requests it still had in
// flight are aborted, and the app logs each as it fails ("Failed to fetch",
// "WebAssembly compilation aborted"). That's the browser leaving the page, not
// the app misbehaving, so the error guard lets those through — but only while
// `App.reload` has a reload under way.

import type { Page } from "@playwright/test";

const unloading = new WeakSet<Page>();

/** Runs `reload` with `page` marked as unloading. */
export async function duringUnload(
  page: Page,
  reload: () => Promise<unknown>,
): Promise<void> {
  unloading.add(page);
  try {
    await reload();
  } finally {
    unloading.delete(page);
  }
}

/** Whether `text`, logged by `page`, is a request aborted by a reload in
 * progress. */
export function abortedByUnload(page: Page, text: string): boolean {
  return (
    unloading.has(page) &&
    /Failed to fetch|aborted|NetworkError|Load failed/i.test(text)
  );
}
