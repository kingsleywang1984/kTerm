export function inlineRename(
  label: HTMLElement,
  current: string,
  onSave: (name: string | undefined) => void,
  onEnd?: () => void,
): void {
  const input = document.createElement("input");
  input.className = "rename";
  input.value = current;
  label.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    input.replaceWith(label);
    const name = input.value.trim();
    if (save && name !== current) onSave(name || undefined);
    onEnd?.();
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  };
  input.onblur = () => finish(false);
  input.onclick = (e) => e.stopPropagation();
}

export function isRenaming(container: HTMLElement): boolean {
  return container.querySelector("input.rename") !== null;
}
