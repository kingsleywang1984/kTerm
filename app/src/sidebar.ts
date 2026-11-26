import { TabInfo, tabTitle } from "./tabs";

export type SidebarHandlers = {
  select(id: number): void;
  close(id: number): void;
  diff(id: number): void;
  rename(id: number, title: string | undefined): void;
};

export class Sidebar {
  private readonly items = new Map<number, HTMLElement>();

  constructor(private readonly list: HTMLElement, private readonly handlers: SidebarHandlers) {}

  add(tab: TabInfo): void {
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="row"><span class="title"></span><button class="diff" title="Review diff">±</button><button class="close" title="Close">×</button></div>
      <div class="subtitle"></div>`;
    li.onclick = () => this.handlers.select(tab.id);
    this.button(li, ".diff", () => this.handlers.diff(tab.id));
    this.button(li, ".close", () => this.handlers.close(tab.id));
    li.querySelector(".title")!.addEventListener("dblclick", () => this.startRename(li, tab));
    this.items.set(tab.id, li);
    this.list.appendChild(li);
    this.refresh(tab);
  }

  remove(id: number): void {
    this.items.get(id)?.remove();
    this.items.delete(id);
  }

  setActive(id: number): void {
    this.items.forEach((li, key) => li.classList.toggle("active", key === id));
  }

  refresh(tab: TabInfo): void {
    const li = this.items.get(tab.id);
    if (!li || li.querySelector("input")) return;
    li.querySelector(".title")!.textContent = tabTitle(tab);
    li.querySelector(".subtitle")!.textContent = tab.branch ?? "";
  }

  private button(li: HTMLElement, selector: string, action: () => void): void {
    (li.querySelector(selector) as HTMLElement).onclick = (e) => {
      e.stopPropagation();
      action();
    };
  }

  private startRename(li: HTMLElement, tab: TabInfo): void {
    const title = li.querySelector(".title") as HTMLElement;
    const input = document.createElement("input");
    input.value = tabTitle(tab);
    title.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      input.replaceWith(title);
      if (save) this.handlers.rename(tab.id, input.value.trim() || undefined);
      this.refresh(tab);
    };
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    };
    input.onblur = () => finish(false);
    input.onclick = (e) => e.stopPropagation();
  }
}
