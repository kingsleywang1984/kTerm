export type TabInfo = {
  id: number;
  manualTitle?: string;
  cwd?: string;
  repoRoot?: string;
  branch?: string;
};

export function tabTitle(t: TabInfo): string {
  if (t.manualTitle) return t.manualTitle;
  const base = t.cwd?.split("/").filter(Boolean).pop();
  return base ?? `Terminal ${t.id}`;
}

export class TabStore {
  private tabs: TabInfo[] = [];
  private nextId = 1;
  activeId?: number;

  add(): TabInfo {
    const tab = { id: this.nextId++ };
    this.tabs.push(tab);
    return tab;
  }

  remove(id: number): number | undefined {
    const index = this.tabs.findIndex((t) => t.id === id);
    if (index < 0) return this.activeId;
    this.tabs.splice(index, 1);
    if (this.activeId === id) {
      this.activeId = (this.tabs[index - 1] ?? this.tabs[index])?.id;
    }
    return this.activeId;
  }

  activate(id: number): void {
    this.activeId = id;
  }

  list(): TabInfo[] {
    return this.tabs;
  }

  get(id: number): TabInfo | undefined {
    return this.tabs.find((t) => t.id === id);
  }

  byIndex(i: number): TabInfo | undefined {
    return this.tabs[i];
  }

  update(id: number, patch: Partial<TabInfo>): boolean {
    const tab = this.get(id);
    if (!tab) return false;
    const changed = (Object.keys(patch) as (keyof TabInfo)[]).some((k) => tab[k] !== patch[k]);
    Object.assign(tab, patch);
    return changed;
  }
}
