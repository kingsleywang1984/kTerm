export function dragWidth(start: number, delta: number, min: number, max: number): number {
  return Math.min(Math.max(start + delta, min), max);
}

export class CollapsiblePanel {
  private lastWidth = 0;

  constructor(
    private readonly handle: HTMLElement,
    private readonly target: HTMLElement,
    min: number,
    max: number,
  ) {
    handle.onpointerdown = (down) => {
      down.preventDefault();
      handle.setPointerCapture(down.pointerId);
      const startWidth = target.getBoundingClientRect().width;
      handle.onpointermove = (move) => this.setWidth(dragWidth(startWidth, move.clientX - down.clientX, min, max));
      handle.onpointerup = handle.onpointercancel = () => {
        handle.onpointermove = null;
        handle.onpointerup = null;
        handle.onpointercancel = null;
      };
    };
  }

  toggle(): void {
    if (this.collapsed) return this.setWidth(this.lastWidth);
    this.lastWidth = this.target.getBoundingClientRect().width;
    this.setWidth(0);
  }

  private get collapsed(): boolean {
    return this.target.style.width === "0px";
  }

  private setWidth(width: number): void {
    this.target.style.width = `${width}px`;
    this.handle.style.display = width === 0 ? "none" : "";
  }
}
