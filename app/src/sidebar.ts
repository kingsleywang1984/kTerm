import { inlineRename, isRenaming } from "./rename";
import { Workspace, workspaceName } from "./workspaces";

export type SidebarHandlers = {
  select(id: number): void;
  rename(id: number, name: string | undefined): void;
};

export class Sidebar {
  private readonly items = new Map<number, HTMLElement>();

  constructor(private readonly list: HTMLElement, private readonly handlers: SidebarHandlers) {}

  add(ws: Workspace): void {
    const li = document.createElement("li");
    li.innerHTML = `<span class="title"></span>`;
    li.onclick = () => this.handlers.select(ws.id);
    const title = li.querySelector(".title") as HTMLElement;
    title.ondblclick = () =>
      inlineRename(
        title,
        workspaceName(ws),
        (name) => this.handlers.rename(ws.id, name),
        () => this.refresh(ws),
      );
    this.items.set(ws.id, li);
    this.list.appendChild(li);
    this.refresh(ws);
  }

  remove(id: number): void {
    this.items.get(id)?.remove();
    this.items.delete(id);
  }

  setActive(id: number | undefined): void {
    this.items.forEach((li, key) => li.classList.toggle("active", key === id));
  }

  private refresh(ws: Workspace): void {
    const li = this.items.get(ws.id);
    if (!li || isRenaming(li)) return;
    li.querySelector(".title")!.textContent = workspaceName(ws);
  }
}
