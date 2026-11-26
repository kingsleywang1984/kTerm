import "@xterm/xterm/css/xterm.css";
import { listen } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import { DiffTarget, pinStatus, ptyKillAll, stressMode, tabLocation } from "./api";
import type { DiffView } from "./diff-view";
import { GitPanel } from "./git-panel";
import { CollapsiblePanel } from "./resizer";
import { Sidebar } from "./sidebar";
import { StatusBar } from "./status-bar";
import { TabBar } from "./tab-bar";
import { Pin, TabInfo, diffTargetFor, pinRefresh, tabTitle } from "./tabs";
import { TerminalTab } from "./terminal-tab";
import { Workspace, WorkspaceStore } from "./workspaces";

const LOCATION_POLL_MS = 3000;

const store = new WorkspaceStore();
const terminals = new Map<number, TerminalTab>();
const container = document.getElementById("terminals")!;
const sidebar = new Sidebar(document.getElementById("workspaces")!, {
  select: activateWorkspace,
  rename: (id, name) => {
    const ws = store.get(id);
    if (ws) ws.name = name;
  },
});
const tabBar = new TabBar(document.getElementById("tabbar")!, {
  select: activateTerminal,
  rename: (id, title) => {
    const tab = store.terminal(id);
    if (tab) tab.manualTitle = title;
    render();
  },
});
const statusBar = new StatusBar(document.getElementById("statusbar")!);
let visibleId: number | undefined;
let openToken = 0;

function visible(): TerminalTab | undefined {
  return visibleId === undefined ? undefined : terminals.get(visibleId);
}

function addWorkspace(): Workspace {
  const ws = store.addWorkspace();
  sidebar.add(ws);
  store.activate(ws.id);
  return ws;
}

async function newWorkspace(): Promise<TerminalTab> {
  return newTerminal(addWorkspace().id);
}

async function newTerminal(workspaceId: number): Promise<TerminalTab> {
  const info = store.addTerminal(workspaceId);
  const terminal = new TerminalTab(info.id, container);
  terminal.onTitle = (title) => {
    const ws = store.workspaceOf(info.id);
    if (ws?.tabs.update(info.id, { programTitle: title }) && ws === store.active()) scheduleRender();
  };
  terminals.set(info.id, terminal);
  render();
  await terminal.start();
  return terminal;
}

let renderScheduled = false;

function scheduleRender(): void {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    render();
  });
}

function render(): void {
  const ws = store.active();
  const tab = store.activeTerminal();
  if (visibleId !== tab?.id) {
    openToken++;
    closeGitPanel();
    closeDiff();
    visible()?.hide();
    visibleId = tab?.id;
    visible()?.show();
    if (tab) refreshLocation(tab).then((changed) => changed && render());
  }
  if (!diffView && !gitPanel && !(document.activeElement instanceof HTMLInputElement)) visible()?.focus();
  sidebar.setActive(ws?.id);
  tabBar.render(ws);
  statusBar.render(tab);
}

function activateWorkspace(id: number): void {
  store.activate(id);
  render();
}

function activateTerminal(id: number): void {
  const ws = store.workspaceOf(id);
  if (!ws) return;
  store.activate(ws.id);
  ws.tabs.activate(id);
  render();
}

function closeTerminal(id: number): void {
  const terminal = terminals.get(id);
  const ws = store.workspaceOf(id);
  if (!terminal || !ws) return;
  if (visibleId === id) {
    closeGitPanel();
    closeDiff();
    visibleId = undefined;
  }
  terminal.dispose();
  terminals.delete(id);
  store.removeTerminal(id);
  if (!store.get(ws.id)) sidebar.remove(ws.id);
  if (store.all().length === 0) newWorkspace();
  else render();
}

let diffView: DiffView | undefined;

async function openDiff(target: DiffTarget | undefined, title: string): Promise<void> {
  const token = ++openToken;
  closeDiff();
  const { DiffView } = await import("./diff-view");
  if (token !== openToken) return;
  closeDiff();
  diffView = new DiffView(container, target, title);
}

function closeDiff(): void {
  if (!diffView) return;
  diffView.dispose();
  diffView = undefined;
  visible()?.focus();
}

let gitPanel: GitPanel | undefined;

function closeGitPanel(): void {
  gitPanel?.dispose();
  gitPanel = undefined;
  if (!diffView) visible()?.focus();
}

async function openGitPanel(tab: TabInfo): Promise<void> {
  if (!(await refreshBeforeOpen(tab))) return;
  closeGitPanel();
  gitPanel = new GitPanel(container, tab.repoRoot, tab.pin, (pin) => {
    closeGitPanel();
    setPin(tab, pin);
    if (pin) openDiff(pin.target, pin.label);
  });
}

function setPin(tab: TabInfo, pin: Pin | undefined): void {
  tab.pin = pin;
  tab.pinnedBranch = undefined;
  render();
}

async function refreshBeforeOpen(tab: TabInfo): Promise<boolean> {
  const token = ++openToken;
  if (await refreshLocation(tab)) render();
  return token === openToken && visibleId === tab.id;
}

async function openTabDiff(tab: TabInfo): Promise<void> {
  if (!(await refreshBeforeOpen(tab))) return;
  await openDiff(diffTargetFor(tab), tab.pin?.label ?? tabTitle(tab));
}

async function refreshLocation(tab: TabInfo): Promise<boolean> {
  const withGit = tab.id === visibleId;
  const location = await tabLocation(tab.id, withGit).catch(() => null);
  const tabs = store.workspaceOf(tab.id)?.tabs;
  if (!tabs) return false;
  let changed = false;
  if (location) {
    changed = tabs.update(
      tab.id,
      withGit
        ? { cwd: location.cwd, repoRoot: location.repoRoot ?? undefined, branch: location.branch ?? undefined }
        : { cwd: location.cwd },
    );
  }
  const pin = tab.pin;
  if (pin && withGit) {
    const info = await pinStatus(pin.target).catch(() => undefined);
    const patch = pinRefresh(pin, tab.pin, info);
    if (patch) changed = tabs.update(tab.id, patch) || changed;
  }
  return changed;
}

async function pollLocations(): Promise<void> {
  let changed = false;
  for (const tab of store.terminals()) changed = (await refreshLocation(tab)) || changed;
  if (changed) render();
  setTimeout(pollLocations, LOCATION_POLL_MS);
}

function cycleTerminal(delta: number): void {
  if (store.cycle(delta)) render();
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === "Escape") openToken++;
  if (e.key === "Escape" && (gitPanel || diffView)) {
    e.preventDefault();
    if (gitPanel) closeGitPanel();
    else closeDiff();
    return;
  }
  if (!e.metaKey || e.altKey || e.ctrlKey) return;
  const ws = store.active();
  const tab = store.activeTerminal();
  const key = e.shiftKey ? `⇧${e.code}` : e.code;
  let handled = true;
  if (key === "⇧KeyT") newWorkspace();
  else if (key === "KeyT" && ws) newTerminal(ws.id);
  else if (key === "KeyW" && tab) closeTerminal(tab.id);
  else if (key === "⇧BracketLeft") cycleTerminal(-1);
  else if (key === "⇧BracketRight") cycleTerminal(1);
  else if (key === "KeyD" && tab) diffView ? closeDiff() : openTabDiff(tab);
  else if (key === "KeyG" && tab) gitPanel ? closeGitPanel() : openGitPanel(tab);
  else if (key === "KeyR" && diffView) diffView.refresh();
  else if (key === "KeyB") diffView ? diffView.toggleFiles() : sidebarPanel.toggle();
  else if (/^Digit[1-9]$/.test(key)) {
    const target = store.byIndex(Number(key.slice(5)) - 1);
    if (target) activateWorkspace(target.id);
  } else handled = false;
  if (handled) {
    e.preventDefault();
    e.stopPropagation();
  }
}

const sidebarPanel = new CollapsiblePanel(document.getElementById("sidebar-handle")!, document.getElementById("sidebar")!, 120, 600);
new ResizeObserver(() => visible()?.fit()).observe(container);
window.addEventListener("keydown", onKeyDown, true);
listen<number>("pty-exit", (e) => closeTerminal(e.payload));
setTimeout(pollLocations, LOCATION_POLL_MS);
homeDir()
  .then((home) => {
    statusBar.home = home;
    render();
  })
  .catch(() => {});
Promise.all([ptyKillAll().catch(() => {}), stressMode()]).then(async ([, on]) => {
  if (!on) return void newWorkspace();
  addWorkspace();
  const { stress } = await import("./stress");
  stress({
    newTab: () => newTerminal(store.activeId!),
    closeTab: closeTerminal,
    activate: activateTerminal,
  });
});
