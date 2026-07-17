-- CreateEnum
CREATE TYPE "ReconciliationReason" AS ENUM ('NO_MATCH', 'UNKNOWN_COST_CENTRE', 'CONFLICTING_LINK');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ConflictStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('FINANCE', 'PURCHASING', 'BRANCH', 'HQ_LAB_MANAGER', 'IT', 'DEVELOPER');

-- AlterTable
ALTER TABLE "asset" ADD COLUMN     "scanAssertedAt" TIMESTAMP(3),
ADD COLUMN     "scanAssertedStatus" "AssetStatus";

-- CreateTable
CREATE TABLE "reconciliation_item" (
    "id" TEXT NOT NULL,
    "sapAssetNo" TEXT NOT NULL,
    "sapRecord" JSONB NOT NULL,
    "reason" "ReconciliationReason" NOT NULL,
    "status" "ReconciliationStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedAssetId" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "note" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reconciliation_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conflict_alert" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "scanStatus" "AssetStatus" NOT NULL,
    "telemetryStatus" "AssetStatus" NOT NULL,
    "scanAssertedAt" TIMESTAMP(3) NOT NULL,
    "sustainedMinutes" INTEGER NOT NULL,
    "status" "ConflictStatus" NOT NULL DEFAULT 'OPEN',
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "conflict_alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT,
    "externalId" TEXT,
    "roles" "Role"[],
    "siteId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_item_sapAssetNo_key" ON "reconciliation_item"("sapAssetNo");

-- CreateIndex
CREATE INDEX "reconciliation_item_status_firstSeenAt_idx" ON "reconciliation_item"("status", "firstSeenAt");

-- CreateIndex
CREATE INDEX "conflict_alert_status_detectedAt_idx" ON "conflict_alert"("status", "detectedAt");

-- CreateIndex
CREATE INDEX "conflict_alert_assetId_status_idx" ON "conflict_alert"("assetId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_externalId_key" ON "user"("externalId");

-- CreateIndex
CREATE INDEX "user_email_idx" ON "user"("email");

-- AddForeignKey
ALTER TABLE "conflict_alert" ADD CONSTRAINT "conflict_alert_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
