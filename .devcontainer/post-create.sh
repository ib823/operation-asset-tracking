#!/usr/bin/env bash
# Bring a fresh Codespace to a runnable state: deps, env, schema, demo data.
# Idempotent — safe to re-run on rebuild.
set -euo pipefail

# Belt-and-suspenders alongside the Dockerfile ENV: corepack must never block on its
# interactive "download pnpm? [Y/n]" prompt — postCreate is non-interactive and would hang.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

corepack enable
pnpm install --frozen-lockfile

if [ ! -f .env ]; then
  cp .env.example .env
  # A per-workspace token, so no two Codespaces share one and nobody is tempted to
  # commit the value from .env.example.
  TOKEN="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  sed -i "s|^OAT_API_TOKEN=.*|OAT_API_TOKEN=\"${TOKEN}\"|" .env
  echo "Wrote .env with a generated OAT_API_TOKEN (gitignored)."
fi

pnpm --filter @oat/db exec prisma generate
pnpm db:deploy
pnpm db:seed

# Playwright browser: best-effort, OS-aware. Alpine (musl) has no apt-get, so
# --with-deps fails, and Playwright's downloaded Chromium won't launch on musl.
# Use the system Chromium there. Never abort post-create over an optional browser.
if command -v apk >/dev/null 2>&1; then
  sudo apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont \
    || echo "WARN: system Chromium unavailable; in-container e2e off (CI still runs e2e)."
else
  pnpm exec playwright install --with-deps chromium \
    || echo "WARN: Playwright browser install failed; in-container e2e off (CI still runs e2e)."
fi

# Claude Code CLI — a dev-container convenience, not part of the app or its image. The
# node:22-alpine runtime does not bake it in, so a rebuild/reconnect dropped it and left
# `claude: not found`. Install it user-globally under ~/.npm-global (matched by the
# remoteEnv PATH in devcontainer.json). Idempotent: skip when already on PATH; never fatal —
# a slow or blocked npm registry must not break Codespace creation.
export PATH="$HOME/.npm-global/bin:$PATH"
if command -v claude >/dev/null 2>&1; then
  echo "Claude Code CLI already present ($(command -v claude))."
else
  echo "Installing Claude Code CLI (user-global under ~/.npm-global)…"
  npm install -g --prefix "$HOME/.npm-global" @anthropic-ai/claude-code \
    || echo "WARN: Claude Code CLI install failed; run 'npm install -g --prefix ~/.npm-global @anthropic-ai/claude-code' by hand."
fi

# GitHub CLI (gh) — dev-container convenience so PRs open from the terminal (`gh pr create`),
# closing the "no gh after rebuild" gap. This Alpine image gives the node user no root
# (no sudo, so apk is out), so install rootless: drop the official static binary into
# ~/.npm-global/bin, already on PATH via the remoteEnv in devcontainer.json. Idempotent;
# non-fatal — a missing gh just means opening PRs in the browser, never a broken Codespace.
# Authenticate once per Codespace with `gh auth login` (or export GH_TOKEN).
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
  mkdir -p "$HOME/.npm-global/bin"
  cp "${tmp}/gh_${v}_linux_${arch}/bin/gh" "$HOME/.npm-global/bin/gh" || { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
  echo "Installed $("$HOME/.npm-global/bin/gh" --version | head -1)."
}
if command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI already present ($(command -v gh))."
else
  echo "Installing GitHub CLI (rootless, static binary under ~/.npm-global)…"
  install_gh || echo "WARN: GitHub CLI install failed; open PRs via the GitHub web UI instead."
fi

cat <<'BANNER'

  Lablink OAT is ready.

    pnpm dev        app on http://localhost:3000
    pnpm test       unit tests
    pnpm e2e        end-to-end tests
    pnpm licences   licence gate

  Read CLAUDE.md and PROGRESS.md first.

BANNER
