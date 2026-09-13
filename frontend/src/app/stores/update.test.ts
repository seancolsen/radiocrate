import { describe, expect, it, vi } from "vitest";

// `update.ts` imports `virtual:pwa-register`, a module that only exists
// inside a Vite build (same reason `state/updatePolicy.ts` keeps its pure
// judgments out of `state/update.ts`, per that file's own top comment) — so
// this has to be mocked before the module under test can even load. Vitest
// hoists `vi.mock` above the imports below, same as `actions.test.ts`'s
// mocks of `api-client`.
vi.mock("virtual:pwa-register", () => ({
  registerSW: vi.fn(() => vi.fn()),
}));

import { selectUpdateNotice } from "./update";

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
