use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

// The desk (cmd/berth-desk, internal/desk) is the app's backend on Windows:
// the projects, the chats and the agents they run. The app starts it on a
// free loopback port and reads one line from it, {"url","token"}, which the
// webview asks for with desk_endpoint. Its stdin stays open while the app
// runs; when the app ends, however it ends, the pipe closes and the desk
// stops its agents and exits.

const BIN: &str = "berth-desk";

#[derive(Clone, Serialize, Deserialize)]
pub struct DeskEndpoint {
    url: String,
    token: String,
}

enum Ready {
    Waiting,
    Up(DeskEndpoint),
    Failed(String),
}

struct Desk {
    ready: Mutex<Ready>,
    changed: Condvar,
    child: Mutex<Option<(Child, ChildStdin)>>,
}

static DESK: Desk = Desk { ready: Mutex::new(Ready::Waiting), changed: Condvar::new(), child: Mutex::new(None) };

fn set(r: Ready) {
    *DESK.ready.lock().unwrap() = r;
    DESK.changed.notify_all();
}

// binary is berth-desk beside the app's own executable, and in a debug
// build the repository's bin/ (scripts/ensure-windows-agent.mjs builds it).
fn binary() -> Option<PathBuf> {
    let name = format!("{BIN}{}", std::env::consts::EXE_SUFFIX);
    let beside = std::env::current_exe().ok()?.parent()?.join(&name);
    if beside.is_file() {
        return Some(beside);
    }
    #[cfg(debug_assertions)]
    {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../bin").join(&name);
        if p.is_file() {
            return Some(p.canonicalize().unwrap_or(p));
        }
    }
    None
}

// start runs the desk once, as the app starts.
pub fn start() {
    let Some(bin) = binary() else {
        set(Ready::Failed(format!("{BIN} isn't beside the app; build it with `go build -o bin/{BIN}.exe ./cmd/{BIN}`")));
        return;
    };
    let mut cmd = Command::new(&bin);
    cmd.args(["-addr", "127.0.0.1:0", "-stdin"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return set(Ready::Failed(format!("couldn't start {}: {e}", bin.display()))),
    };
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let stdin = child.stdin.take().expect("piped stdin");
    *DESK.child.lock().unwrap() = Some((child, stdin));
    std::thread::spawn(move || {
        let mut line = String::new();
        let read = BufReader::new(stdout).read_line(&mut line);
        match (read, serde_json::from_str::<DeskEndpoint>(line.trim())) {
            (Ok(n), Ok(ep)) if n > 0 => set(Ready::Up(ep)),
            _ => {
                // It ended before it listened: say what it said.
                let mut why = String::new();
                for l in BufReader::new(stderr).lines().map_while(Result::ok).take(20) {
                    why.push_str(&l);
                    why.push('\n');
                }
                set(Ready::Failed(if why.trim().is_empty() { format!("{BIN} stopped as it started") } else { why.trim().to_string() }));
            }
        }
    });
}

// stop ends the desk as the app exits.
pub fn stop() {
    if let Some((mut child, stdin)) = DESK.child.lock().unwrap().take() {
        drop(stdin);
        for _ in 0..30 {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = child.kill();
    }
}

// desk_endpoint waits, off the main thread, for the desk to say where it is.
#[tauri::command]
pub async fn desk_endpoint() -> Result<DeskEndpoint, String> {
    tauri::async_runtime::spawn_blocking(wait_ready).await.map_err(|e| e.to_string())?
}

fn wait_ready() -> Result<DeskEndpoint, String> {
    let guard = DESK.ready.lock().unwrap();
    let (guard, _) = DESK.changed.wait_timeout_while(guard, Duration::from_secs(15), |r| matches!(r, Ready::Waiting)).unwrap();
    match &*guard {
        Ready::Up(ep) => Ok(ep.clone()),
        Ready::Failed(why) => Err(why.clone()),
        Ready::Waiting => Err(format!("{BIN} didn't start in time")),
    }
}

// pick_folder shows the system's folder picker, for adding a project.
#[tauri::command]
pub async fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().set_title("Add a project folder").pick_folder(move |p| {
        let _ = tx.send(p);
    });
    tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten().and_then(|p| p.into_path().ok()).map(|p| p.display().to_string()))
        .await
        .ok()
        .flatten()
}
