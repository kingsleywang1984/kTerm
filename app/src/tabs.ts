import type { DiffTarget } from "./api";

export type Pin = { target: DiffTarget; label: string };

export type TabInfo = {
  id: number;
  manualTitle?: string;
  programTitle?: string;
  cwd?: string;
  repoRoot?: string;
  branch?: string;
  pin?: Pin;
  pinnedBranch?: string;
};

export function tabTitle(t: TabInfo): string {
  if (t.manualTitle) return t.manualTitle;
  if (t.programTitle?.trim()) return t.programTitle;
  const base = t.cwd?.split("/").filter(Boolean).pop();
  return base ?? `Terminal ${t.id}`;
}

export function statusParts(t: TabInfo, home: string): string[] {
  if (!t.cwd) return [];
  const shorten = (path: string) =>
    home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
  const parts = [shorten(t.cwd)];
  if (t.branch) parts.push(`⎇ ${t.branch}`);
  if (t.pin) {
    const target = t.pin.target;
    parts.push(
      target.kind === "workTree"
        ? `📌 ${shorten(target.dir)}${t.pinnedBranch ? ` ⎇ ${t.pinnedBranch}` : ""}`
        : `📌 ⎇ ${target.branch}`,
    );
  }
  return parts;
}

export function pinRefresh(
  pinAtStart: Pin,
  currentPin: Pin | undefined,
  info: { branch: string | null } | null | undefined,
): Partial<TabInfo> | undefined {
  if (currentPin !== pinAtStart || info === undefined) return undefined;
  if (info === null) return { pin: undefined, pinnedBranch: undefined };
  return { pinnedBranch: info.branch ?? undefined };
}

export function diffTargetFor(t: TabInfo): DiffTarget | undefined {
  if (t.pin) return t.pin.target;
  return t.cwd && t.repoRoot ? { kind: "workTree", dir: t.cwd } : undefined;
}

export function removeById<T extends { id: number }>(list: T[], id: number, activeId?: number): number | undefined {
  const index = list.findIndex((item) => item.id === id);
  if (index < 0) return activeId;
  list.splice(index, 1);
  return activeId === id ? (list[index - 1] ?? list[index])?.id : activeId;
}

function counter(): () => number {
  let next = 1;
  return () => next++;
}

export class TabStore {
  private tabs: TabInfo[] = [];
  activeId?: number;

  constructor(private readonly nextId: () => number = counter()) {}

  add(): TabInfo {
    const tab = { id: this.nextId() };
    this.tabs.push(tab);
    return tab;
  }

  remove(id: number): number | undefined {
    this.activeId = removeById(this.tabs, id, this.activeId);
    return this.activeId;
  }

  activate(id: number): void {
    this.activeId = id;
  }

  list(): TabInfo[] {
    return this.tabs;
  }

  get(id: number): TabInfo | undefined {
    return this.tabs.find((t) => t.id === id);
  }

  update(id: number, patch: Partial<TabInfo>): boolean {
    const tab = this.get(id);
    if (!tab) return false;
    const changed = (Object.keys(patch) as (keyof TabInfo)[]).some((k) => tab[k] !== patch[k]);
    Object.assign(tab, patch);
    return changed;
  }
}
