import { TabInfo, statusParts } from "./tabs";

export class StatusBar {
  home = "";

  constructor(private readonly el: HTMLElement) {}

  render(tab: TabInfo | undefined): void {
    const parts = tab ? statusParts(tab, this.home) : [];
    this.el.replaceChildren(
      ...parts.map((text) => {
        const span = document.createElement("span");
        span.textContent = text;
        return span;
      }),
    );
  }
}
