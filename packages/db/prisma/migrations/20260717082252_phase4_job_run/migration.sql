-- CreateTable
CREATE TABLE "job_run" (
    "queue" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "detail" TEXT,

    CONSTRAINT "job_run_pkey" PRIMARY KEY ("queue")
);
