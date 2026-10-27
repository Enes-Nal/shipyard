use serde::Serialize;
use std::path::{Path, PathBuf};

// "Install the berth command" in Settings → General. Shipkit.app carries the
// berth CLI as Contents/MacOS/berth-cli; this links ~/.local/bin/berth to it,
// so a terminal gets the same berth the app runs, and it updates with the
// app. Nothing happens until the person asks, and the screen says first
// what will be replaced.

#[derive(Serialize)]
pub struct CliLink {
    // Where the link goes: ~/.local/bin/berth.
    link: String,
    // The CLI inside this copy of Shipkit.app, or None in a dev build, which
    // has none to link to.
    bundled: Option<String>,
    // Why the bundled CLI cannot be linked yet: Shipkit is running from the
    // disk image or from a quarantined copy macOS moved aside.
    blocked: Option<String>,
    // What is at the link now: "missing", "linked" (to this app's CLI),
    // "symlink" (to something else) or "file" (a berth from the release
    // archive, say).
    state: &'static str,
    // Where a symlink at the link points.
    target: Option<String>,
}

fn link_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("no home directory")?;
    Ok(home.join(".local/bin/berth"))
}

fn bundled() -> Option<PathBuf> {
    // On Linux, the app's staged copy, which outlives it (linux.rs).
    #[cfg(target_os = "linux")]
    return crate::linux::staged_cli().filter(|p| crate::linux::stage_dir().is_some_and(|d| p.starts_with(d)));
    #[cfg(not(target_os = "linux"))]
    bundled_in_app()
}

#[cfg(not(target_os = "linux"))]
fn bundled_in_app() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    // Only a packaged app: Contents/MacOS/berth-cli.
    if !dir.ends_with("Contents/MacOS") {
        return None;
    }
    let p = dir.join(crate::agent::SIDECAR);
    p.is_file().then_some(p)
}

// A link into a mounted disk image or an App Translocation copy breaks as
// soon as the image is ejected or the app moved, so ask for the app to be
// in place first.
fn blocked(p: &Path) -> Option<String> {
    let s = p.to_string_lossy();
    if s.starts_with("/Volumes/") {
        return Some("Shipkit is running from its disk image. Drag it to Applications, open it from there, then install the command.".into());
    }
    if s.contains("/AppTranslocation/") {
        return Some("macOS is running Shipkit from a temporary copy. Move Shipkit to Applications, open it from there, then install the command.".into());
    }
    None
}

fn status() -> Result<CliLink, String> {
    let link = link_path()?;
    let bundled = bundled();
    let target = std::fs::read_link(&link).ok();
    let state = match std::fs::symlink_metadata(&link) {
        Err(_) => "missing",
        Ok(m) if m.file_type().is_symlink() => {
            if bundled.is_some() && target.as_deref() == bundled.as_deref() {
                "linked"
            } else {
                "symlink"
            }
        }
        Ok(_) => "file",
    };
    Ok(CliLink {
        link: link.display().to_string(),
        blocked: bundled.as_deref().and_then(blocked),
        bundled: bundled.map(|p| p.display().to_string()),
        state,
        target: target.map(|p| p.display().to_string()),
    })
}

#[tauri::command]
pub fn cli_link_status() -> Result<CliLink, String> {
    status()
}

// install_cli_link points ~/.local/bin/berth at this app's CLI. A symlink
// already there is replaced; a file (a berth from the release archive) is
// kept beside it as berth.previous, not deleted.
#[tauri::command]
pub fn install_cli_link() -> Result<CliLink, String> {
    let src = bundled().ok_or("this build of Shipkit carries no berth command to link to")?;
    if let Some(why) = blocked(&src) {
        return Err(why);
    }
    let link = link_path()?;
    let dir = link.parent().ok_or("no folder for the link")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    match std::fs::symlink_metadata(&link) {
        Ok(m) if m.file_type().is_symlink() => {
            std::fs::remove_file(&link).map_err(|e| format!("could not replace {}: {e}", link.display()))?;
        }
        Ok(m) if m.is_dir() => return Err(format!("{} is a folder; move it aside first", link.display())),
        Ok(_) => {
            let kept = link.with_file_name("berth.previous");
            std::fs::rename(&link, &kept).map_err(|e| format!("could not move {} aside: {e}", link.display()))?;
        }
        Err(_) => {}
    }
    symlink(&src, &link).map_err(|e| format!("could not link {}: {e}", link.display()))?;
    status()
}

#[cfg(unix)]
fn symlink(src: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(src, link)
}

#[cfg(not(unix))]
fn symlink(_: &Path, _: &Path) -> std::io::Result<()> {
    Err(std::io::Error::other("only on macOS and Linux"))
}
