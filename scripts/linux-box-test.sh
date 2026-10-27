#!/usr/bin/env bash
# The Linux fresh-box release test, in Docker: a fresh Ubuntu 24.04 box and
# a fresh laptop, with this checkout's install.sh and builds. Run by hand
# now and then (make release-check), and weekly in CI (release-test.yml).
#
#   scripts/linux-box-test.sh                 builds berthd and berth for the containers
#   scripts/linux-box-test.sh --dist dist     uses release archives made by make release
#   scripts/linux-box-test.sh --tag v0.3.6    uses that release's archives
#   options: --version vX.Y.Z (stamped into the build; default dev),
#            --out DIR (report; default dist/release-test/linux-box-<time>), --keep
#
# Steps: install.sh installs berthd and starts its systemd user service;
# berth, installed as the CLI without the app, pairs from a fresh laptop
# home; the sample project; a task with the stand-in agent (scripts/
# release-test/fake-claude); its dev server on $BERTH_PORT; the worktree URL
# through the laptop's proxy; the agent browser blocked by Chromium's
# sandbox (a stand-in Chromium that fails as Ubuntu 24.04 makes it): berthd
# must say so with the fix, not crash, and its no-sandbox setting must reach
# Chromium; then removing the worktree. Needs Docker and Go.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=release-test/common.sh
source "$here/release-test/common.sh"
# shellcheck source=release-test/linux/lib.sh
source "$here/release-test/linux/lib.sh"

DIST="" TAG="" VERSION=dev OUT="" KEEP=0
while [ $# -gt 0 ]; do
	case $1 in
	--dist) DIST=$(cd "$2" && pwd) && shift 2 ;;
	--tag) TAG=$2 && shift 2 ;;
	--version) VERSION=$2 && shift 2 ;;
	--out) OUT=$2 && shift 2 ;;
	--keep) KEEP=1 && shift ;;
	-h | --help) sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//' && exit 0 ;;
	*) echo "unknown option $1 (try --help)" >&2 && exit 2 ;;
	esac
done
# The cleanup (in the sourced lib) reads it.
export KEEP
OUT=${OUT:-$REPO/dist/release-test/linux-box-$(date +%Y%m%d-%H%M%S)}
rt_init "Terminal fresh-box test (Linux, Docker)" "$OUT"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/berth-linux-test.XXXXXX")
trap 'linux_cleanup >>"$RT_LOG" 2>&1; rm -rf "$WORK"' EXIT
trap 'exit 130' INT TERM

BOX="" WT=health

s_build() {
	docker info >/dev/null 2>&1 || fail "Docker is not running" || return 1
	if [ -n "$TAG" ]; then
		download_dist "$TAG" "$WORK/dist" || fail "could not download $TAG's Linux archives" || return 1
	elif [ -n "$DIST" ]; then
		use_dist "$DIST" "$WORK/dist" || fail "$DIST lacks the Linux archives (make release makes them)" || return 1
	else
		build_dist "$WORK/dist" "$VERSION" || fail "could not build berthd and berth for linux/$(docker_arch)" || return 1
	fi
	build_image || fail "could not build the Ubuntu 24.04 image" || return 1
	detail "linux/$(docker_arch) archives $(ls "$WORK/dist" | paste -sd' ' -)"
}

s_machines() {
	start_machines "berth-rt-$$" "$WORK/dist" || return 1
	detail "box $BOXC (systemd, user dev lingering) and laptop $LAPC on $NET"
}

s_install() {
	box_install || fail "install.sh failed" || return 1
	bx "systemctl --user is-active berthd" | grep -qx active || fail "berthd's service is not active" || return 1
	local v
	v=$(bx "berthd version") || return 1
	detail "$v, a systemd user service; pairing link printed"
}

box_pings() { lp "berth ping $BOX"; }
s_pair() {
	laptop_cli || fail "could not install berth on the laptop from the archive" || return 1
	lp "berth pair '$PAIR_LINK' --json" || fail "berth pair failed" || return 1
	BOX=$(lp "berth boxes --json" | jq_py '[b["name"] for b in j][0]') || fail "no box after pairing" || return 1
	until_ok 30 box_pings || fail "$BOX does not answer berth ping" || return 1
	detail "the laptop paired with $BOX from a fresh home; $(lp "berth version")"
}

s_sample() {
	local loc
	loc=$(laptop_api POST "/v1/boxes/$BOX/api/locations/new" '{"sample":"hello"}') || return 1
	echo "$loc"
	echo "$loc" | jq_py 'j["name"] == "hello"' >/dev/null || fail "the sample project was not made: $loc" || return 1
	detail "hello in $(echo "$loc" | jq_py 'j["path"]')"
}

report_json() { bx 'cat /tmp/fake-claude/*.json' 2>/dev/null; }
turn_ended() { report_json | grep -q '"event": "Stop"'; }
session_finished() { lp "berth sessions $BOX --json" | grep -q -E '"agent_state": *"finished"'; }
s_task() {
	lp "berth task new $BOX/hello/$WT --agent claude --prompt 'Add a /health endpoint to server.js that returns {\"ok\": true}, with a test'" ||
		fail "berth task new failed" || return 1
	until_ok 60 turn_ended || fail "the stand-in agent's turn never ended: $(bx 'ls /tmp/fake-claude; tmux -L berth ls' 2>&1 | tr '\n' ' ')" || return 1
	until_ok 30 session_finished || fail "the box never saw the turn finish: $(lp "berth sessions $BOX --json")" || return 1
	detail "the stand-in ran in $BOX/hello/$WT; its hooks reported the turn finished"
}

s_dev_server() {
	local rep port berth_port
	rep=$(report_json)
	port=$(echo "$rep" | jq_py 'j["env"].get("PORT")') || fail "the session had no PORT" || return 1
	berth_port=$(echo "$rep" | jq_py 'j["env"].get("BERTH_PORT")') || fail "the session had no BERTH_PORT" || return 1
	[ "$port" = "$berth_port" ] || fail "PORT=$port but BERTH_PORT=$berth_port" || return 1
	until_ok 20 bx "curl -fsS http://127.0.0.1:$port/health" || fail "nothing answers on the box's port $port" || return 1
	detail "the dev server listens on \$BERTH_PORT=$port"
}

s_url() {
	local url="http://$WT.hello.$BOX.localhost:1377/health" body
	body=$(lp "curl -fsS --max-time 15 $url") || fail "$url did not answer through the laptop's proxy" || return 1
	[ "$body" = '{"ok":true}' ] || fail "$url said $body" || return 1
	detail "$url → $body"
}

s_browser_sandbox() {
	local pid0 out health state
	pid0=$(bx "systemctl --user show -p MainPID --value berthd")
	out=$(lp "berth browser open $BOX/hello/$WT /health" 2>&1) && fail "the agent's browser opened, past a Chromium that can't start its sandbox: $out" && return 1
	echo "$out"
	echo "$out" | grep -q "blocked" || fail "berth browser open did not say the browser is blocked: $out" || return 1
	health=$(laptop_api GET "/v1/boxes/$BOX/api/browser/health") || return 1
	echo "$health"
	state=$(echo "$health" | jq_py 'j["state"]')
	[ "$state" = sandbox ] || fail "browser health says $state, not sandbox: $health" || return 1
	if [ "$(echo "$health" | jq_py 'j.get("userns", "")' || true)" = 1 ]; then
		echo "$health" | jq_py '"apparmor_restrict_unprivileged_userns=0" in j.get("fix", "")' >/dev/null ||
			fail "Ubuntu's sysctl is set, but health offers no fix: $health" || return 1
	fi
	[ "$(bx "systemctl --user show -p MainPID --value berthd")" = "$pid0" ] || fail "berthd restarted (crashed?) when the browser failed" || return 1
	# The other fix the card offers: run without Chromium's sandbox.
	laptop_api PUT "/v1/boxes/$BOX/api/browser/settings" '{"no_sandbox":true}' >/dev/null || return 1
	out=$(lp "berth browser open $BOX/hello/$WT /health" 2>&1) || true
	echo "$out"
	echo "$out" | grep -q "setting-reached" || fail "with no_sandbox on, Chromium still was not started with --no-sandbox: $out" || return 1
	laptop_api PUT "/v1/boxes/$BOX/api/browser/settings" '{"no_sandbox":false}' >/dev/null
	detail "blocked, with the reason ($(echo "$health" | jq_py 'j["text"]' | cut -c1-90)…); no_sandbox reaches Chromium; berthd kept running"
}

s_remove() {
	local path
	path=$(lp "berth locations $BOX --json" | jq_py "[w['path'] for l in j for w in l['worktrees'] if w['name'] == '$WT'][0]") || fail "no worktree $WT" || return 1
	lp "berth worktree rm $BOX/hello/$WT" || fail "berth worktree rm failed" || return 1
	until_ok 20 sh -c "! docker exec '$BOXC' test -d '$path'" || fail "$path is still there" || return 1
	lp "berth locations $BOX --json" | jq_py "all(w['name'] != '$WT' for l in j for w in l['worktrees'])" >/dev/null ||
		fail "$WT is still listed" || return 1
	detail "$WT removed from the box and from disk"
}

s_doctor() {
	local out
	out=$(lp "berth doctor $BOX --json" 2>&1) || true
	echo "$out"
	detail "berth doctor $BOX: $(echo "$out" | grep -o '"status": *"fail"' | wc -l | tr -d ' ') failing checks (informational)"
}

RT_CRITICAL=1 step "Build the release archives and the Ubuntu image" s_build
RT_CRITICAL=1 step "Start a fresh box and laptop" s_machines
RT_CRITICAL=1 step "install.sh installs and starts berthd" s_install
RT_CRITICAL=1 step "berth pairs from a fresh laptop home" s_pair
RT_CRITICAL=1 step "The sample project" s_sample
RT_CRITICAL=1 step "A task with the stand-in agent" s_task
step "Dev server on \$BERTH_PORT" s_dev_server
step "Worktree URL through the proxy" s_url
step "Agent browser: blocked by the sandbox, with the fixes" s_browser_sandbox
step "Remove the worktree" s_remove
step "berth doctor on the box" s_doctor
rt_finish
