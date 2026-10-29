#!/usr/bin/env bash
# The fresh-user release test, on this Mac: the whole first run of the
# release app, as a new user has it, with nothing of this Mac's own Terminal
# touched. Not part of releasing: run it by hand now and then, alone or
# with the other release tests (make release-check).
#
#   scripts/fresh-user-test.sh                 the dmg make app-build last made
#   scripts/fresh-user-test.sh --dmg PATH      that dmg
#   scripts/fresh-user-test.sh --tag v0.3.6    that release's dmg, downloaded
#   options: --out DIR (report and screenshots; default dist/release-test/
#            fresh-user-<time>), --keep (leave the test's folder), --signed
#            (fail unless the app is signed, notarized and stapled),
#            --any-build (test a dmg built from another commit than HEAD)
#
# The dmg must be a release build (it carries berthd) made from HEAD, as
# its berth-cli records: the test refuses anything else, naming what it is.
#
# It installs the app from the dmg, starts it, goes through onboarding with
# "this Mac" (a real launchd box), sends the sample's first task to a
# stand-in for Claude Code (scripts/release-test/fake-claude: no tokens),
# and checks: the worktree, the dev server on $BERTH_PORT, the worktree URL
# with curl and in the app's Browser tab (a native webview, under App
# Transport Security), the chat's turns, the terminal renderer (ghostty, not
# the xterm.js fallback), the built-in plugins, the Diff panel, and that
# archiving the worktree removes it. Each step gets a screenshot; the report
# is report.md in the output folder. Exit status 0 only if every step passed.
#
# How it drives the app: the accessibility API (scripts/release-test/macos/
# axdrive.swift), which reads and presses what the webviews show without
# moving the mouse, typing on the keyboard or needing the app in front, and
# needs nothing built into the app for testing. It brings the app's window
# to the front for each step (WebKit pauses a covered page), so leave the
# Mac alone for the minute it takes. tauri-driver has no macOS
# WebDriver (WKWebView has none), and a test hook in the app would mean
# testing something other than what ships. The terminal running this needs
# Accessibility and Screen Recording permission (System Settings → Privacy
# & Security); the test says so if it hasn't.
#
# Isolation (scripts/release-test/macos/lib.sh): its own HOME, ports from
# 9377 up (never 1377-1379), launchd labels dev.berth.test-<id>.* in place
# of dev.berth.berthd and dev.berth.agent, its own tmux socket folder, and a
# copy of the app with its own bundle identifier and the agent's port moved
# (re-signed ad hoc for that). Everything is removed at the end.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=release-test/common.sh
source "$here/release-test/common.sh"
# shellcheck source=release-test/macos/lib.sh
source "$here/release-test/macos/lib.sh"

DMG="" TAG="" OUT="" KEEP=0 SIGNED=0 ANY=""
while [ $# -gt 0 ]; do
	case $1 in
	--dmg) DMG=$2 && shift 2 ;;
	--tag) TAG=$2 && shift 2 ;;
	--out) OUT=$2 && shift 2 ;;
	--keep) KEEP=1 && shift ;;
	--signed) SIGNED=1 && shift ;;
	--any-build) ANY=1 && shift ;;
	-h | --help) sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//' && exit 0 ;;
	*) echo "unknown option $1 (try --help)" >&2 && exit 2 ;;
	esac
done
# The cleanup (in the sourced lib) reads it.
export KEEP
[ "$(uname -s)" = Darwin ] || {
	echo "fresh-user-test.sh runs on macOS; scripts/linux-box-test.sh is the Linux half" >&2
	exit 2
}
OUT=${OUT:-$REPO/dist/release-test/fresh-user-$(date +%Y%m%d-%H%M%S)}
rt_init "Terminal fresh-user test (macOS)" "$OUT"
trap 'mac_cleanup >>"$RT_LOG" 2>&1' EXIT
trap 'exit 130' INT TERM

BOX="" LOC="" WT="" WT_PATH="" SESSION="" PORT=""

# --- steps ---------------------------------------------------------------

s_prepare() {
	mac_setup || return 1
	if [ -n "$TAG" ]; then
		DMG=$(download_dmg "$TAG" "$ROOT") || fail "could not download $TAG's dmg" || return 1
	fi
	[ -n "$DMG" ] || DMG=$(find_dmg 2>"$ROOT/dmg.find") || fail "$(tr '\n' ' ' <"$ROOT/dmg.find")" || return 1
	[ -f "$DMG" ] || fail "$DMG does not exist" || return 1
	# The dmg must be a release build of what is being tested: a stale one
	# left in target/ once made this test check months-old code.
	check_dmg "$DMG" "${ANY:-$TAG}" 2>"$ROOT/dmg.check" || fail "$(cat "$ROOT/dmg.check")" || return 1
	detail "$(basename "$DMG"): Terminal $DMG_VERSION built from ${DMG_REVISION:0:9}; agent on 127.0.0.1:$UI_PORT, proxy :$PROXY_PORT; home $THOME"
}

s_install() {
	install_dmg "$DMG" "$ROOT/Applications" || fail "could not install from the dmg" || return 1
	local app="$INSTALLED_APP" sig="unsigned" v
	v=$(app_version "$app")
	if codesign --verify --deep --strict "$app" 2>/dev/null; then
		sig=$(codesign -dv "$app" 2>&1 | sed -n 's/^TeamIdentifier=//p')
		sig="signed (team ${sig:-none})"
		if xcrun stapler validate "$app" >/dev/null 2>&1; then sig="$sig, notarized and stapled"; fi
	fi
	if [ "$SIGNED" = 1 ]; then
		spctl -a -vv -t exec "$app" 2>&1 | grep -q 'source=Notarized Developer ID' ||
			fail "Terminal $v is not accepted by Gatekeeper as notarized: $(spctl -a -vv -t exec "$app" 2>&1 | tr '\n' ' ')" || return 1
	fi
	for f in Contents/MacOS/berth Contents/MacOS/berth-cli Contents/Resources/berthd; do
		[ -x "$app/$f" ] || fail "the app has no $f" || return 1
	done
	APP_UNDER_TEST="$ROOT/app/Terminal Test.app"
	mkdir -p "$ROOT/app"
	test_copy "$app" "$APP_UNDER_TEST" || fail "could not make the test's copy of the app" || return 1
	detail "Terminal $v, $sig"
}

s_app_start() {
	launch_app "$APP_UNDER_TEST" || fail "the app did not start" || return 1
	front
	# A new Mac has no agent running: the app offers to start it.
	local i=0 seen=""
	while [ $i -lt 60 ]; do
		if ax wait "Welcome to Terminal" --timeout 1 >/dev/null 2>&1; then seen=welcome && break; fi
		if ax wait "Start the Terminal agent" --timeout 1 >/dev/null 2>&1; then seen=offline && break; fi
		i=$((i + 1))
	done
	[ -n "$seen" ] || fail "the app showed neither the welcome nor the agent's start screen" || return 1
	if [ "$seen" = offline ]; then
		ax press "Start the Terminal agent" --role AXButton || return 1
		ax wait "Welcome to Terminal" --timeout 30 || fail "the agent started, but the welcome never showed" || return 1
	fi
	api GET /v1/status >/dev/null || fail "the agent does not answer on 127.0.0.1:$UI_PORT" || return 1
	detail "agent started from the app (${seen} screen first); the welcome shows"
}

s_onboarding() {
	front
	ax press "Start on this Mac" --role AXButton || return 1
	ax wait "Try the sample project" --timeout 180 || {
		ax text | grep -i -E 'fail|error|couldn|stopped' | head -5
		fail "setting up this Mac never reached the project step"
		return 1
	}
	BOX=$(api GET /v1/status | jq_py 'j["boxes"][0]["name"]') || fail "no box after setting up this Mac" || return 1
	local label="dev.berth.test-$TEST_ID.berthd"
	/bin/launchctl print "gui/$(id -u)/$label" 2>/dev/null | grep -q 'state = running' ||
		fail "the box's launchd job ($label) is not running" || return 1
	detail "this Mac is box $BOX, berthd under launchd as $label"
}

s_sample() {
	front
	ax press "Use the sample" --role AXButton || return 1
	ax wait "Start your first agent" --timeout 60 || fail "the sample project never reached the first agent step" || return 1
	ax wait "/health endpoint" --role AXTextArea --timeout 10 || fail "the composer has no sample task" || return 1
	ax wait "Agents: Claude Code" --timeout 20 || fail "the composer does not offer Claude Code (the stand-in is in ~/.local/bin)" || return 1
	LOC=$(api GET "/v1/boxes/$BOX/api/locations" | jq_py '[l["name"] for l in j][0]') || return 1
	detail "project $LOC in ~/work, the sample task in the composer, Claude Code picked"
}

agent_report() { cat "$ROOT"/fake-claude/*.json 2>/dev/null | head -c 100000; }
agent_started() { ls "$ROOT"/fake-claude/*.json >/dev/null 2>&1; }
session_finished() { api GET "/v1/boxes/$BOX/api/sessions" | grep -q -E '"agent_state": *"finished"'; }
s_prompt() {
	front
	ax press "Start" --role AXButton --exact || return 1
	# What the app says while it waits: an error comes as a toast that goes.
	local said="" i=0 now
	while ! agent_started; do
		now=$(ax text 2>/dev/null | grep -i -E "gone|couldn|can't|error|fail|missing|not installed" | grep -v -i 'Error.*0' | sort -u | head -3 | tr '\n' ' ')
		[ -z "$now" ] || said=$now
		i=$((i + 1))
		if [ $i -gt 30 ]; then
			# The box's own answer, for the report: a plain session there.
			local probe
			probe=$(api POST "/v1/boxes/$BOX/api/sessions" "{\"location\":\"$LOC\",\"command\":\"sleep 2\"}" | head -c 300)
			fail "the agent never started; the app said: ${said:-nothing}; a plain session on the box answers: $probe"
			return 1
		fi
		sleep 2
	done
	until_ok 60 sh -c "cat '$ROOT'/fake-claude/*.json | grep -q '\"event\": \"Stop\"'" || fail "the agent's turn never ended (no Stop hook ran)" || return 1
	local sessions
	sessions=$(api GET "/v1/boxes/$BOX/api/sessions") || return 1
	SESSION=$(echo "$sessions" | jq_py '[s["name"] for s in j if s.get("agent") == "claude"][0]') || fail "no claude session on the box: $sessions" || return 1
	until_ok 30 session_finished ||
		fail "the box never saw the turn finish (hooks): $(api GET "/v1/boxes/$BOX/api/sessions")" || return 1
	detail "session $SESSION ran the stand-in; its hooks reported the turn finished"
}

s_worktree() {
	local locs
	locs=$(api GET "/v1/boxes/$BOX/api/locations") || return 1
	WT=$(echo "$locs" | jq_py '[w["name"] for l in j for w in l["worktrees"] if not w.get("main")][0]') || fail "no worktree besides the main checkout: $locs" || return 1
	WT_PATH=$(echo "$locs" | jq_py "[w['path'] for l in j for w in l['worktrees'] if w['name'] == '$WT'][0]")
	PORT=$(echo "$locs" | jq_py "[w.get('port') for l in j for w in l['worktrees'] if w['name'] == '$WT'][0]")
	[ -d "$WT_PATH" ] || fail "$WT_PATH is not there" || return 1
	git -C "$WT_PATH" log --oneline -1 | grep -q health || fail "the agent's commit is not in the worktree" || return 1
	detail "$WT at $WT_PATH, port $PORT"
}

s_dev_server() {
	local rep port berth_port
	rep=$(agent_report)
	port=$(echo "$rep" | jq_py 'j["env"].get("PORT")') || fail "the agent's session had no PORT (servers fall back to 3000)" || return 1
	berth_port=$(echo "$rep" | jq_py 'j["env"].get("BERTH_PORT")') || fail "the agent's session had no BERTH_PORT" || return 1
	[ "$port" = "$berth_port" ] || fail "PORT=$port but BERTH_PORT=$berth_port" || return 1
	[ "$port" = "$PORT" ] || fail "the session's port $port is not the worktree's $PORT" || return 1
	until_ok 20 curl -fsS "http://127.0.0.1:$port/health" || fail "nothing answers on 127.0.0.1:$port/health" || return 1
	detail "node server.js listens on \$BERTH_PORT=$port: $(curl -fsS "http://127.0.0.1:$port/health")"
}

wt_url() { echo "http://$WT.$LOC.$BOX.localhost:$PROXY_PORT$1"; }
s_url_curl() {
	local body
	body=$(curl -fsS --max-time 10 "$(wt_url /health)") || fail "$(wt_url /health) did not answer" || return 1
	[ "$body" = '{"ok":true}' ] || fail "$(wt_url /health) said $body" || return 1
	detail "$(wt_url /health) → $body"
}

s_url_browser() {
	front
	ax press "New tab" --role AXPopUpButton || return 1
	ax press "New browser tab" || return 1
	ax press "$PORT ·" --role AXButton --timeout 20 || fail "the Browser tab does not offer the worktree's server on $PORT" || return 1
	ax wait "Hello, world" --timeout 20 || fail "the native webview never showed the worktree's page (App Transport Security?)" || return 1
	ax set "Address" "$(wt_url /health)" || return 1
	ax key return
	local i=0
	while [ $i -lt 20 ]; do
		if ax webareas | grep -F "$(wt_url /health)" | grep -q '"ok":true'; then
			detail "the Browser tab's webview loaded $(wt_url /) and /health"
			return 0
		fi
		sleep 1
		i=$((i + 1))
	done
	ax webareas
	fail "the Browser tab never showed /health's answer"
}

# The agent's tab: its own sidebar row opens it.
open_worktree() { ax press "$WT" --role AXButton >/dev/null; }

s_chat() {
	front
	ax press "Conversation" --role AXCheckBox || return 1
	local note=""
	if ! ax wait "Add a /health endpoint to server.js that returns" --role AXStaticText --timeout 20; then
		# Seen now and then: "Reading the conversation…" with nothing read.
		# Showing the conversation again starts its reading afresh; the
		# report says it was needed.
		ax press "Terminal" --role AXCheckBox >/dev/null
		sleep 1
		ax press "Conversation" --role AXCheckBox >/dev/null
		note=" (only after showing it a second time: it stayed at Reading the conversation… for 20s)"
	fi
	if ! ax wait "Add a /health endpoint to server.js that returns" --role AXStaticText --timeout 20; then
		# What the box answers for it, and how fast, for the report.
		local t0 t1 res
		t0=$(date +%s)
		res=$(API_TIMEOUT=20 api GET "/v1/boxes/$BOX/api/sessions/$SESSION/transcript?since=0" | head -c 300)
		t1=$(date +%s)
		echo "transcript API ($((t1 - t0))s): $res"
		ax text | grep -i -E 'reading|conversation|error|couldn' | sort -u | head -5
		fail "the chat does not show the prompt (the box's transcript API answered in $((t1 - t0))s: $(echo "$res" | cut -c1-120))"
		return 1
	fi
	ax wait "Added a /health endpoint" --timeout 20 || fail "the chat does not show the agent's reply" || return 1
	ax wait "Edited server.js" --timeout 10 || fail "the chat does not show the agent's edit" || return 1
	detail "the prompt, the edits and the reply$note"
}

s_terminal() {
	front
	ax press "Terminal" --role AXCheckBox || return 1
	ax wait "Terminal input" --timeout 10 || fail "no terminal" || return 1
	local f="$THOME/.berth/app/terminal-renderer.json" r
	if ! until_ok 30 test -f "$f"; then
		# Which it is: a fallback (the app says so) or a record that never
		# reached the agent.
		if ax wait "Terminals are using xterm.js" --timeout 2 >/dev/null 2>&1; then
			fail "terminals fell back to xterm.js (the app's notice says so), and the record of it ($f) never reached the agent"
		else
			fail "the app's record of its terminal renderer ($f, PUT /v1/app/terminal-renderer) never reached the agent; no xterm.js fallback notice shows"
		fi
		return 1
	fi
	r=$(jq_py 'j.get("renderer")' <"$f")
	[ "$r" = ghostty ] || fail "terminals use $r, not ghostty: $(cat "$f")" || return 1
	if ax wait "Terminals are using xterm.js" --timeout 1 >/dev/null 2>&1; then fail "the app shows the xterm.js fallback notice" && return 1; fi
	local attached
	attached=$(api GET "/v1/boxes/$BOX/api/sessions" | jq_py "[s.get('attached', 0) for s in j if s['name'] == '$SESSION'][0]")
	# Two tabs on one session attach it at two sizes, and the larger fills
	# with tmux's dots.
	[ "$attached" = 1 ] || fail "the agent's session is attached $attached times: it opened in more than one tab" || return 1
	detail "ghostty-web, in one tab"
}

s_plugins() {
	front
	ax press "Settings" --role AXButton --exact || return 1
	ax press "Plugins" --role AXButton --exact || return 1
	ax wait "Built in" --timeout 15 || fail "Settings → Plugins has no built-in section" || return 1
	sleep 2
	local on panels names
	on=$(ax count "Turn off " --role AXCheckBox)
	panels=$(ax text | grep -c -E '^(Panel|Sidebar): ' || true)
	names=$(ax text | grep -E '^Turn off ' | sed 's/^Turn off //' | sort -u | paste -sd, -)
	[ "$on" -ge 5 ] || fail "only $on built-in plugins are on: $names" || return 1
	# A plugin that loaded has registered its panel or sidebar; one the CSP
	# (or anything else) stopped has none, and an error under its name.
	[ "$panels" -ge "$on" ] || fail "$on built-ins are on but only $panels panels or sidebars registered: some failed to load ($names)" || return 1
	detail "$on on and loaded: $names"
}

s_diff() {
	front
	open_worktree
	ax press "New tab" --role AXPopUpButton || return 1
	ax press "Diff" --exact --role AXStaticText || return 1
	ax wait "server.js" --role AXButton --timeout 20 || fail "the Diff panel does not show server.js" || return 1
	ax wait "health.test.js" --role AXButton --timeout 5 || fail "the Diff panel does not show health.test.js" || return 1
	detail "$WT vs main: server.js and health.test.js"
}

s_archive() {
	front
	ax press "$WT actions" --role AXPopUpButton || return 1
	ax press "Archive…" --role AXMenuItem || return 1
	ax press "Archive" --role AXButton --exact || return 1
	local i=0 left
	while [ $i -lt 40 ]; do
		left=$(api GET "/v1/boxes/$BOX/api/locations" | jq_py "[w['name'] for l in j for w in l['worktrees'] if w['name'] == '$WT']")
		if [ "$left" = "[]" ] && [ ! -d "$WT_PATH" ]; then
			local server="stopped"
			curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && server="still running"
			detail "$WT is gone from the box and from disk; its dev server is $server"
			return 0
		fi
		sleep 1
		i=$((i + 1))
	done
	ax text | grep -i -E 'archive|uncommitted|couldn|error' | sort -u | head -5
	fail "$WT is still there: listed=$left, folder $([ -d "$WT_PATH" ] && echo present || echo gone); the app says: $(ax text | grep -i -E 'uncommitted|couldn|error' | sort -u | head -2 | tr '\n' ' ')"
}

s_isolation() {
	local ours bad="" p
	ours=$(pgrep -f "$ROOT" | paste -sd, -)
	if [ -n "$ours" ]; then
		for p in 1377 1378 1379; do
			lsof -nP -a -p "$ours" -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1 && bad="$bad $p"
		done
	fi
	[ -z "$bad" ] || fail "the test's processes listen on this Mac's Terminal ports:$bad" || return 1
	if grep -q REFUSED "$ROOT/launchctl.log" 2>/dev/null; then
		fail "something tried launchd outside the test's labels: $(grep REFUSED "$ROOT/launchctl.log" | head -3 | tr '\n' ' ')"
		return 1
	fi
	detail "no listener on 1377-1379; launchd calls: $(wc -l <"$ROOT/launchctl.log" | tr -d ' '), all on dev.berth.test-$TEST_ID.*"
}

# --- run -----------------------------------------------------------------

RT_CRITICAL=1 step "Prepare an isolated home, ports and tools" s_prepare
RT_CRITICAL=1 step "Install from the dmg" s_install
RT_CRITICAL=1 step "Start the app (and its agent)" s_app_start
RT_CRITICAL=1 step "Onboarding: this Mac as the box" s_onboarding
RT_CRITICAL=1 step "Onboarding: the sample project" s_sample
RT_CRITICAL=1 step "The demo prompt (stand-in agent)" s_prompt
RT_CRITICAL=1 step "Worktree created" s_worktree
step "Dev server on \$BERTH_PORT" s_dev_server
step "Worktree URL with curl" s_url_curl
step "The chat shows the turn" s_chat
step "The terminal is ghostty" s_terminal
step "Worktree URL in the Browser tab" s_url_browser
step "The Diff panel opens" s_diff
step "Built-in plugins listed and loaded" s_plugins
step "Archive the worktree" s_archive
step "Nothing of this Mac's Terminal touched" s_isolation
rt_finish
