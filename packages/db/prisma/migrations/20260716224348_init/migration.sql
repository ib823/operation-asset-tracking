-- CreateEnum
CREATE TYPE "AssetClass" AS ENUM ('LAB_INSTRUMENT', 'IT', 'PRINTER', 'SCANNER', 'REUSABLE_COMPONENT', 'OTHER');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('IN_USE', 'IDLE', 'UNDER_REPAIR', 'RETIRED');

-- CreateTable
CREATE TABLE "site" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset" (
    "id" TEXT NOT NULL,
    "sapAssetNo" TEXT,
    "tag" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "class" "AssetClass" NOT NULL,
    "status" "AssetStatus" NOT NULL DEFAULT 'IN_USE',
    "siteId" TEXT NOT NULL,
    "location" TEXT,
    "custodianId" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "lastActiveAt" TIMESTAMP(3),
    "idleSince" TIMESTAMP(3),
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signal_event" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dedupeKey" TEXT,

    CONSTRAINT "signal_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "utilisation_snapshot" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "idleMinutes" INTEGER NOT NULL,
    "busyMinutes" INTEGER NOT NULL,
    "utilisationPct" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "utilisation_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_history" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "from" TEXT,
    "to" TEXT NOT NULL,
    "movedAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,

    CONSTRAINT "location_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "site_code_key" ON "site"("code");

-- CreateIndex
CREATE UNIQUE INDEX "asset_sapAssetNo_key" ON "asset"("sapAssetNo");

-- CreateIndex
CREATE UNIQUE INDEX "asset_tag_key" ON "asset"("tag");

-- CreateIndex
CREATE INDEX "asset_siteId_status_idx" ON "asset"("siteId", "status");

-- CreateIndex
CREATE INDEX "asset_status_idleSince_idx" ON "asset"("status", "idleSince");

-- CreateIndex
CREATE INDEX "signal_event_assetId_observedAt_idx" ON "signal_event"("assetId", "observedAt");

-- CreateIndex
CREATE INDEX "signal_event_ingestedAt_idx" ON "signal_event"("ingestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "signal_event_source_dedupeKey_key" ON "signal_event"("source", "dedupeKey");

-- CreateIndex
CREATE INDEX "utilisation_snapshot_periodStart_idx" ON "utilisation_snapshot"("periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "utilisation_snapshot_assetId_periodStart_periodEnd_key" ON "utilisation_snapshot"("assetId", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "location_history_assetId_movedAt_idx" ON "location_history"("assetId", "movedAt");

-- CreateIndex
CREATE INDEX "audit_log_entity_entityId_at_idx" ON "audit_log"("entity", "entityId", "at");

-- CreateIndex
CREATE INDEX "audit_log_at_idx" ON "audit_log"("at");

-- AddForeignKey
ALTER TABLE "asset" ADD CONSTRAINT "asset_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_event" ADD CONSTRAINT "signal_event_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "utilisation_snapshot" ADD CONSTRAINT "utilisation_snapshot_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_history" ADD CONSTRAINT "location_history_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
