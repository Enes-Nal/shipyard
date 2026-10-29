#!/usr/bin/env bash
# Agent CLIs installed with npm, in Docker: a fresh Ubuntu 24.04 box with
# berthd as its systemd user service (installed first, so its PATH knows
# nothing of what comes after), then Claude Code installed the way many
# people do, with nvm and `npm i -g @anthropic-ai/claude-code`. nvm lives in
# ~/.bashrc, which neither berthd's service PATH nor a login shell reads.
# berthd must find it all the same, through the person's interactive shell:
# doctor names it with its path, the box offers it, and a session started
# with it runs it, with node found beside it. Nothing signs in to Claude:
# the session only runs `claude --version`, and the agent's own session is
# stopped at its first screen. Downloads nvm, Node and the npm package, so
# it needs the network as well as Docker and Go.
#
#   scripts/agent-path-test.sh [--out DIR] [--keep] [--version vX.Y.Z]
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=release-test/common.sh
source "$here/release-test/common.sh"
# shellcheck source=release-test/linux/lib.sh
source "$here/release-test/linux/lib.sh"

VERSION=dev OUT="" KEEP=0
while [ $# -gt 0 ]; do
	case $1 in
	--version) VERSION=$2 && shift 2 ;;
	--out) OUT=$2 && shift 2 ;;
	--keep) KEEP=1 && shift ;;
	-h | --help) sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//' && exit 0 ;;
	*) echo "unknown option $1 (try --help)" >&2 && exit 2 ;;
	esac
done
export KEEP
OUT=${OUT:-$REPO/dist/release-test/agent-path-$(date +%Y%m%d-%H%M%S)}
rt_init "Terminal agent CLIs from npm (Linux, Docker)" "$OUT"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/berth-agent-path.XXXXXX")
trap 'linux_cleanup >>"$RT_LOG" 2>&1; rm -rf "$WORK"' EXIT
trap 'exit 130' INT TERM

s_build() {
	docker info >/dev/null 2>&1 || fail "Docker is not running" || return 1
	build_dist "$WORK/dist" "$VERSION" || fail "could not build berthd and berth for linux/$(docker_arch)" || return 1
	build_image || fail "could not build the Ubuntu 24.04 image" || return 1
}

s_machines() {
	start_machines "berth-agentpath-$$" "$WORK/dist" || return 1
	# The image's stand-in claude and its system Node would hide what this
	# test is about.
	docker exec "$BOXC" sh -c 'rm -f /usr/local/bin/claude /usr/bin/node /usr/bin/nodejs' || return 1
	detail "box $BOXC with no claude and no node"
}

s_install() {
	box_install || fail "install.sh failed" || return 1
	until_ok 30 bx "berthd doctor" >/dev/null || fail "berthd does not answer" || return 1
	detail "berthd runs as dev's systemd user service"
}

s_npm() {
	bx 'curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash' >/dev/null 2>&1 || fail "nvm did not install" || return 1
	bx "bash -ic 'nvm install 22 >/dev/null 2>&1 && npm i -g @anthropic-ai/claude-code >/dev/null 2>&1 && command -v claude && claude --version'" 2>/dev/null | tail -2 || fail "Claude Code did not install with npm" || return 1
	CLAUDE=$(bx "bash -ic 'command -v claude'" 2>/dev/null | tail -1)
	case $CLAUDE in */.nvm/versions/node/*/bin/claude) ;; *) fail "npm put claude at '$CLAUDE'" && return 1 ;; esac
	# Neither a login shell nor berthd's service PATH has it.
	bx "command -v claude" >/dev/null && fail "a login shell finds claude: the test proves nothing" && return 1
	bx 'tr "\0" "\n" </proc/$(systemctl --user show -p MainPID --value berthd)/environ | grep ^PATH=' | grep -q .nvm && fail "berthd's PATH has nvm: the test proves nothing" && return 1
	detail "claude at $CLAUDE, from nvm's Node 22 and npm; a login shell and berthd's PATH don't have it"
}

s_doctor() {
	local out
	out=$(bx "berthd doctor") || fail "berthd doctor failed" || return 1
	echo "$out" | sed -n '/^Agents/,/^$/p'
	echo "$out" | grep -E "Claude Code .*~/.nvm/versions/node/v22[^ ]*/bin/claude \(npm\)" || fail "doctor does not name the npm claude" || return 1
	bx "berthd agents list --json" | tr -d " \n" | grep -q '"id":"claude"[^}]*"installed":true' || fail "berthd agents list does not have Claude Code: $(bx 'berthd agents list --json')" || return 1
	detail "doctor: $(echo "$out" | grep -E 'Claude Code .*\(npm\)' | sed 's/^ *//' | head -1); the box offers Claude Code"
}

s_session() {
	bx "mkdir -p ~/code/demo && cd ~/code/demo && git init -q && git -c user.name=dev -c user.email=dev@example.com commit -q --allow-empty -m init && berthd location add demo ~/code/demo" >/dev/null || fail "could not add a location" || return 1
	# What the session runs is `claude --version` as the app would start it;
	# its answer, and which claude ran, go to a file.
	bx "berthd session new demo --name version -- 'claude --version >~/claude-version.txt 2>&1; command -v claude >>~/claude-version.txt'" >/dev/null || fail "the session did not start" || return 1
	until_ok 30 bx "grep -q 'Claude Code' ~/claude-version.txt" || fail "claude --version in a session: $(bx 'cat ~/claude-version.txt; berthd session screen version')" || return 1
	local v
	v=$(bx "cat ~/claude-version.txt" | tr '\n' ' ')
	echo "$v"
	echo "$v" | grep -q "$CLAUDE" || fail "the session ran another claude: $v" || return 1
	# The agent itself, as the app starts it: its first screen, never a sign-in.
	bx "berthd session new demo --name agent --agent claude" >/dev/null || fail "the agent's session did not start" || return 1
	sleep 5
	local screen
	screen=$(bx "berthd session screen agent")
	echo "$screen" | head -15
	echo "$screen" | grep -qiE "not found|No such file" && fail "the agent's session could not run claude" && return 1
	[ -n "$(echo "$screen" | tr -d '[:space:]')" ] || fail "the agent's session shows nothing" || return 1
	bx "berthd session kill agent; berthd session kill version" >/dev/null || true
	detail "a session ran claude --version ($v); an agent session started Claude Code and was stopped at its first screen"
}

RT_CRITICAL=1 step "Build berthd, berth and the Ubuntu image" s_build
RT_CRITICAL=1 step "Start a box without claude or node" s_machines
RT_CRITICAL=1 step "Install berthd as a user service" s_install
RT_CRITICAL=1 step "Install Claude Code with nvm and npm" s_npm
step "doctor and the box find it" s_doctor
step "A session starts with it" s_session
rt_finish
