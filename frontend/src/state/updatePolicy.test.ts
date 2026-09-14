import { describe, expect, it } from "vitest";
import {
  DEV_BUILD_ID,
  isClientStale,
  shouldApplyNow,
  type SessionState,
} from "./updatePolicy";

/** A session a reload costs nothing: no playback, no unsaved record edits.
 * Each case below changes one thing about it. */
function idleSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    playing: false,
    tabIds: [],
    recordsUnsaved: () => false,
    ...overrides,
  };
}

describe("shouldApplyNow", () => {
  it("applies in an empty, idle session (the cold-boot case)", () => {
    expect(shouldApplyNow(idleSession())).toBe(true);
  });

  // Open tabs — unsaved query edits included — are kept in localStorage and
  // come back after the reload, so they don't hold an update back.
  it("applies with tabs open, which a reload restores", () => {
    expect(shouldApplyNow(idleSession({ tabIds: ["tab-1", "tab-2"] }))).toBe(
      true,
    );
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

  it("checks every open tab for record edits, not just one", () => {
    const session = idleSession({
      tabIds: ["tab-1", "tab-2", "tab-3"],
      recordsUnsaved: (tabId) => tabId === "tab-3",
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
