import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DiffTarget, tabLocation } from "./api";
import type { DiffView } from "./diff-view";
import { GitPanel } from "./git-panel";
import { Sidebar } from "./sidebar";
import { TabStore, tabTitle } from "./tabs";
import { TerminalTab } from "./terminal-tab";

const LOCATION_POLL_MS = 3000;

const store = new TabStore();
const terminals = new Map<number, TerminalTab>();
const container = document.getElementById("terminals")!;
const sidebar = new Sidebar(document.getElementById("tabs")!, {
  select: activate,
  close: closeTab,
  diff: (id) => {
    activate(id);
    openTabDiff(id);
  },
  rename: (id, title) => {
    store.update(id, { manualTitle: title });
  },
});

async function newTab(): Promise<TerminalTab> {
  const info = store.add();
  const terminal = new TerminalTab(info.id, container);
  terminals.set(info.id, terminal);
  sidebar.add(info);
  activate(info.id);
  await terminal.start();
  return terminal;
}

let diffView: DiffView | undefined;

async function openDiff(target: DiffTarget | undefined, title: string): Promise<void> {
  closeDiff();
  const { DiffView } = await import("./diff-view");
  closeDiff();
  diffView = new DiffView(container, target, title, closeDiff);
}

function closeDiff(): void {
  if (!diffView) return;
  diffView.dispose();
  diffView = undefined;
  if (store.activeId !== undefined) terminals.get(store.activeId)?.focus();
}

let gitPanel: GitPanel | undefined;

function closeGitPanel(): void {
  gitPanel?.dispose();
  gitPanel = undefined;
  if (!diffView && store.activeId !== undefined) terminals.get(store.activeId)?.focus();
}

async function openGitPanel(id: number): Promise<void> {
  const location = await tabLocation(id).catch(() => null);
  closeGitPanel();
  gitPanel = new GitPanel(container, location?.repoRoot ?? undefined, (target, title) => {
    closeGitPanel();
    openDiff(target, title);
  });
}

async function openTabDiff(id: number): Promise<void> {
  const tab = store.get(id);
  if (!tab) return;
  const location = await tabLocation(id).catch(() => null);
  const target: DiffTarget | undefined = location?.repoRoot ? { kind: "workTree", dir: location.cwd } : undefined;
  await openDiff(target, tabTitle(tab));
}

function activate(id: number): void {
  closeGitPanel();
  closeDiff();
  const current = store.activeId;
  if (current !== undefined && current !== id) terminals.get(current)?.hide();
  show(id);
}

function show(id: number): void {
  store.activate(id);
  terminals.get(id)?.show();
  sidebar.setActive(id);
}

function closeTab(id: number): void {
  const terminal = terminals.get(id);
  if (!terminal) return;
  terminal.dispose();
  terminals.delete(id);
  sidebar.remove(id);
  const wasActive = store.activeId === id;
  if (wasActive) {
    closeGitPanel();
    closeDiff();
  }
  const next = store.remove(id);
  if (next === undefined) newTab();
  else if (wasActive) show(next);
}

async function refreshLocations(): Promise<void> {
  for (const tab of store.list()) {
    const location = await tabLocation(tab.id).catch(() => null);
    if (!location) continue;
    const changed = store.update(tab.id, {
      cwd: location.cwd,
      repoRoot: location.repoRoot ?? undefined,
      branch: location.branch ?? undefined,
    });
    if (changed) sidebar.refresh(tab);
  }
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === "Escape" && (gitPanel || diffView)) {
    e.preventDefault();
    if (gitPanel) closeGitPanel();
    else closeDiff();
    return;
  }
  if (!e.metaKey || e.altKey || e.ctrlKey) return;
  const active = store.activeId;
  let handled = true;
  if (e.key === "t") newTab();
  else if (e.key === "w" && active !== undefined) closeTab(active);
  else if (e.key === "d" && active !== undefined) diffView ? closeDiff() : openTabDiff(active);
  else if (e.key === "g" && active !== undefined) gitPanel ? closeGitPanel() : openGitPanel(active);
  else if (/^[1-9]$/.test(e.key)) {
    const tab = store.byIndex(Number(e.key) - 1);
    if (tab) activate(tab.id);
  } else handled = false;
  if (handled) {
    e.preventDefault();
    e.stopPropagation();
  }
}

window.addEventListener("keydown", onKeyDown, true);
window.addEventListener("resize", () => {
  if (store.activeId !== undefined) terminals.get(store.activeId)?.fit();
});
document.getElementById("new-tab")!.onclick = () => newTab();
listen<number>("pty-exit", (e) => closeTab(e.payload));
setInterval(refreshLocations, LOCATION_POLL_MS);
invoke<boolean>("stress_mode").then(async (on) => {
  if (!on) return void newTab();
  const { stress } = await import("./stress");
  stress({ newTab, closeTab, activate });
});
