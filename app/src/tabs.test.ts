import { describe, expect, test } from "vitest";
import { TabStore, tabTitle } from "./tabs";

describe("tabTitle", () => {
  test("title prefers manual name", () => {
    expect(tabTitle({ id: 1, manualTitle: "api", cwd: "/r/x-2540" })).toBe("api");
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

  test("byIndex maps Cmd+N to list order", () => {
    const store = storeWith(3);
    store.remove(1);
    expect(store.byIndex(0)?.id).toBe(2);
  });

  test("update reports change only when a value differs", () => {
    const store = storeWith(1);
    expect(store.update(1, { cwd: "/a" })).toBe(true);
    expect(store.update(1, { cwd: "/a" })).toBe(false);
    expect(store.update(1, { branch: "main" })).toBe(true);
  });
});
