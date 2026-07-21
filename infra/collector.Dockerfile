# Multi-stage build for the on-LAN Collector (ADR-0021).
#
# Alpine + Node 22 LTS, consistent with infra/Dockerfile. Deliberately LEANER than the app
# image: the collector runs no web server and — by design — holds NO database connection, so
# there is no `next build` and no `prisma generate` here. It reaches the outside world exactly
# once, outbound, to push signals to OAT.
#
# Licence-clean: the collector adds no runtime dependency beyond net-snmp (MIT), zod (MIT) and
# Node built-ins (see docs/refs/REFERENCES.md). Build context is the repo root.

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# corepack's first `pnpm` prompts to download the pinned pnpm; the opt-out keeps a
# non-interactive build from hanging on that prompt (same rationale as infra/Dockerfile).
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# ---- Dependencies -----------------------------------------------------------------
# Manifests only, so this layer caches on the lockfile. Every workspace package.json must be
# present for pnpm to resolve the workspace, even the ones the collector does not run.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY app/package.json ./app/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/sap/package.json ./packages/sap/
COPY packages/connectors/package.json ./packages/connectors/
COPY packages/auth/package.json ./packages/auth/
COPY packages/seed/package.json ./packages/seed/
COPY packages/jobs/package.json ./packages/jobs/
COPY packages/collector/package.json ./packages/collector/
RUN pnpm install --frozen-lockfile

# ---- Runtime ----------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production

# tini as PID 1 so the collector forwards SIGTERM (a compose `down` should stop it promptly,
# not wait out the kill timeout).
RUN apk add --no-cache tini

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# The collector runs from TypeScript source via tsx. It imports @oat/connectors and @oat/core;
# those import @oat/db only as TYPES (erased at runtime), so no Prisma client is ever loaded —
# but the workspace packages must be present for pnpm to resolve them.
COPY --chown=node:node packages ./packages

# Non-root: the collector needs no privileged ports (it dials out) and no filesystem writes.
USER node

ENTRYPOINT ["/sbin/tini", "--", "pnpm", "--filter", "@oat/collector", "start"]
