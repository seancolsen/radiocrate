import { afterEach, describe, expect, it, vi } from "vitest";

// `update.ts` imports `virtual:pwa-register`, a module that only exists
// inside a Vite build (same reason `state/updatePolicy.ts` keeps its pure
// judgments out of `state/update.ts`, per that file's own top comment) — so
// this has to be mocked before the module under test can even load. Vitest
// hoists `vi.mock` above the imports below, same as `actions.test.ts`'s
// mocks of `api-client`.
vi.mock("virtual:pwa-register", () => ({
  registerSW: vi.fn(() => vi.fn()),
}));

import { registerSW } from "virtual:pwa-register";
import type { AppStoreBundle } from "./app";
import type { FormsStoreBundle } from "./forms";
import { createUpdateStore, selectUpdateNotice } from "./update";

describe("selectUpdateNotice", () => {
  it("is null when nothing is ready or stale", () => {
    expect(
      selectUpdateNotice({
        ready: false,
        stale: false,
        version: undefined,
        dismissed: false,
      }),
    ).toBeNull();
  });

  it('is "ready" once a new client is waiting, until dismissed', () => {
    expect(
      selectUpdateNotice({
        ready: true,
        stale: false,
        version: undefined,
        dismissed: false,
      }),
    ).toBe("ready");
    expect(
      selectUpdateNotice({
        ready: true,
        stale: false,
        version: undefined,
        dismissed: true,
      }),
    ).toBeNull();
  });

  it('"stale" takes precedence over "ready", and is never dismissible', () => {
    expect(
      selectUpdateNotice({
        ready: true,
        stale: true,
        version: undefined,
        dismissed: false,
      }),
    ).toBe("stale");
    // Dismissing has no effect on the stale banner.
    expect(
      selectUpdateNotice({
        ready: true,
        stale: true,
        version: undefined,
        dismissed: true,
      }),
    ).toBe("stale");
    // Stale even with nothing downloaded yet.
    expect(
      selectUpdateNotice({
        ready: false,
        stale: true,
        version: undefined,
        dismissed: false,
      }),
    ).toBe("stale");
  });
});

describe("a waiting worker (onNeedRefresh)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(registerSW).mockClear();
  });

  /** Registers an update store with a busy session (a track playing, so
   * nothing applies silently), in a page that some worker does or doesn't
   * control, and reports a waiting worker to it. */
  function needRefresh(controlled: boolean) {
    const updateSW = vi.fn(() => Promise.resolve());
    vi.mocked(registerSW).mockReturnValue(updateSW);
    vi.stubGlobal("navigator", {
      serviceWorker: { controller: controlled ? {} : null },
    });
    vi.stubGlobal("document", { addEventListener: vi.fn() });
    vi.stubGlobal("window", {});
    const app = {
      store: { getState: () => ({ playback: { playing: true }, tabs: [] }) },
    } as unknown as AppStoreBundle;
    const forms = {} as FormsStoreBundle;
    const { store, actions } = createUpdateStore(app, forms);
    actions.initUpdates();
    vi.mocked(registerSW).mock.calls[0]![0]!.onNeedRefresh!();
    return { notice: selectUpdateNotice(store.getState()), updateSW };
  }

  it('offers it as "ready" to a page the old worker controls', () => {
    expect(needRefresh(true).notice).toBe("ready");
  });

  // A page loaded around the worker (a hard reload) is already current, and
  // activating the worker wouldn't reload it: the banner's button would do
  // nothing. Another window still on the old worker is what keeps it waiting.
  it("leaves it alone in a page no worker controls", () => {
    const { notice, updateSW } = needRefresh(false);
    expect(notice).toBeNull();
    expect(updateSW).not.toHaveBeenCalled();
  });
});
