# shellcheck shell=bash
# The Mac half of the release tests: a home, ports, launchd labels and an
# app of their own, so a test never touches this Mac's own Terminal. Sourced
# by scripts/fresh-user-test.sh and scripts/upgrade-test.sh after common.sh.
#
# What "its own" means:
#  - HOME is a fresh folder: Terminal's state (~/Library/Application Support/
#    berth), ~/.berth, ~/.claude, the sample project in ~/work all land in it.
#  - The agent listens on free ports (the app's on BERTH_UI_PORT, from 9378
#    up; the proxy from 9377 up), never 1377-1379.
#  - launchd jobs get labels of their own (macos/launchctl), and tmux a
#    socket folder of its own (TMUX_TMPDIR), so the box's sessions are never
#    in the person's tmux server.
#  - The app is a copy of the one in the dmg with its own bundle identifier,
#    so its webview storage (where the layout and preferences live) is not
#    the installed Terminal's, and with the agent's port changed from 1378 to
#    BERTH_UI_PORT: the same length, in the binary and its CSP, which the
#    app has no setting for. Changing it breaks the Developer ID signature,
#    so the copy is signed again ad hoc, with the hardened runtime; its
#    berth-cli and berthd keep their own signatures, and the agent still
#    checks berthd's against berth-cli's team as it would in the real app.
#    Info.plist (App Transport Security), the CSP, the frontend and the
#    bundled binaries are otherwise the release's own.

MAC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RT_DIR=$(dirname "$MAC_DIR")
REPO=$(cd "$RT_DIR/../.." && pwd)

# mac_setup: the test's folder, home, ports and tools. Sets ROOT, THOME,
# TEST_ID, UI_PORT, PROXY_PORT, AX.
mac_setup() {
	TEST_ID="$(date +%H%M%S)$$"
	# Short: tmux's and the agent's sockets live under it.
	ROOT=$(mktemp -d "/tmp/brt.XXXXXX") || return 1
	ROOT=$(cd "$ROOT" && pwd -P)
	THOME="$ROOT/home"
	mkdir -p "$THOME/.local/bin" "$ROOT/shim" "$ROOT/tmux" "$ROOT/Applications" "$ROOT/launchd"
	cp "$MAC_DIR/launchctl" "$ROOT/shim/launchctl"
	chmod 755 "$ROOT/shim/launchctl"
	# Claude Code's installer puts claude in ~/.local/bin; this one is the
	# stand-in, so no test spends tokens.
	cp "$RT_DIR/fake-claude" "$THOME/.local/bin/claude"
	chmod 755 "$THOME/.local/bin/claude"
	# The sample project and the stand-in need Node, which a person
	# trying the sample has; this Mac's may be under a version manager
	# that a new login shell doesn't load, so link it in.
	local node
	node=$(command -v node) || {
		echo "the tests need Node.js (the sample project is a Node server); install it and run again" >&2
		return 1
	}
	ln -s "$node" "$THOME/.local/bin/node"
	# A Mac with Homebrew: its tmux is where berthd must find it under
	# launchd, which is what the login PATH below gives the box.
	{
		echo '# The release test'"'"'s home: Homebrew, as on a new Mac that has it, then'
		echo '# ~/.local/bin (Claude Code, Node) and the launchctl stand-in.'
		for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
			[ -x "$b" ] && echo "eval \"\$($b shellenv)\"" && break
		done
		echo "export PATH=\"$ROOT/shim:\$HOME/.local/bin:\$PATH\""
	} >"$THOME/.zprofile"
	UI_PORT=""
	local p
	for p in 9378 9478 9578 9678 9778 8378 8478 7378; do
		if ! (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then UI_PORT=$p && break; fi
	done
	[ -n "$UI_PORT" ] || {
		echo "no free port for the app's agent" >&2
		return 1
	}
	PROXY_PORT=$(free_port $((UI_PORT - 1 == 1377 ? 9377 : UI_PORT - 1)))
	[ "$PROXY_PORT" != "$UI_PORT" ] || PROXY_PORT=$(free_port $((UI_PORT + 1)))
	AX="$ROOT/axdrive"
	swiftc -O "$MAC_DIR/axdrive.swift" -o "$AX" 2>"$ROOT/axdrive.build.log" || {
		cat "$ROOT/axdrive.build.log" >&2
		echo "could not build the accessibility driver (needs Xcode's command line tools: xcode-select --install)" >&2
		return 1
	}
	"$AX" check >/dev/null || {
		"$AX" check >&2
		echo "this terminal needs Accessibility and Screen Recording (System Settings → Privacy & Security) to drive and see the app" >&2
		return 1
	}
}

# test_env: the environment the app runs with, as Finder starts it (a bare
# PATH) but for the test's home, ports, tmux and the launchctl stand-in.
test_env() {
	echo "HOME=$THOME"
	echo "USER=${USER:-$(id -un)}"
	echo "LOGNAME=${USER:-$(id -un)}"
	echo "SHELL=/bin/zsh"
	echo "TMPDIR=${TMPDIR:-/tmp}"
	echo "LANG=${LANG:-en_US.UTF-8}"
	echo "PATH=$ROOT/shim:/usr/bin:/bin:/usr/sbin:/sbin"
	echo "TMUX_TMPDIR=$ROOT/tmux"
	echo "BERTH_UI_ADDR=127.0.0.1:$UI_PORT"
	echo "BERTH_PROXY_ADDR=127.0.0.1:$PROXY_PORT,[::1]:$PROXY_PORT"
	echo "BERTH_RELEASE_TEST_ID=$TEST_ID"
	echo "BERTH_RELEASE_TEST_ROOT=$ROOT"
	[ -z "${BERTH_RELEASE_TEST_LANG:-}" ] || echo "BERTH_RELEASE_TEST_LANG=$BERTH_RELEASE_TEST_LANG"
}

# in_test_env COMMAND…: run COMMAND with the test's environment only.
in_test_env() {
	local vars=()
	while IFS= read -r l; do vars+=("$l"); done < <(test_env)
	env -i "${vars[@]}" "$@"
}

# dmg_info DMG: what a dmg holds, as KEY=VALUE lines: version (the app's),
# revision (the commit its berth-cli was built from, which Go records in
# the binary), modified (whether that checkout had changes), and berthd
# (yes when it carries Contents/Resources/berthd, as a release does).
dmg_info() {
	local mnt app
	mnt=$(mktemp -d /tmp/brtinfo.XXXXXX)
	hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mnt" "$1" >/dev/null 2>&1 || {
		rmdir "$mnt"
		return 1
	}
	app="$mnt/Terminal.app"
	# A release from before Berth became Terminal carries Berth.app.
	[ -d "$app" ] || app="$mnt/Berth.app"
	echo "version=$(plutil -extract CFBundleShortVersionString raw -o - "$app/Contents/Info.plist" 2>/dev/null)"
	echo "revision=$(LC_ALL=C grep -a -o -m1 'vcs\.revision=[0-9a-f]\{40\}' "$app/Contents/MacOS/berth-cli" 2>/dev/null | head -1 | cut -d= -f2)"
	echo "modified=$(LC_ALL=C grep -a -o -m1 'vcs\.modified=[a-z]*' "$app/Contents/MacOS/berth-cli" 2>/dev/null | head -1 | cut -d= -f2)"
	if [ -x "$app/Contents/Resources/berthd" ]; then echo "berthd=yes"; else echo "berthd=no"; fi
	hdiutil detach "$mnt" >/dev/null 2>&1 || hdiutil detach -force "$mnt" >/dev/null 2>&1
	rmdir "$mnt" 2>/dev/null
	return 0
}
info_of() { echo "$1" | sed -n "s/^$2=//p"; }

# find_dmg: the newest dmg make app-build (or scripts/mac-release.sh) made
# from this checkout's HEAD. A dmg built from another commit (an old build
# left in target/) is never picked: the test would test something else.
find_dmg() {
	local head d info
	head=${BERTH_RELEASE_TEST_REV:-$(git -C "$REPO" rev-parse HEAD)} || return 1
	local found
	# Newest first; the paths have no spaces (target/ and dist/ are ours).
	# shellcheck disable=SC2012
	found=$(ls -t "$REPO"/dist/mac/Berth-macos-universal.dmg \
		"$REPO"/app/src-tauri/target/*/release/bundle/dmg/*.dmg \
		"$REPO"/app/src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null)
	for d in $found; do
		info=$(dmg_info "$d") || continue
		if [ "$(info_of "$info" revision)" = "$head" ]; then
			echo "$d"
			return 0
		fi
		echo "  not $d: Terminal $(info_of "$info" version), built from $(info_of "$info" revision | cut -c1-9), not HEAD ${head:0:9}" >&2
	done
	echo "no dmg built from HEAD (${head:0:9}): build one with make app-build (scripts/release-check.sh does), or pass --dmg PATH" >&2
	return 1
}

# check_dmg DMG [ANY]: a dmg shaped as a release (the app, its berth-cli
# and berthd) and built from HEAD, unless ANY. Says what it holds.
check_dmg() {
	local info head rev
	info=$(dmg_info "$1") || {
		echo "can't open $1" >&2
		return 1
	}
	DMG_VERSION=$(info_of "$info" version)
	rev=$(info_of "$info" revision)
	# shellcheck disable=SC2034 # the tests report it
	DMG_REVISION=$rev
	# The commit under test: release-check's, else HEAD.
	head=${BERTH_RELEASE_TEST_REV:-$(git -C "$REPO" rev-parse HEAD 2>/dev/null)}
	if [ "$(info_of "$info" berthd)" != yes ]; then
		echo "$1 (Terminal $DMG_VERSION, built from ${rev:0:9}) has no Contents/Resources/berthd: it isn't a release build. Build one with make app-build or scripts/mac-release.sh" >&2
		return 1
	fi
	if [ -z "${2:-}" ] && [ -n "$head" ] && [ "$rev" != "$head" ]; then
		echo "$1 is Terminal $DMG_VERSION built from ${rev:0:9}, not ${head:0:9}, the commit under test: build it with make app-build, or pass --any-build to test it anyway" >&2
		return 1
	fi
	return 0
}
# download_dmg TAG DIR: the release's dmg.
download_dmg() {
	gh release download "$1" --repo cosscom/shipyard --pattern Berth-macos-universal.dmg --dir "$2" --clobber >&2 || return 1
	echo "$2/Berth-macos-universal.dmg"
}

# install_dmg DMG DEST: what a person does: open the dmg, drag Terminal to
# Applications (DEST here). Checks the dmg is laid out for that, and sets
# INSTALLED_APP: DEST/Terminal.app, or DEST/Berth.app from a release made
# before the rename.
install_dmg() {
	local dmg=$1 dest=$2 mnt
	mnt=$(mktemp -d /tmp/brtmnt.XXXXXX)
	hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mnt" "$dmg" >/dev/null || {
		rmdir "$mnt"
		echo "could not open $dmg" >&2
		return 1
	}
	local ok=0 name=""
	if [ -d "$mnt/Terminal.app" ]; then name=Terminal.app; elif [ -d "$mnt/Berth.app" ]; then name=Berth.app; fi
	if [ -z "$name" ]; then
		echo "the dmg has no Terminal.app" >&2
	elif [ ! -L "$mnt/Applications" ]; then
		echo "the dmg has no Applications link to drag Terminal to" >&2
	else
		rm -rf "${dest:?}/$name"
		# shellcheck disable=SC2034 # the tests use it
		ditto "$mnt/$name" "$dest/$name" && INSTALLED_APP="$dest/$name" && ok=1
	fi
	hdiutil detach "$mnt" >/dev/null 2>&1 || hdiutil detach -force "$mnt" >/dev/null 2>&1
	rmdir "$mnt" 2>/dev/null
	[ $ok = 1 ]
}

# test_copy APP DEST: the copy the test runs (see the top of this file).
test_copy() {
	local app=$1 dest=$2
	rm -rf "$dest"
	ditto "$app" "$dest" || return 1
	local exe="$dest/Contents/MacOS/berth"
	local n
	n=$(LC_ALL=C grep -c -a '127\.0\.0\.1:1378' "$exe")
	[ "$n" -gt 0 ] || {
		echo "the app's binary does not name 127.0.0.1:1378; the test can't move it to its own port" >&2
		return 1
	}
	LC_ALL=C perl -pi -e "s/127\\.0\\.0\\.1:1378/127.0.0.1:$UI_PORT/g" "$exe" || return 1
	local plist="$dest/Contents/Info.plist"
	plutil -replace CFBundleIdentifier -string "dev.berth.releasetest" "$plist" &&
		plutil -replace CFBundleName -string "Terminal Test" "$plist" &&
		plutil -replace CFBundleDisplayName -string "Terminal Test" "$plist" || return 1
	# berth:// links stay the installed Terminal's.
	plutil -remove CFBundleURLTypes "$plist" 2>/dev/null || true
	codesign --force --sign - --options runtime --preserve-metadata=entitlements "$dest" 2>&1 || return 1
	codesign --verify "$dest" || return 1
}

# app_version APP: CFBundleShortVersionString.
app_version() { plutil -extract CFBundleShortVersionString raw -o - "$1/Contents/Info.plist"; }

# launch_app APP: start it, as Finder would but with the test's
# environment, and set APP_PID.
launch_app() {
	local app=$1 vars=()
	while IFS= read -r l; do vars+=("$l"); done < <(test_env)
	# env execs the app, so $! is the app.
	env -i "${vars[@]}" "$app/Contents/MacOS/berth" >>"$ROOT/app.log" 2>&1 &
	APP_PID=$!
	echo "$APP_PID" >>"$ROOT/pids"
	local i=0
	while [ $i -lt 60 ]; do
		kill -0 "$APP_PID" 2>/dev/null || {
			echo "the app exited at start; app.log:" >&2
			tail -20 "$ROOT/app.log" >&2
			return 1
		}
		"$AX" window "$APP_PID" >/dev/null 2>&1 && return 0
		sleep 0.5
		i=$((i + 1))
	done
	echo "the app showed no window in 30s" >&2
	return 1
}

quit_app() {
	[ -n "${APP_PID:-}" ] || return 0
	kill "$APP_PID" 2>/dev/null
	local i=0
	while kill -0 "$APP_PID" 2>/dev/null && [ $i -lt 20 ]; do
		sleep 0.25
		i=$((i + 1))
	done
	kill -9 "$APP_PID" 2>/dev/null
	APP_PID=""
}

# rt_screenshot NAME: the app's window, into the report's folder. common.sh
# takes one after every step.
rt_screenshot() {
	[ -n "${APP_PID:-}" ] && kill -0 "$APP_PID" 2>/dev/null || return 1
	local wid
	wid=$("$AX" window "$APP_PID" 2>/dev/null) || return 1
	screencapture -x -o -l "$wid" "$RT_OUT/$1.png" 2>/dev/null || return 1
	echo "$RT_OUT/$1.png"
}

# The agent's API, as the app uses it.
ui_token() { cat "$THOME/Library/Application Support/berth/client/ui-token" 2>/dev/null; }
api() { # api METHOD PATH [JSON]
	local tok
	tok=$(ui_token) || return 1
	curl -sS --max-time "${API_TIMEOUT:-30}" -X "$1" -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' \
		${3:+--data "$3"} "http://127.0.0.1:$UI_PORT$2"
}
berth_cli() { in_test_env "$APP_UNDER_TEST/Contents/MacOS/berth-cli" "$@"; }

# ax ARGS…: the accessibility driver on the app.
ax() {
	local cmd=$1
	shift
	"$AX" "$cmd" "$APP_PID" "$@"
}

# front: the app's window in front, where WebKit keeps its page running,
# with no notification over it (a toast hides the Browser tab's webview).
front() {
	ax raise >/dev/null 2>&1
	local i=0
	while [ $i -lt 5 ] && ax press "Dismiss" --role AXButton --exact --timeout 0 >/dev/null 2>&1; do
		i=$((i + 1))
		sleep 0.3
	done
	return 0
}

# mac_cleanup: stop everything the test started and remove its folder.
# Only what carries the test's own labels, ports and folder is touched.
mac_cleanup() {
	[ -n "${ROOT:-}" ] && [ -d "$ROOT" ] || return 0
	# Every step of it runs, whatever fails.
	set +e
	quit_app
	local uid l
	uid=$(id -u)
	# The test's launchd jobs: the labels the stand-in made, and any it
	# might have made under this test's id.
	for l in $(cat "$ROOT/launchd/labels" 2>/dev/null) dev.berth.test-"$TEST_ID".berthd dev.berth.test-"$TEST_ID".agent; do
		case $l in dev.berth.test-*) /bin/launchctl bootout "gui/$uid/$l" 2>/dev/null || true ;; esac
	done
	# The agent, berthd and the box's tmux server.
	[ -S "$ROOT/tmux/tmux-$uid/berth" ] && TMUX_TMPDIR="$ROOT/tmux" tmux -L berth kill-server 2>/dev/null
	local pids
	pids=$(pgrep -f "$ROOT" 2>/dev/null)
	[ -z "$pids" ] || kill $pids 2>/dev/null
	sleep 1
	pids=$(pgrep -f "$ROOT" 2>/dev/null)
	[ -z "$pids" ] || kill -9 $pids 2>/dev/null
	# Anything still listening in a worktree of the test (a dev server).
	for pid in $(lsof -t -iTCP -sTCP:LISTEN 2>/dev/null); do
		case $(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p') in "$ROOT"/*) kill "$pid" 2>/dev/null ;; esac
	done
	# The test copy's webview data, under its own bundle identifier.
	rm -rf "$HOME/Library/WebKit/dev.berth.releasetest" "$HOME/Library/Caches/dev.berth.releasetest" \
		"$HOME/Library/HTTPStorages/dev.berth.releasetest" "$HOME/Library/Saved Application State/dev.berth.releasetest.savedState" 2>/dev/null
	if [ "${KEEP:-0}" = 1 ]; then
		say "Kept $ROOT (--keep)."
		return 0
	fi
	rm -rf "$ROOT"
}
