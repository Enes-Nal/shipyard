// What the Linux app (an alpha) does differently from the Mac app.
//
// The agent outlives the app: `berth agent start` detaches it, and `berth
// agent install` makes it a systemd user unit (internal/service). Either way
// it runs from a path that must still be there after the app quits and after
// it updates. The app's own copy is not such a path: an AppImage runs from a
// FUSE mount (/tmp/.mount_…) that changes at every launch and goes away
// when the app quits, and the .deb keeps the CLI in /usr/bin but the Linux
// daemons and tmux, which berth uploads to boxes, in /usr/lib/Terminal, where
// berth does not look for them.
//
// So the packaged app stages what it carries into one folder of its own,
// berth (the CLI) beside berthd, berthd-linux-*, and tmux-linux-*, as a build
// directory has them (berth's readDaemon and the agent's bundledBerthd look
// beside the berth that runs). It is BERTH_HOME/app when BERTH_HOME is set,
// otherwise ~/.local/share/berth/app. A file is replaced only when it
// differs from the app's, by renaming a new copy over it, so a running agent
// keeps its own executable and `berth agent restart --if-stale` sees the
// new build as newer. The app always runs the staged berth, checked against
// its own copy each time it starts.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tauri::{AppHandle, Manager, Runtime};

// The app's resources: the Linux daemons, tmux, and this computer's berthd.
const RESOURCES: [&str; 5] = [
    "berthd",
    "berthd-linux-amd64",
    "berthd-linux-arm64",
    "tmux-linux-amd64",
    "tmux-linux-arm64",
];

static RESOURCE_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
static STAGED: OnceLock<Option<PathBuf>> = OnceLock::new();

// setup notes where the app's resources are and stages them in the
// background, so the window does not wait for ~70 MB of copying on the first
// launch after an install or update.
pub fn setup<R: Runtime>(app: &AppHandle<R>) {
    let _ = RESOURCE_DIR.set(app.path().resource_dir().ok());
    std::thread::spawn(staged_cli);
    // An AppImage has no .desktop file of its own installed, so berth:// links
    // would not reach it: register the handler for this AppImage's path. The
    // .deb's desktop file declares the scheme itself.
    #[cfg(not(debug_assertions))]
    if app.env().appimage.is_some() {
        use tauri_plugin_deep_link::DeepLinkExt;
        if let Err(e) = app.deep_link().register_all() {
            eprintln!("berth: could not register berth:// links: {e}");
        }
    }
}

// staged_cli is the berth the app runs: the staged copy of its bundled CLI,
// or None in a build that carries none (pnpm tauri dev). Staging runs once a
// launch; a second caller waits for the first.
pub fn staged_cli() -> Option<PathBuf> {
    STAGED
        .get_or_init(|| {
            let bundled = bundled_cli()?;
            match stage(&bundled) {
                Ok(p) => Some(p),
                Err(e) => {
                    // The bundled copy still works for this launch.
                    eprintln!("berth: could not stage the berth command ({e}); running {}", bundled.display());
                    Some(bundled)
                }
            }
        })
        .clone()
}

// bundled_cli is berth-cli beside the app's executable: /usr/bin in the .deb,
// usr/bin inside the AppImage.
fn bundled_cli() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let p = exe.parent()?.join(crate::agent::SIDECAR);
    p.is_file().then_some(p)
}

pub fn stage_dir() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("BERTH_HOME").filter(|h| !h.is_empty()) {
        return Some(PathBuf::from(home).join("app"));
    }
    Some(dirs::data_local_dir()?.join("berth").join("app"))
}

fn stage(cli: &Path) -> std::io::Result<PathBuf> {
    let dir = stage_dir().ok_or_else(|| std::io::Error::other("no home directory"))?;
    fs::create_dir_all(&dir)?;
    let berth = dir.join("berth");
    sync(cli, &berth)?;
    if let Some(Some(res)) = RESOURCE_DIR.get() {
        for name in RESOURCES {
            let src = res.join(name);
            if src.is_file() {
                sync(&src, &dir.join(name))?;
            }
        }
    }
    Ok(berth)
}

// sync makes dst a copy of src, executable, unless it already is one.
fn sync(src: &Path, dst: &Path) -> std::io::Result<()> {
    if same(src, dst).unwrap_or(false) {
        return Ok(());
    }
    let tmp = dst.with_extension(format!("new.{}", std::process::id()));
    fs::copy(src, &tmp)?;
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o755))?;
    }
    fs::rename(&tmp, dst).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

fn same(a: &Path, b: &Path) -> std::io::Result<bool> {
    let (ma, mb) = (fs::metadata(a)?, fs::metadata(b)?);
    if ma.len() != mb.len() {
        return Ok(false);
    }
    let (mut fa, mut fb) = (fs::File::open(a)?, fs::File::open(b)?);
    let (mut ba, mut bb) = (vec![0u8; 1 << 16], vec![0u8; 1 << 16]);
    loop {
        let n = fa.read(&mut ba)?;
        if n == 0 {
            return Ok(true);
        }
        fb.read_exact(&mut bb[..n])?;
        if ba[..n] != bb[..n] {
            return Ok(false);
        }
    }
}

// prefer_compatible_rendering turns off WebKitGTK's DMA-BUF renderer under
// NVIDIA's driver, where it leaves the window blank, unless the person chose
// otherwise. It must run before the first webview exists.
pub fn prefer_compatible_rendering() {
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() && Path::new("/sys/module/nvidia").exists() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

// open_terminal starts the person's terminal: $TERMINAL, the Debian
// alternative, then the usual ones.
pub fn open_terminal() -> Result<(), String> {
    let mut tried = Vec::new();
    if let Ok(t) = std::env::var("TERMINAL") {
        if !t.is_empty() {
            tried.push(t);
        }
    }
    for t in [
        "x-terminal-emulator",
        "xdg-terminal-exec",
        "gnome-terminal",
        "konsole",
        "kitty",
        "alacritty",
        "ghostty",
        "foot",
        "wezterm",
        "xfce4-terminal",
        "xterm",
    ] {
        tried.push(t.to_string());
    }
    for t in &tried {
        if std::process::Command::new(t)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
    }
    Err("couldn't find a terminal to open; set $TERMINAL to yours".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_copies_once_and_replaces_a_changed_file() {
        let dir = std::env::temp_dir().join(format!("berth-stage-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let (src, dst) = (dir.join("src"), dir.join("dst"));
        fs::write(&src, b"one").unwrap();
        sync(&src, &dst).unwrap();
        assert_eq!(fs::read(&dst).unwrap(), b"one");
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(&dst).unwrap().permissions().mode() & 0o777, 0o755);
        assert!(same(&src, &dst).unwrap());
        fs::write(&src, b"two").unwrap();
        assert!(!same(&src, &dst).unwrap());
        sync(&src, &dst).unwrap();
        assert_eq!(fs::read(&dst).unwrap(), b"two");
        let _ = fs::remove_dir_all(&dir);
    }
}
