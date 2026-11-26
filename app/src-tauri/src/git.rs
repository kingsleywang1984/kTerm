use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug)]
pub struct RepoInfo {
    pub root: PathBuf,
    pub branch: Option<String>,
}

pub(crate) fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    git_with_codes(dir, args, &[0])
}

pub(crate) fn git_with_codes(dir: &Path, args: &[&str], ok_codes: &[i32]) -> Result<String, String> {
    Ok(git_capped(dir, args, ok_codes, usize::MAX)?.unwrap_or_default())
}

pub(crate) fn git_capped(dir: &Path, args: &[&str], ok_codes: &[i32], max: usize) -> Result<Option<String>, String> {
    let mut child = Command::new("git")
        .current_dir(dir)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .args(["-c", "color.ui=never", "-c", "core.quotepath=off"])
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdout = Vec::new();
    let limit = max.saturating_add(1) as u64;
    child.stdout.take().unwrap().take(limit).read_to_end(&mut stdout).map_err(|e| e.to_string())?;
    if stdout.len() > max {
        let _ = child.kill();
        let _ = child.wait();
        return Ok(None);
    }
    let mut stderr = String::new();
    let _ = child.stderr.take().unwrap().read_to_string(&mut stderr);
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.code().is_some_and(|c| ok_codes.contains(&c)) {
        return Err(stderr.trim().to_string());
    }
    Ok(Some(String::from_utf8_lossy(&stdout).into_owned()))
}

pub(crate) fn repo_root(dir: &Path) -> Result<PathBuf, String> {
    let root = git(dir, &["rev-parse", "--show-toplevel"]).map_err(|_| "Not a git repository".to_string())?;
    Ok(PathBuf::from(root.trim()))
}

pub(crate) fn ref_exists(root: &Path, reference: &str) -> Result<bool, String> {
    Ok(!git_with_codes(root, &["rev-parse", "--verify", "-q", reference], &[0, 1])?.trim().is_empty())
}

pub fn repo_info(dir: &Path) -> Option<RepoInfo> {
    let root = repo_root(dir).ok()?;
    let branch = git(dir, &["symbolic-ref", "--short", "-q", "HEAD"])
        .ok()
        .map(|b| b.trim().to_string());
    Some(RepoInfo { root, branch })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitTarget {
    pub branch: Option<String>,
    pub worktree: Option<PathBuf>,
    pub is_current: bool,
}

pub fn list_targets(root: &Path) -> Result<Vec<GitTarget>, String> {
    let current = root.canonicalize().ok();
    let mut targets: Vec<GitTarget> = git(root, &["worktree", "list", "--porcelain"])?
        .split("\n\n")
        .filter_map(|block| {
            let path = PathBuf::from(block.lines().find_map(|l| l.strip_prefix("worktree "))?);
            let branch = block
                .lines()
                .find_map(|l| l.strip_prefix("branch refs/heads/"))
                .map(String::from);
            let is_current = path.canonicalize().ok() == current;
            Some(GitTarget { branch, worktree: Some(path), is_current })
        })
        .collect();
    let free: Vec<GitTarget> = git(root, &["for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads"])?
        .lines()
        .filter(|b| !targets.iter().any(|t| t.branch.as_deref() == Some(*b)))
        .map(|b| GitTarget { branch: Some(b.to_string()), worktree: None, is_current: false })
        .collect();
    targets.extend(free);
    Ok(targets)
}

#[cfg(test)]
pub(crate) mod testutil {
    use std::path::Path;
    use std::process::Command;
    use tempfile::TempDir;

    pub fn run(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").current_dir(dir).args(args).output().unwrap();
        assert!(out.status.success(), "git {:?}: {}", args, String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap()
    }

    pub fn init(dir: &Path) {
        run(dir, &["init", "-q", "-b", "main"]);
        run(dir, &["config", "user.email", "t@t"]);
        run(dir, &["config", "user.name", "t"]);
        run(dir, &["config", "commit.gpgsign", "false"]);
    }

    pub fn commit_file(dir: &Path, path: &str, content: &str) {
        let full = dir.join(path);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, content).unwrap();
        run(dir, &["add", "-A"]);
        run(dir, &["commit", "-q", "-m", path]);
    }

    pub fn repo() -> TempDir {
        let dir = TempDir::new().unwrap();
        init(dir.path());
        commit_file(dir.path(), "README", "init\n");
        dir
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::*;
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn repo_info_reports_root_and_branch() {
        let dir = repo();
        let sub = dir.path().join("a/b");
        std::fs::create_dir_all(&sub).unwrap();
        let info = repo_info(&sub).unwrap();
        assert_eq!(info.root, dir.path().canonicalize().unwrap());
        assert_eq!(info.branch.as_deref(), Some("main"));
    }

    #[test]
    fn repo_info_outside_repo_is_none() {
        let dir = TempDir::new().unwrap();
        assert!(repo_info(dir.path()).is_none());
    }

    #[test]
    fn targets_list_worktrees_then_free_branches() {
        let dir = repo();
        let d = dir.path().canonicalize().unwrap();
        let wt = d.parent().unwrap().join(format!("{}-x", d.file_name().unwrap().to_str().unwrap()));
        run(&d, &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "x"]);
        run(&d, &["branch", "y"]);
        let targets = list_targets(&d).unwrap();
        let summary: Vec<_> = targets
            .iter()
            .map(|t| (t.branch.as_deref(), t.worktree.clone(), t.is_current))
            .collect();
        assert_eq!(
            summary,
            [(Some("main"), Some(d.clone()), true), (Some("x"), Some(wt.clone()), false), (Some("y"), None, false)]
        );
        std::fs::remove_dir_all(wt).unwrap();
    }

    #[test]
    fn targets_list_branch_shadowed_by_tag_by_its_name() {
        let dir = repo();
        run(dir.path(), &["tag", "foo"]);
        run(dir.path(), &["branch", "foo"]);
        let branches: Vec<_> = list_targets(dir.path()).unwrap().into_iter().filter_map(|t| t.branch).collect();
        assert_eq!(branches, ["main", "foo"]);
    }

    #[test]
    fn repo_info_detached_has_no_branch() {
        let dir = repo();
        run(dir.path(), &["checkout", "-q", "--detach"]);
        assert_eq!(repo_info(dir.path()).unwrap().branch, None);
    }
}
