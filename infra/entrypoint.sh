#!/bin/sh
# Apply migrations, then start the app.
#
# `migrate deploy` only applies already-generated migrations and never prompts or drops
# data, which is what makes it safe to run unattended on every container start. It is
# idempotent, so a replica restarting is a no-op.
set -eu

echo "Applying database migrations..."
pnpm --filter @oat/db exec prisma migrate deploy

if [ "${OAT_SEED_ON_START:-0}" = "1" ]; then
  # Off by default. Demo convenience only — a production container must never
  # invent asset data on boot.
  echo "Seeding demo data (OAT_SEED_ON_START=1)..."
  pnpm --filter @oat/db seed
fi

echo "Starting OAT..."
exec pnpm --filter @oat/app start
