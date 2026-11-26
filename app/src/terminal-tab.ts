import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { ptyKill, ptyResize, ptySpawn, ptyWrite } from "./api";

export class TerminalTab {
  private readonly el: HTMLElement;
  private readonly term: Terminal;
  private readonly fitAddon = new FitAddon();
  private webgl?: WebglAddon;
  onOutput?: (bytes: Uint8Array) => void;

  constructor(readonly id: number, parent: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "term";
    parent.appendChild(this.el);
    this.term = new Terminal({
      scrollback: 10000,
      fontFamily: "Menlo, monospace",
      fontSize: 13,
      theme: { background: "#1e1e1e" },
    });
    this.term.loadAddon(this.fitAddon);
    this.term.open(this.el);
    this.term.onData((data) => ptyWrite(id, data));
    this.term.onResize(({ cols, rows }) => ptyResize(id, cols, rows));
  }

  start(): Promise<void> {
    return ptySpawn(this.id, this.term.cols, this.term.rows, (bytes) => {
      this.term.write(bytes);
      this.onOutput?.(bytes);
    });
  }

  show(): void {
    this.el.classList.add("active");
    if (!this.webgl) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
          if (this.webgl === webgl) this.webgl = undefined;
        });
        this.term.loadAddon(webgl);
        this.webgl = webgl;
      } catch {
        this.webgl = undefined;
      }
    }
    this.fit();
    this.term.focus();
  }

  hide(): void {
    this.el.classList.remove("active");
    this.webgl?.dispose();
    this.webgl = undefined;
  }

  fit(): void {
    this.fitAddon.fit();
  }

  focus(): void {
    this.term.focus();
  }

  dispose(): void {
    ptyKill(this.id);
    this.webgl?.dispose();
    this.term.dispose();
    this.el.remove();
  }
}
