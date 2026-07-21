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

# ---- Build ------------------------------------------------------------------------
# Assemble the installed node_modules (from deps) with the workspace SOURCE. pnpm's workspace
# layout keeps each package's bin/deps under `packages/<pkg>/node_modules` (symlinks into the
# root `.pnpm` store), so both the deps-stage node_modules AND the source must be present, or
# `tsx` (a per-package bin) is missing at runtime.
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY . .

# ---- Runtime ----------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production

# tini as PID 1 so the collector forwards SIGTERM (a compose `down` should stop it promptly,
# not wait out the kill timeout).
RUN apk add --no-cache tini

# Only what the collector runs: node_modules (incl. per-package .bin/tsx) + the workspace
# source + the manifests pnpm needs to resolve the workspace. No app/, no e2e/, no Prisma
# client (the collector imports @oat/db only as TYPES, erased at runtime — it loads no DB).
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=build --chown=node:node /app/pnpm-workspace.yaml ./pnpm-workspace.yaml

# Non-root: the collector needs no privileged ports (it dials out) and no filesystem writes.
USER node

ENTRYPOINT ["/sbin/tini", "--", "pnpm", "--filter", "@oat/collector", "start"]
