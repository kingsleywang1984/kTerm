import { DiffTarget, GitTarget, gitTargets } from "./api";
import type { Pin } from "./tabs";

function toTarget(root: string, t: GitTarget): DiffTarget {
  return t.worktree ? { kind: "workTree", dir: t.worktree } : { kind: "branch", root, branch: t.branch! };
}

export class GitPanel {
  private readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private items: HTMLElement[] = [];
  private selected = 0;

  constructor(
    parent: HTMLElement,
    root: string | undefined,
    private readonly current: Pin | undefined,
    private readonly onPick: (pin: Pin | undefined) => void,
  ) {
    this.el = document.createElement("div");
    this.el.className = "git-panel";
    this.el.tabIndex = -1;
    this.el.innerHTML = `<div class="git-panel-box"><header>Worktrees &amp; branches</header><ul></ul></div>`;
    this.list = this.el.querySelector("ul")!;
    this.el.onkeydown = (e) => this.onKey(e);
    parent.appendChild(this.el);
    this.el.focus();
    this.items = [this.followItem()];
    this.list.replaceChildren(this.items[0]);
    if (root) this.load(root);
    else this.message("Not a git repository");
  }

  dispose(): void {
    this.el.remove();
  }

  private async load(root: string): Promise<void> {
    try {
      const targets = await gitTargets(root);
      const entries = targets.map((t) => ({ t, target: toTarget(root, t) }));
      this.items = [this.items[0], ...entries.map(({ t, target }) => this.item(t, target))];
      this.list.replaceChildren(...this.items);
      const current = JSON.stringify(this.current?.target);
      this.move(entries.findIndex(({ target }) => JSON.stringify(target) === current) + 1);
    } catch (e) {
      this.message(String(e));
    }
  }

  private item(t: GitTarget, target: DiffTarget): HTMLElement {
    const name = t.branch ?? t.worktree?.split("/").pop() ?? "detached";
    const li = document.createElement("li");
    li.innerHTML = `<span class="name"></span><span class="where"></span>`;
    li.querySelector(".name")!.textContent = t.isCurrent ? `${name} (current)` : name;
    li.querySelector(".where")!.textContent = t.worktree ?? "no worktree";
    li.onclick = () => this.onPick({ target, label: name });
    return li;
  }

  private followItem(): HTMLElement {
    const li = document.createElement("li");
    li.innerHTML = `<span class="name">Follow terminal directory</span><span class="where">unpin this tab</span>`;
    li.onclick = () => this.onPick(undefined);
    return li;
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "ArrowDown") this.move(this.selected + 1);
    else if (e.key === "ArrowUp") this.move(this.selected - 1);
    else if (e.key === "Enter") this.items[this.selected]?.click();
    else return;
    e.preventDefault();
  }

  private move(index: number): void {
    if (this.items.length === 0) return;
    this.selected = Math.min(Math.max(index, 0), this.items.length - 1);
    this.items.forEach((item, i) => item.classList.toggle("selected", i === this.selected));
    this.items[this.selected].scrollIntoView({ block: "nearest" });
  }

  private message(text: string): void {
    const li = document.createElement("li");
    li.className = "message";
    li.textContent = text;
    this.list.replaceChildren(...this.items, li);
    this.move(0);
  }
}
