#!/usr/bin/env bash
# Sets up WSL (Ubuntu) so Shipyard on Windows can run agents on this PC.
#
# Shipyard's box, berthd, runs agents inside tmux, which Windows has only in
# WSL. The app copies berthd in and starts it itself; this script installs
# what berthd and the agents need around it:
#
#   tmux, git, curl and build tools   (apt, needs your password once)
#   Node.js LTS                       (nvm, in your home folder)
#   Claude Code, Codex, Gemini CLI,   (npm, in your home folder)
#   OpenCode
#   glab, the GitLab CLI              (apt, when your Ubuntu has it)
#
# Run it inside Ubuntu, from the Shipyard folder:
#
#   bash scripts/setup-wsl.sh
#
# Running it again updates what it installed and skips the rest. It never
# signs in anywhere: it prints the logins to do yourself at the end.
set -euo pipefail

NODE_MAJOR=22
NVM_VERSION=v0.40.3
AGENTS=(@anthropic-ai/claude-code @openai/codex @google/gemini-cli opencode-ai)

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }

if ! grep -qi microsoft /proc/version 2>/dev/null; then
  warn "this doesn't look like WSL; it sets up any Ubuntu, but Shipyard on Windows only uses WSL's"
fi
if ! command -v apt-get >/dev/null; then
  echo "This script is for Ubuntu or Debian (apt). Install tmux, git, Node.js and the agent CLIs yourself." >&2
  exit 1
fi

say "Installing tmux, git and build tools"
sudo apt-get update -y
sudo apt-get install -y tmux git curl ca-certificates build-essential unzip jq

if ! command -v glab >/dev/null; then
  say "Installing glab, the GitLab CLI"
  sudo apt-get install -y glab || warn "glab isn't in this Ubuntu's packages; see https://gitlab.com/gitlab-org/cli#installation"
fi

say "Installing Node.js $NODE_MAJOR with nvm"
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | bash
fi
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install "$NODE_MAJOR"
nvm alias default "$NODE_MAJOR"
nvm use default >/dev/null

say "Installing the agent CLIs: ${AGENTS[*]}"
# berthd finds them through your login shell, which loads nvm from ~/.bashrc
# (internal/agentpath), ahead of any Windows install on WSL's PATH.
npm install -g "${AGENTS[@]}"

say "Checking"
missing=0
for tool in tmux git node claude codex gemini opencode; do
  if command -v "$tool" >/dev/null; then
    printf '  %-9s %s\n' "$tool" "$(command -v "$tool")"
  else
    printf '  %-9s MISSING\n' "$tool"
    missing=1
  fi
done
command -v glab >/dev/null && printf '  %-9s %s\n' glab "$(command -v glab)"

cat <<'EOF'

Done. Sign in to the agents you use, once each, here in Ubuntu:

  claude                 Claude Code (your Claude plan or an API key)
  codex login            Codex (your ChatGPT plan or an API key)
  gemini                 Gemini CLI (a Google account)
  opencode auth login    OpenCode
  glab auth login        GitLab (gitlab.com or your own instance)

Then, in Shipyard on Windows, choose "Use this computer" (or "Check again").

Tip: git and agents are much faster on projects inside Ubuntu (~/code/...)
than on Windows drives (/mnt/e/...). Both work.
EOF
exit "$missing"
