import { Channel, invoke } from "@tauri-apps/api/core";

export type TabLocation = { cwd: string; repoRoot: string | null; branch: string | null };

export function ptySpawn(id: number, cols: number, rows: number, onData: (bytes: Uint8Array) => void) {
  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = (buf) => onData(new Uint8Array(buf));
  return invoke<void>("pty_spawn", { id, cols, rows, onData: channel });
}

export const ptyWrite = (id: number, data: string) => invoke<void>("pty_write", { id, data });
export const ptyResize = (id: number, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows });
export const ptyKill = (id: number) => invoke<void>("pty_kill", { id });
export const ptyKillAll = () => invoke<void>("pty_kill_all");
export const ptyAck = (id: number, bytes: number) => invoke<void>("pty_ack", { id, bytes });
export const pinStatus = (target: DiffTarget) => invoke<{ branch: string | null } | null>("pin_status", { target });
export const tabLocation = (id: number, withGit: boolean) => invoke<TabLocation | null>("tab_location", { id, withGit });
export const stressMode = () => invoke<boolean>("stress_mode");
export const mark = (label: string) => invoke<void>("mark", { label });

export type DiffTarget = { kind: "workTree"; dir: string } | { kind: "branch"; root: string; branch: string };
export type FileStatus = "added" | "modified" | "deleted" | "renamed";
export type FileChange = {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
};
export type Patch = { text: string; truncated: boolean };
export type GitTarget = { branch: string | null; worktree: string | null; isCurrent: boolean };

export const diffSummary = (target: DiffTarget) => invoke<FileChange[]>("diff_summary", { target });
export const diffPatch = (target: DiffTarget, path: string, oldPath: string | null) =>
  invoke<Patch>("diff_patch", { target, path, oldPath });
export const gitTargets = (root: string) => invoke<GitTarget[]>("git_targets", { root });
