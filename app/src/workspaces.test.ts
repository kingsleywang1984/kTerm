import { describe, expect, test } from "vitest";
import { WorkspaceStore, workspaceName } from "./workspaces";

describe("WorkspaceStore", () => {
  test("new workspace has a default name that rename overrides", () => {
    const store = new WorkspaceStore();
    const ws = store.addWorkspace();
    expect(workspaceName(ws)).toBe("Workspace 1");
    ws.name = "api";
    expect(workspaceName(ws)).toBe("api");
  });

  test("terminal ids are unique across workspaces", () => {
    const store = new WorkspaceStore();
    const a = store.addTerminal(store.addWorkspace().id);
    const b = store.addTerminal(store.addWorkspace().id);
    expect(a.id).not.toBe(b.id);
    expect(store.workspaceOf(b.id)?.id).toBe(2);
  });

  test("closing the last terminal removes its workspace and activates a neighbour", () => {
    const store = new WorkspaceStore();
    const first = store.addWorkspace();
    store.addTerminal(first.id);
    const second = store.addWorkspace();
    const only = store.addTerminal(second.id);
    store.activate(second.id);
    store.removeTerminal(only.id);
    expect(store.all().map((w) => w.id)).toEqual([first.id]);
    expect(store.active()?.id).toBe(first.id);
  });

  test("closing a terminal keeps the workspace while others remain", () => {
    const store = new WorkspaceStore();
    const ws = store.addWorkspace();
    const a = store.addTerminal(ws.id);
    const b = store.addTerminal(ws.id);
    store.removeTerminal(b.id);
    expect(store.active()?.id).toBe(ws.id);
    expect(store.activeTerminal()?.id).toBe(a.id);
  });

  test("cycle moves through terminals of the active workspace and wraps", () => {
    const store = new WorkspaceStore();
    const ws = store.addWorkspace();
    const a = store.addTerminal(ws.id);
    const b = store.addTerminal(ws.id);
    expect(store.cycle(1)?.id).toBe(a.id);
    expect(store.cycle(-1)?.id).toBe(b.id);
  });
});
