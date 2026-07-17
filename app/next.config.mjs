/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The workspace packages ship TypeScript source rather than a build step. Next compiles
  // them itself, which keeps the monorepo free of a watch-and-rebuild cycle in dev.
  transpilePackages: ['@oat/core', '@oat/db', '@oat/sap', '@oat/connectors', '@oat/auth'],
  outputFileTracingRoot: new URL('..', import.meta.url).pathname,
  // Prisma's engine is a native binary; Next must not try to bundle it into the server build.
  serverExternalPackages: ['@prisma/client', '.prisma/client'],
  images: {
    // `sharp` is excluded from the install: its libvips binary is LGPL (ADR-0007). The OAT
    // has no images to optimise, so turn the optimiser off rather than ship copyleft.
    unoptimized: true,
  },
}

export default nextConfig
