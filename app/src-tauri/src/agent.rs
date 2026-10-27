use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

// The app is only a view over the laptop agent. When the agent is not
// running, the "not running" screen offers to start it with the berth CLI.
//
// A packaged app runs only the copy it carries, Contents/MacOS/berth-cli,
// and only while it is signed by the same team as the app itself: nothing
// on PATH, in ~/.local/bin or named by BERTH_CLI, which anything running as
// this user could plant (security audit M-4). An unsigned local build
// (make app-build without a signing identity) has no team to compare, so it
// runs its bundled copy as it is. A debug build (pnpm tauri dev) also
// honours BERTH_CLI, then the repository's bin/berth, then one installed in
// the usual places.

// The bundled CLI's name. It cannot be "berth": that is the app's own
// executable in Contents/MacOS (and target/debug), and macOS file names
// ignore case, so "Berth" would collide too.
pub const SIDECAR: &str = "berth-cli";

#[derive(Serialize)]
pub struct AgentBinary {
    path: String,
    // How it was found: "bundled", "repository" or "installed".
    source: &'static str,
}

#[cfg_attr(all(target_os = "linux", not(debug_assertions)), allow(dead_code))]
fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

// find_berth looks for the berth CLI: in a release build, only the bundled
// sidecar (bundled_sidecar); in a debug build, BERTH_CLI first, and the
// repository's and installed copies after the bundled one.
pub fn find_berth() -> Option<(PathBuf, &'static str)> {
    #[cfg(debug_assertions)]
    if let Some(p) = std::env::var_os("BERTH_CLI").filter(|p| !p.is_empty()) {
        let p = PathBuf::from(p);
        return is_executable(&p).then_some((p, "installed"));
    }
    if let Some(p) = bundled_sidecar() {
        return Some((p, "bundled"));
    }
    #[cfg(debug_assertions)]
    {
        // app/src-tauri is two levels below the repository; make puts berth in bin/.
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../bin/berth");
        if is_executable(&p) {
            return Some((p.canonicalize().unwrap_or(p), "repository"));
        }
        // An app started from Finder has a bare PATH, so look where berth is
        // usually installed rather than on it.
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Some(home) = dirs::home_dir() {
            candidates.push(home.join(".local/bin/berth"));
        }
        candidates.push(PathBuf::from("/opt/homebrew/bin/berth"));
        candidates.push(PathBuf::from("/usr/local/bin/berth"));
        return candidates.into_iter().find(|p| is_executable(p)).map(|p| (p, "installed"));
    }
    #[cfg(not(debug_assertions))]
    None
}

// bundled_sidecar is berth-cli beside the app's own executable. In a release
// build on macOS that must be the app bundle's Contents/MacOS, and berth-cli
// must be signed by the app's team. On Linux it is the app's staged copy, which
// outlives the app (linux.rs).
fn bundled_sidecar() -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    return crate::linux::staged_cli();
    #[cfg(not(target_os = "linux"))]
    bundled_beside_app()
}

#[cfg(not(target_os = "linux"))]
fn bundled_beside_app() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe = exe.canonicalize().unwrap_or(exe);
    let dir = exe.parent()?;
    #[cfg(all(target_os = "macos", not(debug_assertions)))]
    if !dir.ends_with("Contents/MacOS") {
        return None;
    }
    let p = dir.join(SIDECAR);
    if !is_executable(&p) {
        return None;
    }
    #[cfg(all(target_os = "macos", not(debug_assertions)))]
    if !signed_like(&exe, &p) {
        eprintln!("berth: {} is not signed by Shipkit's team; not running it", p.display());
        return None;
    }
    Some(p)
}

// signed_like is whether other is signed by the team that signed app. An app
// with no team (an unsigned or ad-hoc build) has nothing to hold it to.
#[cfg(target_os = "macos")]
#[cfg_attr(debug_assertions, allow(dead_code))]
pub fn signed_like(app: &Path, other: &Path) -> bool {
    let Some(team) = team_of(app) else {
        return true;
    };
    let requirement = format!("=anchor apple generic and certificate leaf[subject.OU] = \"{team}\"");
    Command::new("/usr/bin/codesign")
        .args(["--verify", "--strict", "-R"])
        .arg(requirement)
        .arg(other)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn team_of(path: &Path) -> Option<String> {
    let out = Command::new("/usr/bin/codesign").args(["-dv", "--verbose=2"]).arg(path).output().ok()?;
    // codesign describes on stderr.
    parse_team(&String::from_utf8_lossy(&out.stderr))
}

// parse_team reads TeamIdentifier from codesign -dv; "not set" is none.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_team(described: &str) -> Option<String> {
    described
        .lines()
        .find_map(|l| l.strip_prefix("TeamIdentifier="))
        .map(str::trim)
        .filter(|t| !t.is_empty() && *t != "not set")
        .map(str::to_string)
}

// run runs berth with args and returns what it printed, or why it failed.
// The agent it starts writes to its own log, not to these pipes, so this
// returns as soon as berth does.
pub fn run(bin: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new(bin)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("could not run {}: {e}", bin.display()))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("berth {} exited with {}", args.join(" "), out.status)
    })
}

#[tauri::command]
pub fn agent_binary() -> Option<AgentBinary> {
    find_berth().map(|(p, source)| AgentBinary {
        path: p.display().to_string(),
        source,
    })
}

// start_agent starts the agent now (`berth agent start`, which outlives the
// app), or with at_login installs it as a login service that starts it now
// and at every login (`berth agent install`: a launchd agent on macOS, a
// systemd user unit on Linux). The screen asks first: nothing is installed
// unless the person ticks "Start at login". A Linux session without systemd
// --user (a container, some minimal desktops) cannot have the service, so
// there the agent is started on its own instead, as without the tick.
#[tauri::command]
pub async fn start_agent(at_login: bool) -> Result<String, String> {
    let (bin, _) = find_berth().ok_or("Shipkit could not find its berth command")?;
    let args: &'static [&'static str] = if at_login {
        &["agent", "install"]
    } else {
        &["agent", "start"]
    };
    tauri::async_runtime::spawn_blocking(move || {
        let out = run(&bin, args);
        if cfg!(target_os = "linux") && at_login {
            if let Err(why) = &out {
                let started = run(&bin, &["agent", "start"])?;
                return Ok(format!("{started} It won't start at login: {why}"));
            }
        }
        out
    })
    .await
    .map_err(|e| e.to_string())?
}

// restart_stale_agent restarts the agent when it is older than the berth
// this app carries (`berth agent restart --if-stale`): after an update the
// agent started by the old app, or installed at login, goes on running the
// old code until something restarts it. It finishes its work under way
// first, and agents' sessions, in tmux on the boxes, keep running. Answers
// berth's JSON report (RestartResult in cmd/berth/agentprocess.go).
#[tauri::command]
pub async fn restart_stale_agent() -> Result<String, String> {
    let (bin, _) = find_berth().ok_or("Shipkit could not find its berth command")?;
    tauri::async_runtime::spawn_blocking(move || run(&bin, &["agent", "restart", "--if-stale", "--json"]))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    // In a debug build the repository's bin/berth is found (make build puts
    // it there), and `berth agent start` starts an agent that outlives the
    // call. It runs in its own BERTH_HOME so it cannot touch a real agent.
    #[test]
    fn starts_the_agent_from_the_repository() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../bin/berth");
        if !is_executable(&repo) {
            eprintln!("skipped: no bin/berth (run make build)");
            return;
        }
        let (bin, source) = find_berth().expect("bin/berth is found");
        assert_eq!(source, "repository");
        assert_eq!(bin, repo.canonicalize().unwrap());

        // Unix socket paths are short; a temp dir under /tmp keeps it so.
        let home = PathBuf::from(format!("/tmp/bt.{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("BERTH_HOME", &home);
        std::env::set_var("BERTH_USER_DIR", home.join("user"));
        let started = run(&bin, &["agent", "start"]);
        let status = run(&bin, &["agent", "status", "--json"]);
        let stopped = run(&bin, &["stop"]);
        let _ = std::fs::remove_dir_all(&home);
        assert_eq!(started.unwrap(), "The berth agent is running.");
        let status: String = status.unwrap().split_whitespace().collect();
        assert!(status.contains("\"running\":true"), "{status}");
        assert_eq!(stopped.unwrap(), "Stopped the berth agent.");
    }

    #[test]
    fn reads_the_team_from_codesign() {
        let signed = "Executable=/Applications/Berth.app/Contents/MacOS/berth\nAuthority=Developer ID Application: Someone (ABCDE12345)\nTeamIdentifier=ABCDE12345\n";
        assert_eq!(parse_team(signed).as_deref(), Some("ABCDE12345"));
        assert_eq!(parse_team("Signature=adhoc\nTeamIdentifier=not set\n"), None);
        assert_eq!(parse_team("code object is not signed at all"), None);
    }

    #[test]
    fn run_reports_why_berth_failed() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../bin/berth");
        if !is_executable(&repo) {
            return;
        }
        let err = run(&repo, &["agent", "nope"]).unwrap_err();
        assert!(err.contains("usage: berth agent"), "{err}");
    }
}
