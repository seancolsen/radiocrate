import { describe, expect, it } from "vitest";
import {
  DEV_BUILD_ID,
  isClientStale,
  shouldApplyNow,
  type SessionState,
} from "./updatePolicy";

/** A session with nothing going on — cold boot, the one state that permits a
 * silent update. Each case below spoils exactly one thing about it. */
function idleSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    playing: false,
    tabIds: [],
    tabUnsaved: () => false,
    recordsUnsaved: () => false,
    ...overrides,
  };
}

describe("shouldApplyNow", () => {
  it("applies in an empty, idle session (the cold-boot case)", () => {
    expect(shouldApplyNow(idleSession())).toBe(true);
  });

  it("holds off while a track is playing", () => {
    expect(shouldApplyNow(idleSession({ playing: true }))).toBe(false);
  });

  it("holds off with unsaved record edits", () => {
    const session = idleSession({
      tabIds: ["tab-1"],
      recordsUnsaved: (tabId) => tabId === "tab-1",
    });
    expect(shouldApplyNow(session)).toBe(false);
  });

  it("holds off with an unsaved query definition", () => {
    const session = idleSession({
      tabIds: ["tab-1"],
      tabUnsaved: (tabId) => tabId === "tab-1",
    });
    expect(shouldApplyNow(session)).toBe(false);
  });

  // The clause that's easy to leave out and the reason auto-apply isn't a
  // hostile surprise: open tabs are persisted nowhere, so a reload discards
  // them even when it interrupts nothing.
  it("holds off for an open tab with nothing unsaved in it", () => {
    expect(shouldApplyNow(idleSession({ tabIds: ["tab-1"] }))).toBe(false);
  });

  it("checks every open tab, not just one", () => {
    const session = idleSession({
      tabIds: ["tab-1", "tab-2", "tab-3"],
      tabUnsaved: (tabId) => tabId === "tab-3",
    });
    expect(shouldApplyNow(session)).toBe(false);
  });
});

describe("isClientStale", () => {
  it("is stale when the ids differ", () => {
    expect(isClientStale("abc1234", "def5678")).toBe(true);
  });

  it("is not stale when the ids match", () => {
    expect(isClientStale("abc1234", "abc1234")).toBe(false);
  });

  // The trap: the server's dev sentinel means "no embedded frontend to compare
  // against, skip the check", not "mismatch". Reading it the other way makes the
  // banner permanent under `bun run dev`.
  it("skips the check when the server reports the dev sentinel", () => {
    expect(isClientStale("abc1234", DEV_BUILD_ID)).toBe(false);
    expect(isClientStale(`abc1234-dev-${Date.now()}`, DEV_BUILD_ID)).toBe(
      false,
    );
  });

  // A client built off a dirty tree carries a `-dev-<epoch>` suffix of its own.
  // That says nothing about the server, so it's compared like any other id.
  it("still compares a dirty-tree client id against a real server id", () => {
    expect(isClientStale("abc1234-dev-111", "abc1234-dev-222")).toBe(true);
    expect(isClientStale("abc1234-dev-111", "abc1234-dev-111")).toBe(false);
  });
});
