use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const FLUSH_INTERVAL: Duration = Duration::from_millis(8);
const FLUSH_BYTES: usize = 1024 * 1024;
const MAX_UNACKED: usize = 5 * 1024 * 1024;
const READ_QUEUE_CHUNKS: usize = 16;

#[derive(Default)]
struct FlowState {
    unacked: usize,
    closed: bool,
}

#[derive(Default)]
struct Flow {
    state: Mutex<FlowState>,
    acked: Condvar,
}

impl Flow {
    fn wait_for_room(&self) {
        let state = self.state.lock().unwrap();
        drop(self.acked.wait_while(state, |s| s.unacked > MAX_UNACKED && !s.closed).unwrap());
    }

    fn sent(&self, bytes: usize) {
        self.state.lock().unwrap().unacked += bytes;
    }

    fn ack(&self, bytes: usize) {
        let mut state = self.state.lock().unwrap();
        state.unacked = state.unacked.saturating_sub(bytes);
        self.acked.notify_all();
    }

    fn close(&self) {
        self.state.lock().unwrap().closed = true;
        self.acked.notify_all();
    }
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    input: mpsc::Sender<Vec<u8>>,
    child: Box<dyn Child + Send + Sync>,
    flow: Arc<Flow>,
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
        self.kill(id);
        let pair = native_pty_system()
            .openpty(size(cols, rows))
            .map_err(|e| e.to_string())?;
        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let (tx, rx) = mpsc::sync_channel(READ_QUEUE_CHUNKS);
        std::thread::spawn(move || read_loop(reader, tx));
        let (input, pending) = mpsc::channel();
        std::thread::spawn(move || write_loop(writer, pending));
        let flow = Arc::new(Flow::default());
        let batch_flow = flow.clone();
        std::thread::spawn(move || {
            batch_loop(rx, &batch_flow, on_data);
            on_exit();
        });
        self.sessions
            .lock()
            .unwrap()
            .insert(id, Session { master: pair.master, input, child, flow });
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

    pub fn ack(&self, id: u32, bytes: usize) {
        if let Some(session) = self.sessions.lock().unwrap().get(&id) {
            session.flow.ack(bytes);
        }
    }

    pub fn kill_all(&self) {
        let ids: Vec<u32> = self.sessions.lock().unwrap().keys().copied().collect();
        ids.into_iter().for_each(|id| self.kill(id));
    }

    pub fn kill(&self, id: u32) {
        let removed = self.sessions.lock().unwrap().remove(&id);
        if let Some(mut session) = removed {
            session.flow.close();
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

fn read_loop(mut reader: Box<dyn Read + Send>, tx: mpsc::SyncSender<Vec<u8>>) {
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        match reader.read(&mut buf) {
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
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

fn batch_loop(rx: mpsc::Receiver<Vec<u8>>, flow: &Flow, on_data: impl Fn(Vec<u8>)) {
    loop {
        flow.wait_for_room();
        let Ok(mut batch) = rx.recv() else { break };
        let deadline = Instant::now() + FLUSH_INTERVAL;
        while batch.len() < FLUSH_BYTES {
            match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(more) => batch.extend_from_slice(&more),
                Err(_) => break,
            }
        }
        flow.sent(batch.len());
        on_data(batch);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

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
    fn unacknowledged_output_pauses_the_reader() {
        let mgr = PtyManager::default();
        let out = collect(&mgr, 1, "yes 0123456789 | head -c 50000000");
        std::thread::sleep(Duration::from_secs(2));
        let received = out.lock().unwrap().len();
        assert!(received <= MAX_UNACKED + FLUSH_BYTES, "received {received}");
        mgr.ack(1, received);
        assert!(wait_until(Duration::from_secs(2), || out.lock().unwrap().len() > received));
        mgr.kill(1);
    }

    #[test]
    fn spawning_an_existing_id_replaces_the_old_session() {
        let mgr = PtyManager::default();
        let exited = Arc::new(AtomicBool::new(false));
        let flag = exited.clone();
        mgr.spawn(1, sh("sleep 30"), 80, 24, |_| {}, move || flag.store(true, Ordering::SeqCst)).unwrap();
        collect(&mgr, 1, "sleep 30");
        assert!(wait_until(Duration::from_secs(2), || exited.load(Ordering::SeqCst)));
        mgr.kill(1);
    }

    #[test]
    fn kill_all_ends_every_session() {
        let mgr = PtyManager::default();
        collect(&mgr, 1, "sleep 30");
        collect(&mgr, 2, "sleep 30");
        mgr.kill_all();
        assert!(mgr.write(1, b"x").is_err());
        assert!(mgr.write(2, b"x").is_err());
    }

    #[test]
    fn kill_removes_session() {
        let mgr = PtyManager::default();
        collect(&mgr, 1, "sleep 10");
        mgr.kill(1);
        assert!(mgr.write(1, b"x").is_err());
    }
}
