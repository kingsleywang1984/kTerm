// @vitest-environment jsdom
import { expect, test } from "vitest";
import { TabBar } from "./tab-bar";
import { WorkspaceStore } from "./workspaces";

test("re-rendering keeps existing tab elements so double-click survives a select", () => {
  const store = new WorkspaceStore();
  const ws = store.addWorkspace();
  const first = store.addTerminal(ws.id);
  store.addTerminal(ws.id);
  const el = document.createElement("div");
  const bar = new TabBar(el, { select: () => {}, rename: () => {} });
  bar.render(ws);
  const before = el.children[0];
  ws.tabs.activate(first.id);
  bar.render(ws);
  expect(el.children[0]).toBe(before);
  expect(before.classList.contains("active")).toBe(true);
});

test("a tab closed during a rename disappears once the rename ends", () => {
  const store = new WorkspaceStore();
  const ws = store.addWorkspace();
  store.addTerminal(ws.id);
  const closing = store.addTerminal(ws.id);
  const el = document.createElement("div");
  const bar = new TabBar(el, { select: () => {}, rename: () => {} });
  bar.render(ws);
  el.querySelector("span")!.dispatchEvent(new MouseEvent("dblclick"));
  store.removeTerminal(closing.id);
  bar.render(ws);
  el.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(el.children.length).toBe(1);
});
