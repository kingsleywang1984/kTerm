use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const FLUSH_INTERVAL: Duration = Duration::from_millis(8);
const FLUSH_BYTES: usize = 1024 * 1024;

struct Session {
    master: Box<dyn MasterPty + Send>,
    input: mpsc::Sender<Vec<u8>>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<u32, Session>>,
}

impl PtyManager {
    pub fn spawn(
        &self,
        id: u32,
        cmd: CommandBuilder,
        cols: u16,
        rows: u16,
        on_data: impl Fn(Vec<u8>) + Send + 'static,
        on_exit: impl FnOnce() + Send + 'static,
    ) -> Result<(), String> {
        let pair = native_pty_system()
            .openpty(size(cols, rows))
            .map_err(|e| e.to_string())?;
        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || read_loop(reader, tx));
        let (input, pending) = mpsc::channel();
        std::thread::spawn(move || write_loop(writer, pending));
        std::thread::spawn(move || {
            batch_loop(rx, on_data);
            on_exit();
        });
        self.sessions
            .lock()
            .unwrap()
            .insert(id, Session { master: pair.master, input, child });
        Ok(())
    }

    pub fn write(&self, id: u32, data: &[u8]) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions.get(&id).ok_or("no session")?;
        session.input.send(data.to_vec()).map_err(|e| e.to_string())
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions.get(&id).ok_or("no session")?;
        session.master.resize(size(cols, rows)).map_err(|e| e.to_string())
    }

    pub fn kill(&self, id: u32) {
        let removed = self.sessions.lock().unwrap().remove(&id);
        if let Some(mut session) = removed {
            let _ = session.child.kill();
            std::thread::spawn(move || {
                let _ = session.child.wait();
            });
        }
    }

    pub fn foreground_cwd(&self, id: u32) -> Option<PathBuf> {
        let pid = self.sessions.lock().unwrap().get(&id)?.master.process_group_leader()?;
        process_cwd(pid)
    }
}

fn process_cwd(pid: libc::pid_t) -> Option<PathBuf> {
    let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
    let ret = unsafe {
        libc::proc_pidinfo(pid, libc::PROC_PIDVNODEPATHINFO, 0, &mut info as *mut _ as *mut libc::c_void, size)
    };
    if ret != size {
        return None;
    }
    let path = unsafe { std::ffi::CStr::from_ptr(info.pvi_cdir.vip_path.as_ptr() as *const libc::c_char) };
    Some(PathBuf::from(path.to_str().ok()?))
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }
}

fn read_loop(mut reader: Box<dyn Read + Send>, tx: mpsc::Sender<Vec<u8>>) {
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        }
    }
}

fn write_loop(mut writer: Box<dyn Write + Send>, pending: mpsc::Receiver<Vec<u8>>) {
    while let Ok(data) = pending.recv() {
        if writer.write_all(&data).is_err() {
            break;
        }
    }
}

fn batch_loop(rx: mpsc::Receiver<Vec<u8>>, on_data: impl Fn(Vec<u8>)) {
    while let Ok(mut batch) = rx.recv() {
        let deadline = Instant::now() + FLUSH_INTERVAL;
        while batch.len() < FLUSH_BYTES {
            match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(more) => batch.extend_from_slice(&more),
                Err(_) => break,
            }
        }
        on_data(batch);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use portable_pty::CommandBuilder;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    fn sh(script: &str) -> CommandBuilder {
        let mut cmd = CommandBuilder::new("sh");
        cmd.args(["-c", script]);
        cmd
    }

    fn wait_until(timeout: Duration, mut f: impl FnMut() -> bool) -> bool {
        let start = Instant::now();
        while start.elapsed() < timeout {
            if f() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    fn collect(mgr: &PtyManager, id: u32, script: &str) -> Arc<Mutex<Vec<u8>>> {
        let out = Arc::new(Mutex::new(Vec::new()));
        let sink = out.clone();
        mgr.spawn(id, sh(script), 80, 24, move |b| sink.lock().unwrap().extend(b), || {})
            .unwrap();
        out
    }

    #[test]
    fn output_is_delivered() {
        let mgr = PtyManager::default();
        let out = collect(&mgr, 1, "printf hello");
        assert!(wait_until(Duration::from_secs(2), || {
            out.lock().unwrap().windows(5).any(|w| w == b"hello")
        }));
    }

    #[test]
    fn large_output_is_complete() {
        let mgr = PtyManager::default();
        let out = collect(&mgr, 1, "yes 0123456789 | head -n 100000");
        let lines = || out.lock().unwrap().iter().filter(|&&b| b == b'\n').count();
        assert!(wait_until(Duration::from_secs(10), || lines() >= 100000));
        assert_eq!(lines(), 100000);
    }

    #[test]
    fn exit_callback_fires() {
        let mgr = PtyManager::default();
        let exited = Arc::new(AtomicBool::new(false));
        let flag = exited.clone();
        mgr.spawn(1, sh("exit 0"), 80, 24, |_| {}, move || flag.store(true, Ordering::SeqCst))
            .unwrap();
        assert!(wait_until(Duration::from_secs(2), || exited.load(Ordering::SeqCst)));
    }

    #[test]
    fn foreground_cwd_follows_cd() {
        let mgr = PtyManager::default();
        collect(&mgr, 1, "cd /tmp && sleep 3");
        assert!(wait_until(Duration::from_secs(2), || {
            mgr.foreground_cwd(1) == Some(PathBuf::from("/private/tmp"))
        }));
    }

    #[test]
    fn write_does_not_block_when_child_is_not_reading() {
        let mgr = PtyManager::default();
        collect(&mgr, 1, "stty raw -echo; sleep 5");
        std::thread::sleep(Duration::from_millis(200));
        let start = Instant::now();
        mgr.write(1, &vec![b'x'; 64 * 1024]).unwrap();
        assert!(start.elapsed() < Duration::from_millis(500));
        mgr.kill(1);
    }

    #[test]
    fn exit_fires_while_background_job_holds_terminal() {
        let mgr = PtyManager::default();
        let exited = Arc::new(AtomicBool::new(false));
        let flag = exited.clone();
        mgr.spawn(1, sh("sleep 30 & exit 0"), 80, 24, |_| {}, move || flag.store(true, Ordering::SeqCst))
            .unwrap();
        assert!(wait_until(Duration::from_secs(2), || exited.load(Ordering::SeqCst)));
    }

    #[test]
    fn kill_releases_io_threads_when_job_ignores_hangup() {
        let mgr = PtyManager::default();
        let token = Arc::new(());
        let held = token.clone();
        mgr.spawn(1, sh("(trap '' HUP; sleep 30) & sleep 30"), 80, 24, move |_| {
            let _ = &held;
        }, || {})
            .unwrap();
        std::thread::sleep(Duration::from_millis(200));
        mgr.kill(1);
        assert!(wait_until(Duration::from_secs(2), || Arc::strong_count(&token) == 1));
    }

    #[test]
    fn kill_removes_session() {
        let mgr = PtyManager::default();
        collect(&mgr, 1, "sleep 10");
        mgr.kill(1);
        assert!(mgr.write(1, b"x").is_err());
    }
}
