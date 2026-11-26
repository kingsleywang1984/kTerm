import "diff2html/bundles/css/diff2html.min.css";
import { Diff2HtmlUI } from "diff2html/lib/ui/js/diff2html-ui-slim";
import { ColorSchemeType } from "diff2html/lib/types";
import { DiffTarget, FileChange, diffPatch, diffSummary } from "./api";

const STATUS_LETTER = { added: "A", modified: "M", deleted: "D", renamed: "R" } as const;

export class DiffView {
  private readonly el: HTMLElement;
  private readonly files: HTMLElement;
  private readonly patch: HTMLElement;
  private request = 0;

  constructor(parent: HTMLElement, private readonly target: DiffTarget | undefined, title: string, onClose: () => void) {
    this.el = document.createElement("div");
    this.el.className = "diff-view";
    this.el.tabIndex = -1;
    this.el.innerHTML = `
      <header><span class="diff-title"></span><span class="diff-count"></span>
        <button class="refresh">Refresh</button><button class="close" title="Close (Esc)">×</button></header>
      <div class="diff-body"><ul class="diff-files"></ul><div class="diff-patch"></div></div>`;
    this.el.querySelector(".diff-title")!.textContent = title;
    (this.el.querySelector(".refresh") as HTMLElement).onclick = () => this.load();
    (this.el.querySelector(".close") as HTMLElement).onclick = onClose;
    this.files = this.el.querySelector(".diff-files")!;
    this.patch = this.el.querySelector(".diff-patch")!;
    parent.appendChild(this.el);
    this.el.focus();
    this.load();
  }

  dispose(): void {
    this.request++;
    this.el.remove();
  }

  private async load(): Promise<void> {
    const request = ++this.request;
    this.files.replaceChildren();
    if (!this.target) return this.message("Not a git repository");
    this.message("Loading…");
    try {
      const changes = await diffSummary(this.target);
      if (request !== this.request) return;
      this.el.querySelector(".diff-count")!.textContent = `${changes.length} files`;
      if (changes.length === 0) return this.message("No changes");
      changes.forEach((change) => this.files.appendChild(this.fileItem(change)));
      this.select(changes[0], this.files.firstElementChild as HTMLElement);
    } catch (e) {
      if (request === this.request) this.message(String(e));
    }
  }

  private fileItem(change: FileChange): HTMLElement {
    const li = document.createElement("li");
    li.innerHTML = `<span class="status ${change.status}"></span><span class="path"></span><span class="stat"></span>`;
    li.querySelector(".status")!.textContent = STATUS_LETTER[change.status];
    li.querySelector(".path")!.textContent = change.path;
    li.querySelector(".path")!.setAttribute("title", change.oldPath ? `${change.oldPath} → ${change.path}` : change.path);
    li.querySelector(".stat")!.textContent = change.binary ? "bin" : `+${change.additions} −${change.deletions}`;
    li.onclick = () => this.select(change, li);
    return li;
  }

  private async select(change: FileChange, li: HTMLElement): Promise<void> {
    this.files.querySelectorAll("li").forEach((item) => item.classList.toggle("selected", item === li));
    const request = ++this.request;
    if (change.binary) return this.message("Binary file");
    this.message("Loading…");
    try {
      const patch = await diffPatch(this.target!, change.path, change.oldPath);
      if (request !== this.request) return;
      if (patch.truncated) return this.message("Diff too large to display");
      this.patch.replaceChildren();
      const ui = new Diff2HtmlUI(this.patch, patch.text, {
        outputFormat: "side-by-side",
        drawFileList: false,
        matching: "lines",
        highlight: true,
        colorScheme: ColorSchemeType.DARK,
      });
      ui.draw();
      ui.highlightCode();
    } catch (e) {
      if (request === this.request) this.message(String(e));
    }
  }

  private message(text: string): void {
    const p = document.createElement("p");
    p.className = "diff-message";
    p.textContent = text;
    this.patch.replaceChildren(p);
  }
}
