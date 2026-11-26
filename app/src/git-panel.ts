import { DiffTarget, GitTarget, gitTargets } from "./api";

export class GitPanel {
  private readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private items: { li: HTMLElement; pick: () => void }[] = [];
  private selected = 0;

  constructor(parent: HTMLElement, root: string | undefined, private readonly onPick: (target: DiffTarget, title: string) => void) {
    this.el = document.createElement("div");
    this.el.className = "git-panel";
    this.el.tabIndex = -1;
    this.el.innerHTML = `<div class="git-panel-box"><header>Worktrees &amp; branches</header><ul></ul></div>`;
    this.list = this.el.querySelector("ul")!;
    this.el.onkeydown = (e) => this.onKey(e);
    parent.appendChild(this.el);
    this.el.focus();
    if (root) this.load(root);
    else this.message("Not a git repository");
  }

  dispose(): void {
    this.el.remove();
  }

  private async load(root: string): Promise<void> {
    try {
      const targets = await gitTargets(root);
      this.items = targets.map((t) => this.item(root, t));
      this.list.replaceChildren(...this.items.map((i) => i.li));
      this.move(Math.max(0, targets.findIndex((t) => t.isCurrent)));
    } catch (e) {
      this.message(String(e));
    }
  }

  private item(root: string, t: GitTarget): { li: HTMLElement; pick: () => void } {
    const name = t.branch ?? t.worktree?.split("/").pop() ?? "detached";
    const li = document.createElement("li");
    li.innerHTML = `<span class="name"></span><span class="where"></span>`;
    li.querySelector(".name")!.textContent = t.isCurrent ? `${name} (current)` : name;
    li.querySelector(".where")!.textContent = t.worktree ?? "no worktree";
    const target: DiffTarget = t.worktree
      ? { kind: "workTree", dir: t.worktree }
      : { kind: "branch", root, branch: t.branch! };
    const pick = () => this.onPick(target, name);
    li.onclick = pick;
    return { li, pick };
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "ArrowDown") this.move(this.selected + 1);
    else if (e.key === "ArrowUp") this.move(this.selected - 1);
    else if (e.key === "Enter") this.items[this.selected]?.pick();
    else return;
    e.preventDefault();
  }

  private move(index: number): void {
    if (this.items.length === 0) return;
    this.selected = Math.min(Math.max(index, 0), this.items.length - 1);
    this.items.forEach((item, i) => item.li.classList.toggle("selected", i === this.selected));
    this.items[this.selected].li.scrollIntoView({ block: "nearest" });
  }

  private message(text: string): void {
    const li = document.createElement("li");
    li.className = "message";
    li.textContent = text;
    this.list.replaceChildren(li);
  }
}
