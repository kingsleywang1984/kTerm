use crate::git::{git, git_capped, ref_exists, repo_root};
use std::io::Read;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_PATCH_BYTES: usize = 1024 * 1024;
const BINARY_SNIFF_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DiffTarget {
    WorkTree { dir: PathBuf },
    Branch { root: PathBuf, branch: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Added,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub old_path: Option<String>,
    pub status: Status,
    pub additions: u32,
    pub deletions: u32,
    pub binary: bool,
}

#[derive(Debug, Serialize)]
pub struct Patch {
    pub text: String,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct PinStatus {
    pub branch: Option<String>,
}

pub fn pin_status(target: &DiffTarget) -> Result<Option<PinStatus>, String> {
    match target {
        DiffTarget::WorkTree { dir } => {
            if !dir.exists() {
                return Ok(None);
            }
            let info = crate::git::repo_info(dir).ok_or("cannot read worktree")?;
            Ok(Some(PinStatus { branch: info.branch }))
        }
        DiffTarget::Branch { root, branch } => {
            if !root.exists() {
                return Ok(None);
            }
            let found = ref_exists(root, &format!("refs/heads/{branch}"))?;
            Ok(found.then(|| PinStatus { branch: Some(branch.clone()) }))
        }
    }
}

fn default_branch(root: &Path) -> Option<String> {
    if let Ok(remote) = git(root, &["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]) {
        return Some(remote.trim().to_string());
    }
    ["main", "master"]
        .into_iter()
        .find(|b| ref_exists(root, &format!("refs/heads/{b}")).unwrap_or(false))
        .map(String::from)
}

fn base(root: &Path, target: &DiffTarget) -> Result<String, String> {
    let head = head_ref(target);
    if !ref_exists(root, &format!("{head}^{{commit}}"))? {
        return match target {
            DiffTarget::WorkTree { .. } => Ok(EMPTY_TREE.to_string()),
            DiffTarget::Branch { branch, .. } => Err(format!("unknown branch {branch}")),
        };
    }
    let fork = default_branch(root).and_then(|d| git(root, &["merge-base", &d, &head]).ok());
    match fork {
        Some(commit) => Ok(commit.trim().to_string()),
        None => Ok(git(root, &["rev-parse", &head])?.trim().to_string()),
    }
}

pub fn summary(target: &DiffTarget) -> Result<Vec<FileChange>, String> {
    let root = repo_root(target_dir(target))?;
    let range = range(&root, target)?;
    let mut changes = tracked_changes(&root, &range)?;
    if matches!(target, DiffTarget::WorkTree { .. }) {
        for path in untracked(&root, None)? {
            changes.push(untracked_change(&root, path));
        }
    }
    changes.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(changes)
}

pub fn patch(target: &DiffTarget, path: &str, old_path: Option<&str>) -> Result<Patch, String> {
    let root = repo_root(target_dir(target))?;
    let is_untracked =
        matches!(target, DiffTarget::WorkTree { .. }) && !untracked(&root, Some(path))?.is_empty();
    let mut args: Vec<String> = ["diff", "--no-ext-diff", "--no-textconv"].map(String::from).into();
    if is_untracked {
        args.extend(["--no-index", "--", "/dev/null", path].map(String::from));
    } else {
        args.push("--find-renames".into());
        args.extend(range(&root, target)?);
        args.push("--".into());
        args.extend(old_path.map(String::from));
        args.push(path.into());
    }
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    Ok(match git_capped(&root, &args, &[0, 1], MAX_PATCH_BYTES)? {
        Some(text) => Patch { text, truncated: false },
        None => Patch { text: String::new(), truncated: true },
    })
}

fn target_dir(target: &DiffTarget) -> &Path {
    match target {
        DiffTarget::WorkTree { dir } => dir,
        DiffTarget::Branch { root, .. } => root,
    }
}

fn head_ref(target: &DiffTarget) -> String {
    match target {
        DiffTarget::WorkTree { .. } => "HEAD".into(),
        DiffTarget::Branch { branch, .. } => format!("refs/heads/{branch}"),
    }
}

fn range(root: &Path, target: &DiffTarget) -> Result<Vec<String>, String> {
    let base = base(root, target)?;
    Ok(match target {
        DiffTarget::WorkTree { .. } => vec![base],
        DiffTarget::Branch { .. } => vec![base, head_ref(target)],
    })
}

fn tracked_changes(root: &Path, range: &[String]) -> Result<Vec<FileChange>, String> {
    let diff_args = |mode: &'static str| {
        let mut args = vec!["diff", "--no-ext-diff", "--no-textconv", "-z", mode, "--find-renames"];
        args.extend(range.iter().map(String::as_str));
        args.push("--");
        args
    };
    let statuses = git(root, &diff_args("--name-status"))?;
    let numstat = git(root, &diff_args("--numstat"))?;
    let counts: std::collections::HashMap<String, (u32, u32, bool)> =
        parse_numstat(&numstat).into_iter().map(|(p, a, d, b)| (p, (a, d, b))).collect();
    Ok(parse_name_status(&statuses)
        .into_iter()
        .map(|(status, path, old_path)| {
            let (additions, deletions, binary) = counts.get(&path).copied().unwrap_or((0, 0, false));
            FileChange { path, old_path, status, additions, deletions, binary }
        })
        .collect())
}

fn parse_name_status(out: &str) -> Vec<(Status, String, Option<String>)> {
    let mut tokens = out.split('\0').filter(|t| !t.is_empty());
    let mut result = Vec::new();
    while let Some(code) = tokens.next() {
        let status = match code.as_bytes()[0] {
            b'A' => Status::Added,
            b'D' => Status::Deleted,
            b'R' => Status::Renamed,
            _ => Status::Modified,
        };
        if status == Status::Renamed {
            let (Some(old), Some(new)) = (tokens.next(), tokens.next()) else { break };
            result.push((status, new.to_string(), Some(old.to_string())));
        } else if let Some(path) = tokens.next() {
            result.push((status, path.to_string(), None));
        }
    }
    result
}

fn parse_numstat(out: &str) -> Vec<(String, u32, u32, bool)> {
    let mut tokens = out.split('\0');
    let mut result = Vec::new();
    while let Some(entry) = tokens.next() {
        let mut fields = entry.splitn(3, '\t');
        let (Some(add), Some(del), Some(path)) = (fields.next(), fields.next(), fields.next()) else {
            continue;
        };
        let path = if path.is_empty() {
            tokens.next();
            tokens.next().unwrap_or_default()
        } else {
            path
        };
        let binary = add == "-";
        result.push((path.to_string(), add.parse().unwrap_or(0), del.parse().unwrap_or(0), binary));
    }
    result
}

fn untracked(root: &Path, path: Option<&str>) -> Result<Vec<String>, String> {
    let mut args = vec!["ls-files", "-z", "--others", "--exclude-standard"];
    if let Some(p) = path {
        args.extend(["--", p]);
    }
    Ok(git(root, &args)?
        .split('\0')
        .filter(|p| !p.is_empty() && !p.ends_with('/'))
        .map(String::from)
        .collect())
}

fn untracked_change(root: &Path, path: String) -> FileChange {
    let full = root.join(&path);
    let regular = std::fs::symlink_metadata(&full).is_ok_and(|m| m.is_file());
    let mut bytes = Vec::new();
    if regular {
        let _ = std::fs::File::open(&full).map(|f| f.take(MAX_PATCH_BYTES as u64 + 1).read_to_end(&mut bytes));
    }
    let binary = !regular || bytes.iter().take(BINARY_SNIFF_BYTES).any(|&b| b == 0);
    let additions = if binary || bytes.len() > MAX_PATCH_BYTES {
        0
    } else {
        let newlines = bytes.iter().filter(|&&b| b == b'\n').count();
        (newlines + usize::from(!bytes.is_empty() && !bytes.ends_with(b"\n"))) as u32
    };
    FileChange { path, old_path: None, status: Status::Added, additions, deletions: 0, binary }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::testutil::*;
    use tempfile::TempDir;

    fn work_tree(dir: &Path) -> DiffTarget {
        DiffTarget::WorkTree { dir: dir.to_path_buf() }
    }

    fn paths(changes: &[FileChange]) -> Vec<&str> {
        changes.iter().map(|c| c.path.as_str()).collect()
    }

    fn find<'a>(changes: &'a [FileChange], path: &str) -> &'a FileChange {
        changes.iter().find(|c| c.path == path).unwrap()
    }

    #[test]
    fn worktree_diff_includes_commits_uncommitted_and_untracked() {
        let dir = repo();
        let d = dir.path();
        commit_file(d, "b.txt", "b\n");
        run(d, &["checkout", "-q", "-b", "feat"]);
        commit_file(d, "a.txt", "a\n");
        std::fs::write(d.join("b.txt"), "b changed\n").unwrap();
        std::fs::write(d.join("c.txt"), "c\n").unwrap();
        let changes = summary(&work_tree(d)).unwrap();
        assert_eq!(paths(&changes), ["a.txt", "b.txt", "c.txt"]);
        assert_eq!(find(&changes, "c.txt").status, Status::Added);
        assert_eq!(find(&changes, "b.txt").status, Status::Modified);
    }

    #[test]
    fn branch_target_excludes_working_tree() {
        let dir = repo();
        let d = dir.path();
        run(d, &["checkout", "-q", "-b", "feat"]);
        commit_file(d, "a.txt", "a\n");
        run(d, &["checkout", "-q", "main"]);
        std::fs::write(d.join("README"), "dirty\n").unwrap();
        let target = DiffTarget::Branch { root: d.to_path_buf(), branch: "feat".into() };
        assert_eq!(paths(&summary(&target).unwrap()), ["a.txt"]);
    }

    #[test]
    fn default_branch_prefers_origin_head() {
        let src = repo();
        run(src.path(), &["branch", "-m", "main", "trunk"]);
        let dst = TempDir::new().unwrap();
        run(dst.path(), &["clone", "-q", src.path().to_str().unwrap(), "c"]);
        assert_eq!(default_branch(&dst.path().join("c")).as_deref(), Some("origin/trunk"));
    }

    #[test]
    fn base_falls_back_to_head_without_default() {
        let dir = repo();
        let d = dir.path();
        run(d, &["branch", "-m", "main", "develop"]);
        commit_file(d, "x.txt", "x\n");
        std::fs::write(d.join("README"), "dirty\n").unwrap();
        assert_eq!(default_branch(d), None);
        assert_eq!(paths(&summary(&work_tree(d)).unwrap()), ["README"]);
    }

    #[test]
    fn base_is_empty_tree_without_commits() {
        let dir = TempDir::new().unwrap();
        init(dir.path());
        std::fs::write(dir.path().join("new.txt"), "n\n").unwrap();
        let changes = summary(&work_tree(dir.path())).unwrap();
        assert_eq!(paths(&changes), ["new.txt"]);
        assert_eq!(changes[0].status, Status::Added);
    }

    #[test]
    fn summary_handles_special_paths() {
        let dir = repo();
        let d = dir.path();
        commit_file(d, "old.txt", "same content\n");
        commit_file(d, "gone.txt", "g\n");
        run(d, &["mv", "old.txt", "new.txt"]);
        std::fs::remove_file(d.join("gone.txt")).unwrap();
        std::fs::write(d.join("my file.txt"), "m\n").unwrap();
        std::fs::write(d.join("日本.txt"), "j\n").unwrap();
        let changes = summary(&work_tree(d)).unwrap();
        assert_eq!(paths(&changes), ["gone.txt", "my file.txt", "new.txt", "日本.txt"]);
        assert_eq!(find(&changes, "gone.txt").status, Status::Deleted);
        let renamed = find(&changes, "new.txt");
        assert_eq!(renamed.status, Status::Renamed);
        assert_eq!(renamed.old_path.as_deref(), Some("old.txt"));
        assert_eq!(find(&changes, "my file.txt").status, Status::Added);
    }

    #[test]
    fn binary_file_marked() {
        let dir = repo();
        std::fs::write(dir.path().join("bin.dat"), [0u8, 1, 2, 0, 255]).unwrap();
        let target = work_tree(dir.path());
        assert!(find(&summary(&target).unwrap(), "bin.dat").binary);
        assert!(patch(&target, "bin.dat", None).is_ok());
    }

    #[test]
    fn huge_patch_truncated() {
        let dir = repo();
        let d = dir.path();
        run(d, &["checkout", "-q", "-b", "feat"]);
        commit_file(d, "big.txt", &"0123456789abcdef\n".repeat(128 * 1024));
        let result = patch(&work_tree(d), "big.txt", None).unwrap();
        assert!(result.truncated);
        assert!(result.text.is_empty());
    }

    #[test]
    fn patch_shows_untracked_and_tracked_changes() {
        let dir = repo();
        let d = dir.path();
        std::fs::write(d.join("README"), "changed\n").unwrap();
        std::fs::write(d.join("new.txt"), "hello\n").unwrap();
        let target = work_tree(d);
        assert!(patch(&target, "README", None).unwrap().text.contains("+changed"));
        assert!(patch(&target, "new.txt", None).unwrap().text.contains("+hello"));
    }

    #[test]
    fn bracket_path_is_not_a_glob() {
        let dir = repo();
        let d = dir.path();
        commit_file(d, "[id].tsx", "old\n");
        std::fs::write(d.join("[id].tsx"), "new\n").unwrap();
        std::fs::write(d.join("i.tsx"), "untracked\n").unwrap();
        let text = patch(&work_tree(d), "[id].tsx", None).unwrap().text;
        assert!(text.contains("-old"), "{text}");
    }

    #[test]
    fn nested_repo_is_not_listed() {
        let dir = repo();
        let nested = dir.path().join("wt");
        std::fs::create_dir(&nested).unwrap();
        init(&nested);
        commit_file(&nested, "f.txt", "f\n");
        assert!(summary(&work_tree(dir.path())).unwrap().is_empty());
    }

    #[test]
    fn worktree_pin_is_gone_when_dir_is_missing() {
        let dir = TempDir::new().unwrap();
        let target = work_tree(&dir.path().join("deleted"));
        assert!(pin_status(&target).unwrap().is_none());
    }

    #[test]
    fn worktree_pin_errors_when_git_cannot_read_it() {
        let dir = TempDir::new().unwrap();
        assert!(pin_status(&work_tree(dir.path())).is_err());
    }

    #[test]
    fn worktree_pin_reports_its_branch() {
        let dir = repo();
        assert_eq!(pin_status(&work_tree(dir.path())).unwrap().unwrap().branch.as_deref(), Some("main"));
    }

    #[test]
    fn branch_pin_is_gone_when_branch_is_deleted() {
        let dir = repo();
        let target = DiffTarget::Branch { root: dir.path().to_path_buf(), branch: "feat".into() };
        assert!(pin_status(&target).unwrap().is_none());
        run(dir.path(), &["branch", "feat"]);
        assert_eq!(pin_status(&target).unwrap().unwrap().branch.as_deref(), Some("feat"));
    }

    #[test]
    fn branch_named_like_a_directory_still_diffs() {
        let dir = repo();
        let d = dir.path();
        run(d, &["checkout", "-q", "-b", "docs"]);
        commit_file(d, "docs/a.md", "a\n");
        run(d, &["checkout", "-q", "main"]);
        std::fs::create_dir_all(d.join("docs")).unwrap();
        let target = DiffTarget::Branch { root: d.to_path_buf(), branch: "docs".into() };
        assert_eq!(paths(&summary(&target).unwrap()), ["docs/a.md"]);
        assert!(patch(&target, "docs/a.md", None).unwrap().text.contains("+a"));
    }

    #[test]
    fn branch_shadowed_by_tag_uses_the_branch() {
        let dir = repo();
        let d = dir.path();
        run(d, &["tag", "foo"]);
        run(d, &["checkout", "-q", "-b", "foo"]);
        commit_file(d, "f.txt", "f\n");
        run(d, &["checkout", "-q", "main"]);
        let target = DiffTarget::Branch { root: d.to_path_buf(), branch: "foo".into() };
        assert_eq!(paths(&summary(&target).unwrap()), ["f.txt"]);
        assert!(pin_status(&target).unwrap().is_some());
    }

    #[test]
    fn user_git_config_does_not_change_patch_format() {
        let dir = repo();
        let d = dir.path();
        run(d, &["config", "color.ui", "always"]);
        run(d, &["config", "diff.external", "echo EXTERNAL"]);
        std::fs::write(d.join("README"), "changed\n").unwrap();
        let text = patch(&work_tree(d), "README", None).unwrap().text;
        assert!(text.contains("+changed"), "{text}");
        assert!(!text.contains('\x1b'));
    }

    #[test]
    fn untracked_fifo_does_not_block_summary() {
        let dir = repo();
        let fifo = dir.path().join("pipe");
        let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o644) }, 0);
        let target = work_tree(dir.path());
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || tx.send(summary(&target).is_ok()).unwrap());
        assert_eq!(rx.recv_timeout(std::time::Duration::from_secs(3)), Ok(true));
    }

    #[test]
    fn summary_outside_repo_errors() {
        let dir = TempDir::new().unwrap();
        assert!(summary(&work_tree(dir.path())).is_err());
    }
}
