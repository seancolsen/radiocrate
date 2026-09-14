import { describe, expect, it } from "vitest";
import { createAppStore } from "./index";
import { fakeEnv } from "./testEnv";

describe("reportRpcFailure", () => {
  it("shows a failure, and counts up while the same one repeats", () => {
    const bundle = createAppStore(fakeEnv());
    bundle.actions.reportRpcFailure("query.rename", new Error("500 locked"));
    expect(bundle.store.getState().rpcError).toEqual({
      method: "query.rename",
      message: "500 locked",
      count: 1,
    });

    bundle.actions.reportRpcFailure("query.rename", new Error("500 locked"));
    expect(bundle.store.getState().rpcError?.count).toBe(2);
  });

  it("replaces the failure showing with a different one", () => {
    const bundle = createAppStore(fakeEnv());
    bundle.actions.reportRpcFailure("query.rename", new Error("500 locked"));
    bundle.actions.reportRpcFailure("setting.set", "Failed to fetch");
    expect(bundle.store.getState().rpcError).toEqual({
      method: "setting.set",
      message: "Failed to fetch",
      count: 1,
    });
  });

  // The update controller polls `app.version` in the background and handles
  // its own failures; a server that's briefly unreachable shouldn't raise a bar.
  it("ignores the background version check", () => {
    const bundle = createAppStore(fakeEnv());
    bundle.actions.reportRpcFailure("app.version", new Error("offline"));
    expect(bundle.store.getState().rpcError).toBeNull();
  });

  it("hides once dismissed", () => {
    const bundle = createAppStore(fakeEnv());
    bundle.actions.reportRpcFailure("dml", new Error("constraint failed"));
    bundle.actions.dismissRpcError();
    expect(bundle.store.getState().rpcError).toBeNull();
  });
});
