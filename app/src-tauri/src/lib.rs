mod diff;
mod git;
mod pty;

use portable_pty::CommandBuilder;
use diff::DiffTarget;
use pty::PtyManager;
use tauri::ipc::{Channel, InvokeResponseBody};
use serde::Serialize;
use tauri::menu::{Menu, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TabLocation {
    cwd: String,
    repo_root: Option<String>,
    branch: Option<String>,
}

fn shell_command(lang: Option<std::ffi::OsString>) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into()));
    cmd.arg("-l");
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "k-shell");
    cmd.env("LANG", lang.unwrap_or_else(|| "en_US.UTF-8".into()));
    if let Ok(home) = std::env::var("HOME") {
        cmd.cwd(home);
    }
    cmd
}

#[tauri::command]
fn pty_spawn(
    id: u32,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    app: AppHandle,
    ptys: State<PtyManager>,
) -> Result<(), String> {
    ptys.spawn(
        id,
        shell_command(std::env::var_os("LANG")),
        cols,
        rows,
        move |bytes| {
            let _ = on_data.send(InvokeResponseBody::Raw(bytes));
        },
        move || {
            let _ = app.emit("pty-exit", id);
        },
    )
}

#[tauri::command]
fn pty_write(id: u32, data: String, ptys: State<PtyManager>) -> Result<(), String> {
    ptys.write(id, data.as_bytes())
}

#[tauri::command]
fn pty_resize(id: u32, cols: u16, rows: u16, ptys: State<PtyManager>) -> Result<(), String> {
    ptys.resize(id, cols, rows)
}

#[tauri::command]
async fn pty_kill(id: u32, ptys: State<'_, PtyManager>) -> Result<(), String> {
    ptys.kill(id);
    Ok(())
}

#[tauri::command]
async fn pty_kill_all(ptys: State<'_, PtyManager>) -> Result<(), String> {
    ptys.kill_all();
    Ok(())
}

#[tauri::command]
fn pty_ack(id: u32, bytes: usize, ptys: State<PtyManager>) {
    ptys.ack(id, bytes);
}

#[tauri::command]
async fn tab_location(id: u32, with_git: bool, ptys: State<'_, PtyManager>) -> Result<Option<TabLocation>, String> {
    let Some(cwd) = ptys.foreground_cwd(id) else { return Ok(None) };
    let repo = with_git.then(|| git::repo_info(&cwd)).flatten();
    Ok(Some(TabLocation {
        cwd: cwd.to_string_lossy().into_owned(),
        repo_root: repo.as_ref().map(|r| r.root.to_string_lossy().into_owned()),
        branch: repo.and_then(|r| r.branch),
    }))
}

#[tauri::command]
async fn pin_status(target: DiffTarget) -> Result<Option<diff::PinStatus>, String> {
    diff::pin_status(&target)
}

#[tauri::command]
async fn diff_summary(target: DiffTarget) -> Result<Vec<diff::FileChange>, String> {
    diff::summary(&target)
}

#[tauri::command]
async fn diff_patch(target: DiffTarget, path: String, old_path: Option<String>) -> Result<diff::Patch, String> {
    diff::patch(&target, &path, old_path.as_deref())
}

#[tauri::command]
async fn git_targets(root: String) -> Result<Vec<git::GitTarget>, String> {
    git::list_targets(std::path::Path::new(&root))
}

#[tauri::command]
fn stress_mode() -> bool {
    std::env::var("K_SHELL_STRESS").is_ok()
}

#[tauri::command]
fn mark(label: String) {
    let Ok(path) = std::env::var("K_SHELL_MARKS") else { return };
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        use std::io::Write;
        let _ = writeln!(f, "{ts} {label}");
    }
}

fn app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let main = Submenu::with_items(app, "k-shell", true, &[&PredefinedMenuItem::quit(app, None)?])?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&main, &edit])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .menu(app_menu)
        .manage(PtyManager::default())
        .invoke_handler(tauri::generate_handler![pty_spawn, pty_write, pty_resize, pty_kill, pty_kill_all, pty_ack, tab_location, pin_status, diff_summary, diff_patch, git_targets, stress_mode, mark])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_command_defaults_to_utf8_and_truecolor() {
        let cmd = shell_command(None);
        assert_eq!(cmd.get_env("LANG").and_then(|v| v.to_str()), Some("en_US.UTF-8"));
        assert_eq!(cmd.get_env("COLORTERM").and_then(|v| v.to_str()), Some("truecolor"));
    }

    #[test]
    fn shell_command_keeps_existing_lang() {
        let cmd = shell_command(Some("zh_CN.UTF-8".into()));
        assert_eq!(cmd.get_env("LANG").and_then(|v| v.to_str()), Some("zh_CN.UTF-8"));
    }
}
