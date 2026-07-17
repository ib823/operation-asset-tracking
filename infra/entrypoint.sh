#!/bin/sh
# Apply migrations, then run the requested process.
#
# `migrate deploy` only applies already-generated migrations and never prompts or drops data,
# which is what makes it safe to run unattended on every container start. It is idempotent, so
# a replica restarting is a no-op.
set -eu

# The worker shares this image and this entrypoint but must NOT migrate or seed: two
# containers racing `migrate deploy` at boot is a needless lock fight, and the app already
# owns the schema. It waits for the app instead (see docker-compose).
if [ "${OAT_SKIP_MIGRATIONS:-0}" != "1" ]; then
  echo "Applying database migrations..."
  pnpm --filter @oat/db exec prisma migrate deploy

  if [ "${OAT_SEED_ON_START:-0}" = "1" ]; then
    # Off by default. Demo convenience only — a production container must never invent asset
    # data on boot.
    echo "Seeding demo data (OAT_SEED_ON_START=1)..."
    pnpm --filter @oat/seed seed
  fi
fi

# Run whatever was asked for; default to serving the app. Without this the image can only
# ever be the web server, and the scheduler needs the same image with a different command.
if [ "$#" -gt 0 ]; then
  echo "Starting: $*"
  exec "$@"
fi

echo "Starting OAT..."
exec pnpm --filter @oat/app start
