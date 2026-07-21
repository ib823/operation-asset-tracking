/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The workspace packages ship TypeScript source rather than a build step. Next compiles
  // them itself, which keeps the monorepo free of a watch-and-rebuild cycle in dev.
  transpilePackages: ['@oat/core', '@oat/db', '@oat/sap', '@oat/connectors', '@oat/auth', '@oat/jobs'],
  outputFileTracingRoot: new URL('..', import.meta.url).pathname,
  // Force the Prisma query engine (a native .node binary loaded at RUNTIME) into the
  // serverless function trace. `serverExternalPackages` stops Next bundling Prisma, but the
  // engine is dlopen'd via a dynamic path, so static tracing does not follow it — on Vercel
  // that surfaces as `PrismaClientInitializationError: could not locate the Query Engine for
  // runtime "rhel-openssl-3.0.x"`. Globs are relative to this file's dir (app/); the engine
  // lives in the workspace-root pnpm store. See https://pris.ly/d/engine-not-found-nextjs.
  outputFileTracingIncludes: {
    '/**': [
      '../node_modules/.pnpm/@prisma+client*/node_modules/.prisma/client/*.node',
      '../node_modules/.pnpm/@prisma+client*/node_modules/.prisma/client/schema.prisma',
    ],
  },
  // Prisma's engine is a native binary; Next must not try to bundle it into the server build.
  //   @prisma/client  — ships a native engine binary
  //   net-snmp        — requires Node's `dgram`/`net`, which have no bundler equivalent
  serverExternalPackages: ['@prisma/client', '.prisma/client', 'net-snmp'],
  experimental: {
    /**
     * Hosts allowed to invoke Server Actions.
     *
     * Next compares the browser's `origin` against `x-forwarded-host` and aborts the action
     * if they differ — CSRF protection that is correct, and that every reverse proxy trips.
     * Without this, EVERY form in the app (sign-in, sign-out, idle policy, reconciliation,
     * alerts) fails behind a proxy with "Invalid Server Actions request", including the
     * Malaysia-region deploy behind its load balancer (A5).
     *
     * Config, not a constant: the external host differs per environment and is not knowable
     * at build time. Empty by default, which is correct for a direct localhost hit.
     */
    serverActions: {
      allowedOrigins: (process.env.OAT_ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    },
  },
  images: {
    // `sharp` is excluded from the install: its libvips binary is LGPL (ADR-0007). The OAT
    // has no images to optimise, so turn the optimiser off rather than ship copyleft.
    unoptimized: true,
  },
}

export default nextConfig
