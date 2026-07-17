/*
  Warnings:

  - Added the required column `observedMinutes` to the `utilisation_snapshot` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "IdleScope" AS ENUM ('CLASS', 'SUB_TYPE', 'ASSET');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- AlterTable
ALTER TABLE "asset" ADD COLUMN     "subType" TEXT;

-- AlterTable
ALTER TABLE "site" ADD COLUMN     "scanTtlMinutes" INTEGER;

-- AlterTable
ALTER TABLE "utilisation_snapshot" ADD COLUMN     "observedMinutes" INTEGER NOT NULL;

-- CreateTable
CREATE TABLE "idle_config" (
    "id" TEXT NOT NULL,
    "scope" "IdleScope" NOT NULL,
    "key" TEXT NOT NULL,
    "thresholdMinutes" INTEGER NOT NULL,
    "alertAfterMinutes" INTEGER,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idle_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idle_alert" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "idleSince" TIMESTAMP(3) NOT NULL,
    "idleMinutes" INTEGER NOT NULL,
    "thresholdMinutes" INTEGER NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'OPEN',
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "acknowledgedBy" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "idle_alert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "idle_config_scope_key_key" ON "idle_config"("scope", "key");

-- CreateIndex
CREATE INDEX "idle_alert_status_detectedAt_idx" ON "idle_alert"("status", "detectedAt");

-- CreateIndex
CREATE INDEX "idle_alert_assetId_status_idx" ON "idle_alert"("assetId", "status");

-- CreateIndex
CREATE INDEX "asset_class_subType_idx" ON "asset"("class", "subType");

-- AddForeignKey
ALTER TABLE "idle_alert" ADD CONSTRAINT "idle_alert_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
