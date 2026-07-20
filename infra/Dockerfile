# Multi-stage build for the OAT app.
#
# Alpine + Node 22 LTS. Multi-stage so the runtime image carries the built app and
# production dependencies only — no source, no toolchain, no dev dependencies. Smaller
# image, and a smaller attack surface to deploy into the Malaysia region (§8).

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# ---- Dependencies -----------------------------------------------------------------
# Manifests only, so this layer caches on the lockfile rather than on every source edit.
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
RUN pnpm install --frozen-lockfile

# ---- Build ------------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/app/node_modules ./app/node_modules
COPY --from=deps /app/packages ./packages
COPY . .
RUN pnpm --filter @oat/db exec prisma generate
RUN pnpm --filter @oat/app build

# ---- Runtime ----------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# corepack's first `pnpm` invocation prompts "[Y/n]" to download the pinned pnpm. The
# devcontainer's non-interactive postCreate hangs on that prompt forever. Bake the opt-out
# in so it holds for the image build, postCreate, terminals, and CCC alike.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# Run as a non-root user. `node` already exists in the base image.
RUN apk add --no-cache tini git bash

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/app ./app
COPY --from=build --chown=node:node /app/infra/entrypoint.sh ./entrypoint.sh

USER node
EXPOSE 3000

# tini as PID 1 so the container forwards signals and reaps zombies — without it, Next
# ignores SIGTERM and every deploy waits out the full kill timeout.
ENTRYPOINT ["/sbin/tini", "--", "/app/entrypoint.sh"]
