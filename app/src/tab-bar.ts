import { inlineRename, isRenaming } from "./rename";
import { TabInfo, tabTitle } from "./tabs";
import { Workspace } from "./workspaces";

export type TabBarHandlers = {
  select(id: number): void;
  rename(id: number, title: string | undefined): void;
};

export class TabBar {
  private ws?: Workspace;
  private readonly items = new Map<number, { item: HTMLElement; label: HTMLElement; tab: TabInfo }>();

  constructor(private readonly el: HTMLElement, private readonly handlers: TabBarHandlers) {}

  render(ws: Workspace | undefined): void {
    this.ws = ws;
    if (isRenaming(this.el)) return;
    const tabs = ws?.tabs.list() ?? [];
    for (const [id, entry] of this.items) {
      if (!tabs.includes(entry.tab)) {
        entry.item.remove();
        this.items.delete(id);
      }
    }
    const items = tabs.map((tab) => {
      const entry = this.items.get(tab.id) ?? this.create(tab);
      entry.label.textContent = tabTitle(tab);
      entry.item.classList.toggle("active", tab.id === ws?.tabs.activeId);
      return entry.item;
    });
    items.forEach((item, i) => {
      if (this.el.children[i] !== item) this.el.insertBefore(item, this.el.children[i] ?? null);
    });
  }

  private create(tab: TabInfo) {
    const item = document.createElement("div");
    item.className = "tab";
    const label = document.createElement("span");
    item.appendChild(label);
    item.onclick = () => this.handlers.select(tab.id);
    label.ondblclick = () =>
      inlineRename(
        label,
        tabTitle(tab),
        (title) => this.handlers.rename(tab.id, title),
        () => this.render(this.ws),
      );
    const entry = { item, label, tab };
    this.items.set(tab.id, entry);
    return entry;
  }
}
