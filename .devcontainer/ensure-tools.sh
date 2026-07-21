#!/usr/bin/env bash
# Ensure the dev-container convenience CLIs (Claude Code, GitHub CLI) are installed and on
# PATH for EVERY shell — bash, ash/sh, SSH — regardless of how the container was started.
#
# Why this exists as its own script, run from postStartCommand rather than only from
# postCreateCommand: see docs/decisions/0025-devcontainer-tools-persist-via-poststart.md.
# In short — postCreateCommand runs on create/rebuild ONLY, never on a Stop→Start resume, so
# the CLIs (installed into the node:22-alpine runtime, which does not bake them in) vanished
# on reconnect; and the remoteEnv PATH in devcontainer.json only reaches the VS Code terminal,
# not a plain `/bin/sh -l` or `gh cs ssh` shell. This script fixes both: it self-heals on every
# start, and it writes PATH into the shell profiles so any login shell resolves the CLIs.
#
# No `set -e`: every step is best-effort and MUST NOT abort container start. A slow or blocked
# npm registry, or a GitHub outage, must never leave the Codespace stuck. Idempotent throughout.
set -uo pipefail

NPM_GLOBAL="$HOME/.npm-global"
export PATH="$NPM_GLOBAL/bin:$PATH"

# --- PATH persistence for non-VS-Code shells --------------------------------------------------
# remoteEnv in devcontainer.json only reaches VS Code-spawned terminals. A `/bin/sh -l` login
# shell or `gh cs ssh` reads ~/.profile (POSIX sh / ash) or ~/.bashrc (bash). Write the export
# into both, once each — grep guards make re-runs on every postStart a no-op.
PATH_LINE='export PATH="$HOME/.npm-global/bin:$PATH"'
for rc in "$HOME/.profile" "$HOME/.bashrc"; do
  # Guard on the exact line we write. Grepping the expanded path ($NPM_GLOBAL/bin) would NOT
  # match the literal `$HOME/.npm-global/bin` we append, so it would duplicate on every run.
  if [ -f "$rc" ] && grep -qF "$PATH_LINE" "$rc" 2>/dev/null; then
    continue
  fi
  printf '\n# Lablink OAT dev-container CLIs (Claude Code, gh) — added by ensure-tools.sh\n%s\n' \
    "$PATH_LINE" >> "$rc" \
    && echo "Added ~/.npm-global/bin to PATH in ${rc}."
done

# --- Claude Code CLI --------------------------------------------------------------------------
# A dev-container convenience, not part of the app or its image. The node:22-alpine runtime does
# not bake it in, so a rebuild/reconnect dropped it and left `claude: not found`. Install it
# user-globally under ~/.npm-global. Idempotent: skip when already resolvable; never fatal —
# a slow or blocked npm registry must not break Codespace start.
if command -v claude >/dev/null 2>&1; then
  echo "Claude Code CLI already present ($(command -v claude))."
else
  echo "Installing Claude Code CLI (user-global under ~/.npm-global)…"
  npm install -g --prefix "$NPM_GLOBAL" @anthropic-ai/claude-code \
    || echo "WARN: Claude Code CLI install failed; run 'npm install -g --prefix ~/.npm-global @anthropic-ai/claude-code' by hand."
fi

# --- GitHub CLI (gh) --------------------------------------------------------------------------
# Dev-container convenience so PRs open from the terminal (`gh pr create`). This Alpine image
# gives the node user no root (no sudo, so apk is out), so install rootless: drop the official
# static binary into ~/.npm-global/bin, already on PATH. Idempotent; non-fatal — a missing gh
# just means opening PRs in the browser, never a broken Codespace. Authenticate once per
# Codespace with `gh auth login` (or export GH_TOKEN).
install_gh() {
  local ver arch tmp v
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) echo "WARN: unsupported arch $(uname -m); skipping gh"; return 1 ;;
  esac
  ver="$(node -e "fetch('https://api.github.com/repos/cli/cli/releases/latest').then(r=>r.json()).then(j=>process.stdout.write(j.tag_name||''))" 2>/dev/null)" || return 1
  [ -n "$ver" ] || return 1
  v="${ver#v}"
  tmp="$(mktemp -d)"
  node -e "const fs=require('fs');fetch('https://github.com/cli/cli/releases/download/${ver}/gh_${v}_linux_${arch}.tar.gz').then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.arrayBuffer()}).then(b=>fs.writeFileSync('${tmp}/gh.tgz',Buffer.from(b)))" || { rm -rf "$tmp"; return 1; }
  tar xzf "${tmp}/gh.tgz" -C "$tmp" || { rm -rf "$tmp"; return 1; }
  mkdir -p "$NPM_GLOBAL/bin"
  cp "${tmp}/gh_${v}_linux_${arch}/bin/gh" "$NPM_GLOBAL/bin/gh" || { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
  echo "Installed $("$NPM_GLOBAL/bin/gh" --version | head -1)."
}
if command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI already present ($(command -v gh))."
else
  echo "Installing GitHub CLI (rootless, static binary under ~/.npm-global)…"
  install_gh || echo "WARN: GitHub CLI install failed; open PRs via the GitHub web UI instead."
fi
