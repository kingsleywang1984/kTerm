# k-shell Design

## Intent

A lightweight macOS terminal for a workflow of running ~10 Claude Code sessions in parallel, each in its own git worktree or working branch, and reviewing what each agent changed without leaving the terminal.

Why it exists:
- iTerm2 has no sidebar for session tabs.
- cmux has a good sidebar, but its memory grows over weeks of uptime. Measured on 2026-11-25 after 12 days: 1392 MB footprint, ~1.1 GB of it GPU surfaces (IOSurface 603 MB, IOAccelerator 312 MB, graphics 173 MB).
- Reviewing agent changes today means leaving the terminal for an IDE.

## Goals (v1)

1. **Sidebar of session tabs.** Vertical list, one item per terminal session. New, close, switch (click, `Cmd+1..9`, `Cmd+T` for new). Each item shows a title and, as a subtitle, the git branch of the session's current directory (empty when not in a repo).
   - Title defaults to the name of the session's current directory (e.g. `my-app-1234`), since terminal-set titles would all read "claude".
   - Double-click renames a tab; a manual name overrides the default.
2. **Multiple terminals, one visible at a time.** No split panes.
3. **Diff review per tab.** A toggle (keyboard shortcut, plus a clickable entry) switches the main area from the terminal to a read-only diff view of the repo the tab is in, and back.
   - Diff scope: everything on the branch since it forked from the default branch, plus uncommitted changes, plus untracked files. Equivalent to `git diff $(git merge-base <default> HEAD)` against the working tree, with untracked files shown as added.
   - Layout: changed-file list on the left, diff of the selected file on the right, syntax highlighted.
   - Read-only. The user reviews, then tells Claude in the terminal what to change.
4. **Git panel (read-only).** Opened by shortcut. Lists the worktrees and local branches of the current tab's repo. Selecting one opens its diff view without needing a terminal in it. No create, delete or switch: the user asks an agent to manage worktrees and branches.
   - A branch checked out in a worktree diffs that worktree's working tree (including uncommitted and untracked changes).
   - A branch with no worktree diffs `merge-base(default, branch)..branch` only.

"Open diff for a directory/branch" is one function; the tab toggle and the git panel are two entry points to it. A later version may move the entry to a branch label at the bottom of each terminal, so the entry point must stay replaceable.

## Non-goals (v1)

- Split panes.
- Editing, staging, committing, merging, or commenting in the diff view.
- Managing worktrees or branches (create, delete, switch, rename).
- AI or Claude-specific integrations (agent status, notifications).
- Restoring sessions across app restarts.
- Platforms other than macOS.

## Anti-goals

- Memory that grows with uptime. A week of normal use must not trend upward the way cmux does.
- Electron-level baseline memory.

## Constraints

- macOS only.
- Built by Claude; the user does not read Rust or TypeScript, so prefer the simplest stack that works.
- Memory rules that are part of the design, not later optimisations:
  - Only the visible terminal holds a GPU (WebGL) renderer; switching away disposes it.
  - Closing a tab fully disposes the xterm instance, DOM, PTY and child process.
  - Scrollback has a hard cap per terminal (10,000 lines in the spike).
  - PTY output is batched in Rust before crossing to the webview (spike: flush every 8 ms or 1 MB).
  - The diff view is created when opened and released when closed.

## Approaches

| | Approach | Trade-off |
|---|---|---|
| **A (chosen)** | Tauri 2 (Rust backend + system WKWebView) + xterm.js + web diff component | Fastest to build; diff UI is mostly off-the-shelf. One WebView for the whole app, no bundled Chromium. Terminal rendering below native but fine for Claude Code. |
| B | Swift/AppKit + libghostty, WKWebView only for the diff panel | Best terminal fidelity and memory, but libghostty's embedding API is unstable and lightly documented; much slower to build. |
| C | Pure Swift + SwiftTerm + native diff view | Diff rendering and highlighting from scratch; most work for no gain. |

The user picked A, with B as the fallback if A fails the memory check.

## Spike findings (2026-11-25, `spike/`)

Throwaway Tauri app: sidebar tabs, xterm.js with WebGL on the active tab only, portable-pty backend.

- Idle, no tabs: ~300 MB total (app ~31 MB + WebKit processes).
- 10 idle tabs: ~300 MB.
- After 24 MB of output into each of 10 tabs: peak 1.25 GB during the flood, settled to ~470 MB.
- Unbatched PTY output was slow (~77 s per 24 MB) and caused the peak; batching was added.
- A command written to a new PTY before the shell's line editor is ready can be dropped. Anything that types into a fresh shell must wait for readiness.
- The tab open/close and long-uptime results are pending; stress testing is deferred until v1 features are stable (user's call).

## Memory gate

Run the spike's stress script once, after the terminal part (tabs + PTY) is done and before building the diff view, so a failure of approach A is found before the diff work is spent. Pass: settled memory after the second round of tab churn and switching is not higher than after the first round (no upward trend). This is a builder call, made so a late failure does not waste v1.

## Decided by the user

- Stack: approach A.
- Sidebar items are plain session tabs, not worktrees or branches.
- Diff review is reachable from the current tab; worktree/branch management lives in a separate git panel.
- Diff view and git panel are read-only; no worktree or branch management.
- Tab title: directory name by default, manual rename overrides.
- No split panes in v1.

## Left to the builder

- Diff component: pick something light (e.g. a diff renderer plus a highlighter); avoid shipping a full editor like Monaco unless the light options fall short.
- How to find a tab's current directory: proposed to read the cwd of the PTY's foreground process group (`tcgetpgrp` on the master, then `proc_pidinfo`), so it follows `claude` running inside a worktree, with OSC 7 as an optional source.
- Default branch detection: proposed `origin/HEAD`, falling back to `main`, then `master`.
- Git access: proposed shelling out to the `git` CLI for parity with the user's own git behaviour, rather than libgit2.
- When to refresh the branch subtitle and the diff (poll interval, on focus, or file watching).
- Visual design of sidebar, diff view and git panel.
