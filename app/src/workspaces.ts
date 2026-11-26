import { TabInfo, TabStore, removeById } from "./tabs";

export type Workspace = { id: number; name?: string; tabs: TabStore };

export function workspaceName(ws: Workspace): string {
  return ws.name || `Workspace ${ws.id}`;
}

export class WorkspaceStore {
  private workspaces: Workspace[] = [];
  private nextWorkspaceId = 1;
  private nextTerminalId = 1;
  activeId?: number;

  addWorkspace(): Workspace {
    const ws = { id: this.nextWorkspaceId++, tabs: new TabStore(() => this.nextTerminalId++) };
    this.workspaces.push(ws);
    this.activeId ??= ws.id;
    return ws;
  }

  addTerminal(workspaceId: number): TabInfo {
    const ws = this.get(workspaceId)!;
    const tab = ws.tabs.add();
    ws.tabs.activate(tab.id);
    return tab;
  }

  removeTerminal(terminalId: number): void {
    const ws = this.workspaceOf(terminalId);
    if (!ws) return;
    ws.tabs.remove(terminalId);
    if (ws.tabs.list().length > 0) return;
    this.activeId = removeById(this.workspaces, ws.id, this.activeId);
  }

  activate(workspaceId: number): void {
    this.activeId = workspaceId;
  }

  get(workspaceId: number): Workspace | undefined {
    return this.workspaces.find((w) => w.id === workspaceId);
  }

  all(): Workspace[] {
    return this.workspaces;
  }

  byIndex(i: number): Workspace | undefined {
    return this.workspaces[i];
  }

  active(): Workspace | undefined {
    return this.activeId === undefined ? undefined : this.get(this.activeId);
  }

  activeTerminal(): TabInfo | undefined {
    const tabs = this.active()?.tabs;
    return tabs?.activeId === undefined ? undefined : tabs.get(tabs.activeId);
  }

  workspaceOf(terminalId: number): Workspace | undefined {
    return this.workspaces.find((w) => w.tabs.get(terminalId));
  }

  terminal(terminalId: number): TabInfo | undefined {
    return this.workspaceOf(terminalId)?.tabs.get(terminalId);
  }

  terminals(): TabInfo[] {
    return this.workspaces.flatMap((w) => w.tabs.list());
  }

  cycle(delta: number): TabInfo | undefined {
    const ws = this.active();
    const list = ws?.tabs.list() ?? [];
    if (!ws || list.length === 0) return undefined;
    const index = list.findIndex((t) => t.id === ws.tabs.activeId);
    const next = list[(index + delta + list.length) % list.length];
    ws.tabs.activate(next.id);
    return next;
  }
}
