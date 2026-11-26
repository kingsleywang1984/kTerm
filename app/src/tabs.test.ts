import { describe, expect, test } from "vitest";
import { TabStore, diffTargetFor, pinRefresh, statusParts, tabTitle } from "./tabs";

describe("tabTitle", () => {
  test("title prefers manual name", () => {
    expect(tabTitle({ id: 1, manualTitle: "api", cwd: "/r/x-2540" })).toBe("api");
  });
  test("manual name beats the program title", () => {
    expect(tabTitle({ id: 1, manualTitle: "api", programTitle: "✳ Fix login" })).toBe("api");
  });
  test("program title beats the cwd basename", () => {
    expect(tabTitle({ id: 1, programTitle: "✳ Fix login", cwd: "/r/my-app" })).toBe("✳ Fix login");
  });
  test("blank program title is ignored", () => {
    expect(tabTitle({ id: 1, programTitle: "  ", cwd: "/r/my-app" })).toBe("my-app");
  });
  test("title falls back to cwd basename", () => {
    expect(tabTitle({ id: 1, cwd: "/r/my-app-1234" })).toBe("my-app-1234");
  });
  test("title falls back to Terminal id", () => {
    expect(tabTitle({ id: 3 })).toBe("Terminal 3");
  });
});

describe("TabStore", () => {
  function storeWith(n: number) {
    const store = new TabStore();
    for (let i = 0; i < n; i++) store.add();
    return store;
  }

  test("removing active tab activates the previous one, else the next", () => {
    const store = storeWith(3);
    store.activate(2);
    expect(store.remove(2)).toBe(1);
    expect(store.remove(1)).toBe(3);
    expect(store.remove(3)).toBeUndefined();
  });

  test("update reports change only when a value differs", () => {
    const store = storeWith(1);
    expect(store.update(1, { cwd: "/a" })).toBe(true);
    expect(store.update(1, { cwd: "/a" })).toBe(false);
    expect(store.update(1, { branch: "main" })).toBe(true);
  });
});

describe("pinned diff target", () => {
  const pin = { target: { kind: "workTree" as const, dir: "/r/app-temp-2" }, label: "temp-2" };

  test("diff target prefers the pin", () => {
    expect(diffTargetFor({ id: 1, cwd: "/r/app", repoRoot: "/r/app", pin })).toEqual(pin.target);
  });

  test("diff target follows cwd inside a repo when not pinned", () => {
    expect(diffTargetFor({ id: 1, cwd: "/r/app/src", repoRoot: "/r/app" })).toEqual({ kind: "workTree", dir: "/r/app/src" });
  });

  test("diff target is undefined outside a repo", () => {
    expect(diffTargetFor({ id: 1, cwd: "/tmp" })).toBeUndefined();
  });
});

describe("statusParts", () => {
  test("shows path with home shortened and branch", () => {
    expect(statusParts({ id: 1, cwd: "/Users/k/repo", branch: "temp" }, "/Users/k")).toEqual(["~/repo", "⎇ temp"]);
  });

  test("shows the pinned worktree and its branch", () => {
    const pin = { target: { kind: "workTree" as const, dir: "/r/app-2" }, label: "temp-2" };
    expect(statusParts({ id: 1, cwd: "/r/app", branch: "temp", pin, pinnedBranch: "temp-3" }, "/Users/k")).toEqual([
      "/r/app",
      "⎇ temp",
      "📌 /r/app-2 ⎇ temp-3",
    ]);
  });

  test("is empty before the location is known", () => {
    expect(statusParts({ id: 1 }, "/Users/k")).toEqual([]);
  });
});

describe("statusParts without home", () => {
  test("keeps absolute paths when home is unknown", () => {
    expect(statusParts({ id: 1, cwd: "/Users/k/repo" }, "")).toEqual(["/Users/k/repo"]);
  });
});

describe("pinRefresh", () => {
  const pin = { target: { kind: "workTree" as const, dir: "/r/a" }, label: "a" };
  const other = { target: { kind: "workTree" as const, dir: "/r/b" }, label: "b" };

  test("ignores a result for a pin that has since changed", () => {
    expect(pinRefresh(pin, other, null)).toBeUndefined();
  });

  test("unpins when the worktree is gone", () => {
    expect(pinRefresh(pin, pin, null)).toEqual({ pin: undefined, pinnedBranch: undefined });
  });

  test("keeps the pin when the lookup failed", () => {
    expect(pinRefresh(pin, pin, undefined)).toBeUndefined();
  });

  test("records the worktree's current branch", () => {
    expect(pinRefresh(pin, pin, { branch: "feat" })).toEqual({ pinnedBranch: "feat" });
  });
});
