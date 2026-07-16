#!/usr/bin/env bash
# Bring a fresh Codespace to a runnable state: deps, env, schema, demo data.
# Idempotent — safe to re-run on rebuild.
set -euo pipefail

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

pnpm exec playwright install --with-deps chromium

cat <<'BANNER'

  Lablink OAT is ready.

    pnpm dev        app on http://localhost:3000
    pnpm test       unit tests
    pnpm e2e        end-to-end tests
    pnpm licences   licence gate

  Read CLAUDE.md and PROGRESS.md first.

BANNER
