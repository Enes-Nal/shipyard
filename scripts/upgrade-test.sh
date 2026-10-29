#!/usr/bin/env bash
# The upgrade release test: set Terminal up with the previous release, use it,
# upgrade to this build, and check that everything survived. Run by hand
# now and then (make release-check); its Linux half weekly in CI.
#
#   scripts/upgrade-test.sh --linux [--from v0.3.0] [--dist DIR]
#   scripts/upgrade-test.sh --mac   [--from v0.3.0] [--dmg PATH]
#   scripts/upgrade-test.sh         both (--mac only on macOS)
#   options: --from TAG (default: the newest release tag before this
#            version), --out DIR, --keep, --any-build (a dmg built from
#            another commit than HEAD; it must still not be older than --from)
#
# Linux (Docker; scripts/release-test/linux): a fresh box and laptop on
# --from, a task with the stand-in agent left running, a kit applied, the
# laptop's app settings and hooks; then install.sh again with this build,
# and this build's berth on the laptop. The session must still run (the
# same agent process, and it answers a second prompt), the kit, settings
# and hooks must be there, and the worktree's URL must still work.
#
# macOS (scripts/release-test/macos, isolated as the fresh-user test is):
# the --from app onboarded with this Mac as its box, a task left running,
# preferences changed (closing an agent's tab keeps it running), plugins
# turned on and off (whichever built-ins that release has), a layout of
# several tabs in two tab groups (Labs, on by default),
# and a kit applied; then the app replaced in place, as the updater does,
# and started again. The layout, preferences and plugins must be restored,
# the session still running; the new app must say it was updated and
# restart the old agent by itself, and the new agent bring this Mac's box
# to the new berthd, with the session still there and the kit intact.
#
# A box on a release before the tmux fix (20472df) can't start sessions
# under launchd with Homebrew's tmux 3.7; for the --from half on a Mac the
# test gives that old box a UTF-8 LANG (BERTH_RELEASE_TEST_LANG), so it has
# a session to keep. The upgraded box runs without it.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=release-test/common.sh
source "$here/release-test/common.sh"
REPO=$(cd "$here/.." && pwd)

MODE="" FROM="" DIST="" DMG="" OUT="" KEEP=0 ANY=""
while [ $# -gt 0 ]; do
	case $1 in
	--linux) MODE="${MODE:+$MODE,}linux" && shift ;;
	--mac) MODE="${MODE:+$MODE,}mac" && shift ;;
	--from) FROM=$2 && shift 2 ;;
	--dist) DIST=$(cd "$2" && pwd) && shift 2 ;;
	--dmg) DMG=$2 && shift 2 ;;
	--out) OUT=$2 && shift 2 ;;
	--keep) KEEP=1 && shift ;;
	--any-build) ANY=1 && shift ;;
	-h | --help) sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//' && exit 0 ;;
	*) echo "unknown option $1 (try --help)" >&2 && exit 2 ;;
	esac
done
# The cleanup (in the sourced lib) reads it.
export KEEP
if [ -z "$MODE" ]; then
	MODE=linux
	[ "$(uname -s)" != Darwin ] || MODE=linux,mac
fi
if [ -z "$FROM" ]; then
	# The newest release that isn't this checkout's own version.
	cur="v$(python3 -c 'import json; print(json.load(open("'"$REPO"'/app/package.json"))["version"])')"
	FROM=$(git -C "$REPO" tag --list 'v*' --sort=-v:refname | grep -v -x "$cur" | head -1 || true)
	# A shallow checkout (CI) has no tags: ask GitHub.
	[ -n "$FROM" ] || FROM=$(gh release list --repo cosscom/shipyard --exclude-drafts --json tagName --jq '.[].tagName' 2>/dev/null | grep -v -x "$cur" | head -1 || true)
	[ -n "$FROM" ] || {
		echo "no earlier release to upgrade from; pass --from vX.Y.Z" >&2
		exit 2
	}
fi
stamp=$(date +%Y%m%d-%H%M%S)

KIT_JSON='{"id":"release-test","name":"Release test","description":"Sets HELLO_KIT in every worktree of the sample.","version":"1","config":{"env":{"HELLO_KIT":"on"}}}'
PROMPT='Add a /health endpoint to server.js that returns {"ok": true}, with a test'

# ---------------------------------------------------------------- Linux ---

run_linux() {
	# shellcheck source=release-test/linux/lib.sh
	source "$here/release-test/linux/lib.sh"
	rt_init "Terminal upgrade test (Linux box, $FROM → this build)" "${OUT:-$REPO/dist/release-test/upgrade-linux-$stamp}"
	WORK=$(mktemp -d "${TMPDIR:-/tmp}/berth-upgrade-test.XXXXXX")
	trap 'linux_cleanup >>"$RT_LOG" 2>&1; rm -rf "$WORK"' EXIT
	trap 'exit 130' INT TERM
	BOX="" SESSION="" PID0="" WT=health

	RT_CRITICAL=1 step "Archives: $FROM and this build" l_build
	RT_CRITICAL=1 step "Box and laptop on $FROM" l_old
	RT_CRITICAL=1 step "Use it: a running task, a kit, settings and hooks" l_use
	RT_CRITICAL=1 step "Upgrade the box with install.sh" l_upgrade_box
	RT_CRITICAL=1 step "Upgrade berth on the laptop" l_upgrade_laptop
	step "The session kept running" l_session
	step "It answers a second prompt" l_second_prompt
	step "The kit is intact" l_kit
	step "Settings and hooks kept" l_settings
	step "The worktree URL still works" l_url
	rt_finish
}

l_build() {
	docker info >/dev/null 2>&1 || fail "Docker is not running" || return 1
	download_dist "$FROM" "$WORK/srv/old" || fail "could not download $FROM's Linux archives" || return 1
	if [ -n "$DIST" ]; then use_dist "$DIST" "$WORK/srv/new" || return 1; else build_dist "$WORK/srv/new" dev || return 1; fi
	build_image || fail "could not build the Ubuntu image" || return 1
	detail "$FROM from GitHub; this build for linux/$(docker_arch)"
}

lberth() { lp "berth $*"; }
l_old() {
	start_machines "berth-up-$$" "$WORK/srv" || return 1
	# The install command, for the old release.
	local out
	out=$(bx "curl -fsSL http://127.0.0.1:8000/new/install.sh | BERTH_DOWNLOAD_BASE=http://127.0.0.1:8000/old sh -s -- --listen 0.0.0.0:7444 --yes" 2>&1) || {
		echo "$out"
		fail "installing $FROM failed"
		return 1
	}
	PAIR_LINK=$(echo "$out" | sed -n "s/.*\(berth:\/\/[^ '\"]*\).*/\1/p" | head -1)
	local arch
	arch=$(docker_arch)
	lp "mkdir -p ~/.local/bin && curl -fsSL http://$BOXC:8000/old/berth-linux-$arch.tar.gz | tar -xzf - -C ~/.local/bin berth" || return 1
	lberth "pair '$PAIR_LINK'" || fail "pairing with $FROM failed" || return 1
	BOX=$(lberth "boxes --json" | jq_py '[b["name"] for b in j][0]') || return 1
	detail "$(bx 'berthd version'), $(lberth version)"
}

report_json() { bx 'cat /tmp/fake-claude/*.json' 2>/dev/null; }
turn_ended() { report_json | grep -q '"event": "Stop"'; }
l_use() {
	laptop_api POST "/v1/boxes/$BOX/api/locations/new" '{"sample":"hello"}' | jq_py 'j["name"]' >/dev/null || fail "no sample project" || return 1
	lberth "task new $BOX/hello/$WT --agent claude --prompt '$PROMPT'" || fail "the task did not start on $FROM" || return 1
	until_ok 60 turn_ended || fail "the stand-in's turn never ended on $FROM" || return 1
	SESSION=$(lberth "sessions $BOX --json" | jq_py '[s["name"] for s in j if s.get("agent") == "claude"][0]') || return 1
	PID0=$(bx "pgrep -f 'node /usr/local/bin/claude' | head -1")
	[ -n "$PID0" ] || fail "the stand-in isn't running" || return 1
	# A kit, applied to the project.
	lp "mkdir -p ~/kits/release-test && cat >~/kits/release-test/kit.json <<'EOF'
$KIT_JSON
EOF" || return 1
	lberth "kit add ~/kits/release-test --yes" && lberth "kit apply release-test $BOX/hello" || fail "could not add and apply a kit on $FROM" || return 1
	# The app's settings (kept by the laptop agent) and a laptop hook.
	laptop_api PUT /v1/app/release-test '{"kept":true,"from":"'"$FROM"'"}' >/dev/null || return 1
	laptop_api PUT /v1/hooks '{"hooks":[{"on":"agent.finished","run":"true # release-test hook"}]}' >/dev/null || return 1
	detail "session $SESSION (stand-in pid $PID0), kit release-test on $BOX/hello, an app setting, a hook"
}

l_upgrade_box() {
	local out
	out=$(bx "curl -fsSL http://127.0.0.1:8000/new/install.sh | BERTH_DOWNLOAD_BASE=http://127.0.0.1:8000/new sh -s -- --yes --no-pair" 2>&1) || {
		echo "$out"
		fail "install.sh over $FROM failed"
		return 1
	}
	echo "$out"
	echo "$out" | grep -q "upgrading" || fail "install.sh did not say it upgraded in place" || return 1
	bx "systemctl --user is-active berthd" | grep -qx active || fail "berthd is not active after the upgrade" || return 1
	detail "$(bx 'berthd version'); the listen address kept"
}

l_upgrade_laptop() {
	local arch
	arch=$(docker_arch)
	lp "curl -fsSL http://$BOXC:8000/new/berth-linux-$arch.tar.gz | tar -xzf - -C ~/.local/bin berth" || return 1
	lberth stop >/dev/null 2>&1 || true
	until_ok 30 lberth "ping $BOX" || fail "the upgraded laptop can't reach $BOX" || return 1
	detail "$(lberth version); the agent restarted and reaches $BOX"
}

l_session() {
	local s
	s=$(lberth "sessions $BOX --json" | jq_py "[x for x in j if x['name'] == '$SESSION']") || return 1
	echo "$s" | jq_py 'len(j) == 1 and not j[0]["exited"]' >/dev/null || fail "$SESSION is gone or exited: $s" || return 1
	bx "kill -0 $PID0" || fail "the stand-in agent (pid $PID0) died in the upgrade" || return 1
	detail "$SESSION still running, the same agent process ($PID0)"
}

turns_two() { report_json | jq_py 'j["turns"] >= 2' >/dev/null; }
l_second_prompt() {
	lberth "session send $BOX/$SESSION 'And add a /version endpoint' --wait --timeout 60s" || fail "sending a prompt after the upgrade failed" || return 1
	until_ok 30 turns_two || fail "the agent never took the second prompt" || return 1
	detail "the second turn ran and finished"
}

l_kit() {
	local list
	list=$(lberth "kit list --json")
	echo "$list"
	echo "$list" | grep -q '"release-test"' || fail "the kit is gone from the laptop: $list" || return 1
	echo "$list" | grep -q "$BOX/hello\|\"$BOX\"" || fail "the kit no longer shows as installed on $BOX/hello: $list" || return 1
	lberth "location config $BOX/hello --json" | grep -q HELLO_KIT || fail "the project's config lost the kit's env" || return 1
	detail "release-test still applied to $BOX/hello (HELLO_KIT in its config)"
}

l_settings() {
	laptop_api GET /v1/app/release-test | jq_py 'j["kept"] is True' >/dev/null || fail "the app setting is gone" || return 1
	laptop_api GET /v1/hooks | grep -q 'release-test hook' || fail "the hook is gone" || return 1
	detail "the app setting (release-test) and hooks.json kept"
}

l_url() {
	local body
	body=$(lp "curl -fsS --max-time 15 http://$WT.hello.$BOX.localhost:1377/health") || fail "the worktree URL no longer answers" || return 1
	[ "$body" = '{"ok":true}' ] || fail "the worktree URL said $body" || return 1
	detail "http://$WT.hello.$BOX.localhost:1377/health → $body"
}

# ---------------------------------------------------------------- macOS ---

run_mac() {
	# shellcheck source=release-test/macos/lib.sh
	source "$here/release-test/macos/lib.sh"
	rt_init "Terminal upgrade test (this Mac's box, $FROM → this build)" "${OUT:-$REPO/dist/release-test/upgrade-mac-$stamp}"
	trap 'mac_cleanup >>"$RT_LOG" 2>&1' EXIT
	trap 'exit 130' INT TERM
	BOX="" LOC=hello WT="" SESSION="" PID0="" AGENT_PID="" NO_SESSION=0 TABS_BEFORE="" PLUGIN_OFF="" PLUGIN_ON=""

	RT_CRITICAL=1 step "Prepare; the $FROM and new dmgs" m_prepare
	RT_CRITICAL=1 step "$FROM: install, start, onboard this Mac" m_old
	step "$FROM: a task left running" m_task
	step "$FROM: preferences, plugins, a layout with tab groups" m_ui_state
	step "$FROM: a kit" m_kit
	RT_CRITICAL=1 step "Replace the app, as the updater does, and start it" m_upgrade
	step "The layout is restored" m_layout
	step "Preferences and plugins kept" m_prefs
	step "The session kept running" m_session
	RT_CRITICAL=1 step "The agent restarted with the app, and updated this Mac's box" m_agent_restart
	step "The session survived the box's upgrade" m_session_after
	step "It answers a second prompt" m_second_prompt
	step "The kit is intact" m_kit_after
	rt_finish
}

m_prepare() {
	mac_setup || return 1
	OLD_DMG=$(download_dmg "$FROM" "$ROOT") || fail "could not download $FROM's dmg" || return 1
	mv "$OLD_DMG" "$ROOT/old.dmg" && OLD_DMG="$ROOT/old.dmg"
	[ -n "$DMG" ] || DMG=$(find_dmg 2>"$ROOT/dmg.find") || fail "$(tr '\n' ' ' <"$ROOT/dmg.find")" || return 1
	check_dmg "$DMG" "$ANY" 2>"$ROOT/dmg.check" || fail "$(cat "$ROOT/dmg.check")" || return 1
	# Never a downgrade: an older build "upgrading" a newer release loses
	# what the newer one keeps, and looks like a regression.
	if [ "$(printf '%s\n%s\n' "${FROM#v}" "$DMG_VERSION" | sort -V | head -1)" != "${FROM#v}" ]; then
		fail "$(basename "$DMG") is Terminal $DMG_VERSION, older than $FROM: that's a downgrade, not an upgrade"
		return 1
	fi
	detail "$FROM → $(basename "$DMG"): Terminal $DMG_VERSION built from ${DMG_REVISION:0:9}"
}

m_old() {
	install_dmg "$OLD_DMG" "$ROOT/Applications" || return 1
	APP_UNDER_TEST="$ROOT/app/Terminal Test.app"
	mkdir -p "$ROOT/app"
	test_copy "$INSTALLED_APP" "$APP_UNDER_TEST" || return 1
	# The old box gets a UTF-8 locale (see the top of this file).
	export BERTH_RELEASE_TEST_LANG=en_US.UTF-8
	launch_app "$APP_UNDER_TEST" || return 1
	front
	# $FROM may be from before Berth became Terminal, and named so.
	local name=Terminal
	case $INSTALLED_APP in */Berth.app) name=Berth ;; esac
	if ax wait "Start the $name agent" --timeout 15 >/dev/null 2>&1; then ax press "Start the $name agent" --role AXButton || return 1; fi
	ax press "Start on this Mac" --role AXButton --timeout 30 || return 1
	ax wait "Try the sample project" --timeout 180 || fail "$FROM: setting up this Mac never finished" || return 1
	BOX=$(api GET /v1/status | jq_py 'j["boxes"][0]["name"]') || return 1
	ax press "Use the sample" --role AXButton || return 1
	ax wait "Start your first agent" --timeout 60 || return 1
	detail "Terminal $(app_version "$APP_UNDER_TEST"), box $BOX"
}

m_task() {
	front
	ax press "Start" --role AXButton --exact || return 1
	local said="" i=0 now
	while ! agent_turn_ended; do
		now=$(ax text 2>/dev/null | grep -i -E "gone|couldn|can't|error|fail|missing|not installed" | sort -u | head -2 | tr '\n' ' ')
		[ -z "$now" ] || said=$now
		i=$((i + 1))
		if [ $i -gt 25 ]; then
			# An old release whose box can't start agents here (before
			# v0.3.5 its launchd PATH had no Homebrew tmux): there is no
			# session to keep, and the rest still runs.
			NO_SESSION=1
			detail "$FROM couldn't start an agent on this Mac's box (it said: ${said:-nothing}); the session checks are skipped"
			ax press "I'll explore first" --role AXButton >/dev/null 2>&1 || ax press "Skip setup" --role AXButton >/dev/null 2>&1
			# A worktree without an agent, for the layout.
			WT=layout
			api POST "/v1/boxes/$BOX/api/locations/$LOC/worktrees" '{"name":"layout"}' || return 1
			return 2
		fi
		sleep 2
	done
	SESSION=$(api GET "/v1/boxes/$BOX/api/sessions" | jq_py '[s["name"] for s in j if s.get("agent") == "claude"][0]') || return 1
	WT=$(api GET "/v1/boxes/$BOX/api/locations" | jq_py '[w["name"] for l in j for w in l["worktrees"] if not w.get("main")][0]') || return 1
	PID0=$(pgrep -f "node $THOME/.local/bin/claude" | head -1)
	[ -n "$PID0" ] || fail "the stand-in isn't running" || return 1
	detail "$SESSION in $WT, stand-in pid $PID0"
}
agent_turn_ended() { cat "$ROOT"/fake-claude/*.json 2>/dev/null | grep -q '"event": "Stop"'; }

# toggled NAME: the value (0/1) of the switch or checkbox called NAME.
toggled() { "$AX" dump "$APP_PID" | grep -F "title=\"$1\"" | grep -o 'value="[01]"' | head -1 | tr -dc '01'; }

m_ui_state() {
	front
	# Preferences: closing an agent's tab keeps it running; Labs on (tab groups).
	ax press "Settings" --role AXButton --exact || return 1
	ax press "General" --role AXButton --exact || return 1
	ax press "Keep running" --role AXCheckBox --exact || return 1
	[ "$(toggled "Keep running")" = 1 ] || fail "the Keep running preference didn't take" || return 1
	# Plugins: Notes off, Usage & accounts on.
	ax press "Plugins" --role AXButton --exact || return 1
	# Whichever this release has: the first built-in that is on (past the
	# panels the layout uses) goes off, and the first that is off goes on.
	ax wait "Built in" --timeout 10 || return 1
	sleep 1
	PLUGIN_OFF=$(ax text | sed -n 's/^Turn off //p' | grep -v -x -E 'Diff|Git changes' | head -1)
	PLUGIN_ON=$(ax text | sed -n 's/^Turn on //p' | head -1)
	# (v0.3.0's page had no switches for built-ins.)
	if [ -n "$PLUGIN_OFF" ]; then
		ax press "Turn off $PLUGIN_OFF" --role AXCheckBox --exact || return 1
		ax wait "Turn on $PLUGIN_OFF" --role AXCheckBox --exact --timeout 5 || fail "$PLUGIN_OFF didn't turn off" || return 1
	fi
	if [ -n "$PLUGIN_ON" ]; then
		ax press "Turn on $PLUGIN_ON" --role AXCheckBox --exact || return 1
		ax wait "Turn off $PLUGIN_ON" --role AXCheckBox --exact --timeout 5 || fail "$PLUGIN_ON didn't turn on" || return 1
	fi
	# A layout: the worktree's agent and Diff tabs, and the main checkout's
	# tabs beside them as a second group (Labs' tab groups, on by default)
	# with a browser tab.
	# With no task, the main checkout and the worktree made for this.
	local other="$LOC main ·" group="$LOC"
	if [ "$NO_SESSION" = 1 ]; then
		ax press "$LOC actions" --role AXPopUpButton || return 1
		ax press "Open main checkout" --role AXMenuItem || return 1
		other="$WT ·" group="$WT"
	else
		ax press "$WT" --role AXButton || return 1
	fi
	ax press "New tab" --role AXPopUpButton || return 1
	if ax press "Diff" --exact --role AXStaticText --timeout 3; then
		ax wait "What to compare" --timeout 15 || fail "the Diff panel didn't open" || return 1
	else
		# A release without the Diff panel (v0.3.0): a browser tab instead.
		ax press "New browser tab" || return 1
	fi
	ax press "New tab" --role AXPopUpButton || return 1
	local groups="two tab groups"
	if ax press "Another worktree's tabs" --timeout 3; then
		ax press "$other" || return 1
		until_ok 10 group_has "$group" 0 || fail "the second worktree's group didn't join the strip" || return 1
		ax press "New tab" --role AXPopUpButton || return 1
		ax press "New browser tab" || return 1
		until_ok 10 group_has "$group" 1 || fail "the browser tab didn't open in the second group" || return 1
	else
		# Tab groups came after v0.3.0.
		ax key escape
		ax press "New tab" --role AXPopUpButton || return 1
		ax press "New browser tab" || return 1
		groups="one group: $FROM has no tab groups"
	fi
	TABS_BEFORE=$(layout)
	echo "layout: $TABS_BEFORE"
	detail "Keep running on, ${PLUGIN_OFF:-no plugin} off${PLUGIN_ON:+, $PLUGIN_ON on}; layout ($groups): $TABS_BEFORE"
}
# layout: the strip's groups and tabs, as "group:N tabs" and tab titles,
# read from either way the app has named them: before 0.3.7 a group was a
# button "hello, 1 tab" and a tab had a "Close <title>" button; since, the
# strip is a tab group of "hello tab group, 1 tab" buttons and "<title>,
# <worktree>" tabs.
group_has() { layout | tr '|' '\n' | grep -q -x -F "$1:$2"; }
layout() {
	"$AX" dump "$APP_PID" | python3 -c '
import re, sys
out = set()
for line in sys.stdin:
    m = re.search(r"^\s*(AXButton|AXRadioButton)\S* title=\"(.*?)\"", line)
    if not m:
        continue
    role, t = m.groups()
    t = t.replace("\\'"'"'", "'"'"'")
    g = re.fullmatch(r"(.+?)(?: tab group)?, (\d+) tabs?(?:, in front)?", t)
    if role == "AXButton" and g:
        out.add("%s:%s" % g.groups())
    elif role == "AXButton" and t.startswith("Close "):
        out.add(t[len("Close "):])
    elif role == "AXRadioButton" and ", " in t:
        out.add(t.rsplit(", ", 1)[0])
print("|".join(sorted(out)))
'
}

m_kit() {
	mkdir -p "$ROOT/kits/release-test"
	echo "$KIT_JSON" >"$ROOT/kits/release-test/kit.json"
	berth_cli kit add "$ROOT/kits/release-test" --yes || fail "berth kit add failed on $FROM" || return 1
	berth_cli kit apply release-test "$BOX/$LOC" || fail "berth kit apply failed on $FROM" || return 1
	detail "release-test applied to $BOX/$LOC"
}

agent_gone() { ! kill -0 "$AGENT_PID" 2>/dev/null; }
# new_agent: the agent answers as one of this build (GET /v1/agent).
new_agent() { api GET /v1/agent | jq_py "j['pid'] != $AGENT_PID" >/dev/null; }
m_upgrade() {
	AGENT_PID=$(pgrep -f "$ROOT/app/Terminal Test.app/Contents/MacOS/berth-cli agent" | head -1)
	[ -n "$AGENT_PID" ] || fail "no agent from $FROM is running" || return 1
	# The box's berthd before: the new agent replaces it soon after it starts.
	OLD_BUILD=$(box_build)
	quit_app
	unset BERTH_RELEASE_TEST_LANG
	install_dmg "$DMG" "$ROOT/Applications" || return 1
	test_copy "$INSTALLED_APP" "$APP_UNDER_TEST" || return 1
	launch_app "$APP_UNDER_TEST" || return 1
	local version
	version=$(app_version "$APP_UNDER_TEST")
	# The app finds the agent from $FROM, restarts it, and says so.
	ax wait "Updated to v$version" --timeout 60 || fail "the app didn't say it was updated to v$version" || return 1
	until_ok 60 agent_gone || fail "the agent from $FROM (pid $AGENT_PID) still runs: the app didn't restart it" || return 1
	until_ok 30 new_agent || fail "no agent of this build answers after the restart: $(api GET /v1/agent | head -c 300)" || return 1
	front
	ax wait "$LOC actions" --role AXPopUpButton --timeout 30 || fail "the upgraded app doesn't show the project (onboarding again?)" || return 1
	detail "Terminal $version started, said \"Updated to v$version\", and restarted the agent from $FROM (pid $AGENT_PID → $(api GET /v1/agent | jq_py 'j["pid"]'))"
}

m_layout() {
	[ -n "$TABS_BEFORE" ] || { detail "no layout was made on $FROM"; return 2; }
	front
	sleep 2
	local after
	after=$(layout)
	echo "layout after: $after"
	[ "$after" = "$TABS_BEFORE" ] || fail "the layout was [$TABS_BEFORE], now [$after]" || return 1
	detail "groups and tabs restored: $after"
}

m_prefs() {
	front
	ax press "Settings" --role AXButton --exact || return 1
	ax press "General" --role AXButton --exact || return 1
	[ "$(toggled "Keep running")" = 1 ] || fail "closing an agent's tab no longer keeps it running" || return 1
	ax press "Plugins" --role AXButton --exact || return 1
	if [ -n "$PLUGIN_OFF" ]; then
		ax wait "Turn on $PLUGIN_OFF" --role AXCheckBox --exact --timeout 10 || fail "$PLUGIN_OFF is on again" || return 1
	fi
	if [ -n "$PLUGIN_ON" ]; then
		ax wait "Turn off $PLUGIN_ON" --role AXCheckBox --exact --timeout 5 || fail "$PLUGIN_ON is off again" || return 1
	fi
	detail "Keep running, ${PLUGIN_OFF:-no plugin} off${PLUGIN_ON:+, $PLUGIN_ON on}"
}

session_listed() { api GET "/v1/boxes/$BOX/api/sessions" | jq_py "isinstance(j, list) and any(s['name'] == '$SESSION' and not s['exited'] for s in j)" >/dev/null; }
# box_online: whether the agent reaches this Mac's box.
box_online() { api GET /v1/status | jq_py "any(b['name'] == '$BOX' and b.get('state') == 'online' for b in j['boxes'])" >/dev/null; }
m_session() {
	[ "$NO_SESSION" = 0 ] || { detail "no session on $FROM"; return 2; }
	# Unreachable is not gone: say which.
	until_ok 20 box_online || fail "this Mac's box isn't online: $(api GET /v1/status | head -c 300)" || return 1
	# Just after the box restarts its first answers can be an error: ask
	# again for a while, and say what it answered.
	until_ok 20 session_listed || fail "$SESSION is not running; the box lists: $(api GET "/v1/boxes/$BOX/api/sessions" | head -c 400)" || return 1
	kill -0 "$PID0" || fail "the stand-in (pid $PID0) died" || return 1
	detail "$SESSION running, pid $PID0"
}

box_build() { api GET "/v1/boxes/$BOX/api/info" | jq_py 'j.get("build")'; }
new_build() { [ "$(box_build)" = "$NEW_BUILD" ]; }
m_agent_restart() {
	NEW_BUILD=$(BERTH_HOME="$ROOT/x" "$APP_UNDER_TEST/Contents/Resources/berthd" version | sed -n 's/.*build \([0-9a-f]*\).*/\1/p')
	[ -n "$NEW_BUILD" ] || fail "the new app carries no berthd to update the box with" || return 1
	[ -n "$OLD_BUILD" ] || fail "this Mac's box didn't answer before the upgrade" || return 1
	# No restart of the Mac, no Start button: the agent the app restarted
	# brings the box up to date by itself.
	until_ok 90 new_build || fail "this Mac's box still runs build $(box_build), not the app's $NEW_BUILD" || return 1
	detail "box berthd $OLD_BUILD → $NEW_BUILD, by the restarted agent's refresh"
}

m_session_after() { m_session; }

mac_turns_two() { cat "$ROOT"/fake-claude/*.json | jq_py 'j["turns"] >= 2' >/dev/null; }
m_second_prompt() {
	[ "$NO_SESSION" = 0 ] || { detail "no session on $FROM"; return 2; }
	berth_cli session send "$BOX/$SESSION" "And add a /version endpoint" --wait --timeout 60s || fail "sending a prompt after the upgrade failed" || return 1
	until_ok 30 mac_turns_two || fail "the agent never took the second prompt" || return 1
	detail "the second turn ran and finished on the new berthd"
}

m_kit_after() {
	local list
	list=$(berth_cli kit list --json)
	echo "$list"
	echo "$list" | grep -q '"release-test"' || fail "the kit is gone" || return 1
	berth_cli location config "$BOX/$LOC" --json | grep -q HELLO_KIT || fail "the project lost the kit's env" || return 1
	detail "release-test still applied to $BOX/$LOC"
}

case ",$MODE," in
*,linux,*mac* | *mac*,linux,*)
	# One report each: run the halves as their own processes.
	rc=0
	"$0" --linux --from "$FROM" ${DIST:+--dist "$DIST"} ${OUT:+--out "$OUT/linux"} || rc=1
	"$0" --mac --from "$FROM" ${DMG:+--dmg "$DMG"} ${ANY:+--any-build} ${OUT:+--out "$OUT/mac"} || rc=1
	exit $rc
	;;
*,linux,*) run_linux ;;
*,mac,*) run_mac ;;
esac
