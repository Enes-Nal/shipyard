#!/bin/bash
# A real berthd in an isolated state dir, HOME, user dir and tmux socket
# folder, on 127.0.0.1:17461, with the stand-in Claude on PATH.
set -u
exec > "$1" 2>&1
P=/private/tmp/claude-501/-Users-sean-personal-berth/455ddabf-2b3a-47a6-a7b6-d06a2caf9b45/scratchpad/proofrun
R=$(mktemp -d /tmp/bdp.XXXX)
for v in $(env | grep -o '^BERTH_[A-Z_]*'); do unset "$v"; done
unset TMUX TMUX_PANE
export HOME=$R/home BERTH_HOME=$R/state BERTH_USER_DIR=$R/user TMUX_TMPDIR=$R/tmux CLAUDE_CONFIG_DIR=$R/claude
export PATH=$P/bin:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin
export GIT_AUTHOR_NAME="berth proof" GIT_AUTHOR_EMAIL=proof@example.com GIT_COMMITTER_NAME="berth proof" GIT_COMMITTER_EMAIL=proof@example.com
mkdir -p "$HOME" "$BERTH_HOME" "$BERTH_USER_DIR" "$TMUX_TMPDIR" "$CLAUDE_CONFIG_DIR"
B=$P/bin/berthd
SOCK=$BERTH_HOME/box/berthd.sock

say() { printf '\n$ %s\n' "$*"; }
api() { curl -s --unix-socket "$SOCK" -X "$1" "http://box$2" ${3:+-H 'Content-Type: application/json' -d "$3"}; echo; }
task_via_mcp() {
  printf '%s\n%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
    "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"berth_task_new\",\"arguments\":{\"location\":\"acme\",\"name\":\"$1\",\"agent\":\"claude\",\"prompt\":\"hello from the lead agent\"}}}" \
    | "$B" mcp | tail -1
}
drivers() { "$B" sessions --json | python3 -c 'import json,sys; [print(" ", s["name"], "driver=" + s.get("driver", ""), "agent=" + s.get("agent", "")) for s in json.load(sys.stdin)]'; }

echo "state: BERTH_HOME=$BERTH_HOME TMUX_TMPDIR=$TMUX_TMPDIR HOME=$HOME (all temporary)"
"$B" version
"$B" serve --listen 127.0.0.1:17461 > "$R/berthd.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; wait $PID 2>/dev/null; tmux -L berth kill-server 2>/dev/null; echo "stopped berthd (pid $PID) and its own tmux server"' EXIT
for _ in $(seq 100); do [ -S "$SOCK" ] && break; sleep 0.1; done
echo "berthd pid $PID listening on 127.0.0.1:17461 and $SOCK"

REPO=/tmp/bdp-acme
# the repository was made beforehand: a plain git init and one commit
say berthd location add acme REPO
"$B" location add acme "$REPO" >/dev/null && echo "  added"

say 'GET /v1/info capabilities (agents.defaults?) and agent_defaults'
api GET /v1/info | python3 -c 'import json,sys; i=json.load(sys.stdin); print("  agents.defaults advertised" if "agents.defaults" in i["capabilities"] else "  NOT advertised", "| agent_defaults =", i.get("agent_defaults"))'

say 'GET /v1/agents/defaults   (nothing saved yet)'
api GET /v1/agents/defaults

say 'berth_task_new through `berthd mcp` (what another agent calls), default off'
task_via_mcp proof-off
say berthd sessions --json '(name, driver)'
drivers

say 'PUT /v1/agents/defaults {"structured":true,"mode":"bypassPermissions"}   (what the app sends with Structured agents on)'
api PUT /v1/agents/defaults '{"structured":true,"mode":"bypassPermissions"}'
say cat '$BERTH_HOME/box/agent-defaults.json'
cat "$BERTH_HOME/box/agent-defaults.json"

say 'berth_task_new through `berthd mcp`, default on'
task_via_mcp proof-on
say berthd sessions --json '(name, driver)'
drivers
ON=$("$B" sessions --json | python3 -c 'import json,sys; print([s["name"] for s in json.load(sys.stdin) if s.get("driver")=="claude"][0])')
for _ in $(seq 100); do
  api GET "/v1/sessions/$ON/transcript?since=0" | grep "echo: hello from the lead agent" >/dev/null && break; sleep 0.1
done
say "GET /v1/sessions/$ON/transcript   (its reply, through the stream)"
api GET "/v1/sessions/$ON/transcript?since=0" | python3 -c 'import json,sys; [print("  "+it["kind"]+": "+it.get("text","")) for it in json.load(sys.stdin)["items"] if it["kind"] in ("user","text")]'
say 'GET /v1/conversations   (its mode)'
api GET /v1/conversations | python3 -c 'import json,sys; [print("  session="+c.get("session","")+" agent="+c.get("agent","")+" mode="+c.get("mode","")) for c in json.load(sys.stdin)]'

say 'restart berthd on the same state, then GET /v1/agents/defaults'
kill $PID; wait $PID 2>/dev/null
"$B" serve --listen 127.0.0.1:17461 >> "$R/berthd.log" 2>&1 &
PID=$!
for _ in $(seq 100); do api GET /v1/agents/defaults >/dev/null 2>&1 && [ -S "$SOCK" ] && break; sleep 0.1; done
sleep 0.5
api GET /v1/agents/defaults

say 'PUT /v1/agents/defaults {"structured":false}, then berth_task_new again'
api PUT /v1/agents/defaults '{"structured":false}'
task_via_mcp proof-off-again
say berthd sessions --json '(name, driver)'
drivers

for s in $("$B" sessions --json | python3 -c 'import json,sys; [print(s["name"]) for s in json.load(sys.stdin)]'); do "$B" session kill "$s" >/dev/null 2>&1; done
