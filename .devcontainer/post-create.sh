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

cat <<'BANNER'

  Lablink OAT is ready.

    pnpm dev        app on http://localhost:3000
    pnpm test       unit tests
    pnpm e2e        end-to-end tests
    pnpm licences   licence gate

  Read CLAUDE.md and PROGRESS.md first.

BANNER
