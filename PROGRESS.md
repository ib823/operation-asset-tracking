# PROGRESS — Lablink OAT

Living log. Update after every milestone. Read with `CLAUDE.md` at session start.

## Current phase

**Phase 0 — PoC (in progress).**

## Task list

### Bootstrap

- [x] `CLAUDE.md` standing brief
- [x] `PROGRESS.md` living log
- [x] `docs/decisions/` + initial ADRs
- [x] Task list (this section)

### Phase 0 — PoC

- [ ] pnpm monorepo + TypeScript project references
- [ ] `packages/db`: Prisma schema (Asset, Site, SignalEvent), migration, seed 3 sites + 10 assets
- [ ] `packages/core`: domain types + idle engine
- [ ] `packages/sap`: typed boundary contract + mock OData client + master sync
- [ ] `packages/connectors`: `scan` adapter + mock `soti` adapter
- [ ] `app`: asset list, asset detail with status badge, dashboard tile (idle vs in-use by site)
- [ ] REST API + OpenAPI document
- [ ] Vitest unit/integration tests
- [ ] Playwright e2e proving the end-to-end flow
- [ ] `infra/`: docker-compose (app + postgres), devcontainer, `.env.example`
- [ ] CI: lint, typecheck, test, licence gate, build
- [ ] Self-verify against Phase 0 acceptance criteria; record results below

### Phases 1–4

Not started. Do not scaffold early — see `CLAUDE.md` phase plan.

## Done

- Bootstrap docs and ADRs 0001–0006.

## Next

1. Scaffold the pnpm workspace and shared TS config.
2. Prisma schema + migration + seed.
3. Core idle engine with tests.

## Assumptions to confirm

| #   | Assumption                                                                                                                                  | Made because                                 | How it's isolated                                                                       | Confirm with           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------- |
| A1  | Idle thresholds default to: LAB_INSTRUMENT 120 min, IT 30 min, PRINTER 240 min, SCANNER 240 min, REUSABLE_COMPONENT 480 min, OTHER 120 min. | Client has not defined "idle" per class yet. | Config-driven (`packages/core` idle policy), overridable per class without code change. | Lablink HQ Lab Manager |
| A2  | SAP asset master is exposed via a released OData v2/v4 service; field names in the mock client are placeholders.                            | No tenant/endpoint provided.                 | Typed client + mock; the real endpoint is a config swap.                                | Lablink SAP team       |
| A3  | 32 sites; Phase 0 seeds 3 representative ones.                                                                                              | Real site list not supplied.                 | Seed data only; `Site` is a first-class table.                                          | Lablink ops            |
| A4  | Asset tags are barcode/QR encoding `tag` directly (no check digit scheme).                                                                  | No tagging standard supplied.                | Scan connector normalises via a single parse function.                                  | Lablink ops            |
| A5  | Data residency: deploy to a Malaysia region. Not yet chosen (AWS ap-southeast-5 / Azure Malaysia West).                                     | No hosting decision yet.                     | Docker-based; region is a deploy-time choice.                                           | ABeam + Lablink IT     |
| A6  | Single tenant, single timezone (Asia/Kuala_Lumpur) for utilisation rollups.                                                                 | Reasonable for one Malaysian entity.         | Timezone is config.                                                                     | Lablink ops            |

## How to resume

```bash
pnpm install
docker compose -f infra/docker-compose.yml up -d postgres
pnpm --filter @oat/db exec prisma migrate deploy
pnpm --filter @oat/db seed
pnpm dev                 # app on http://localhost:3000
pnpm test                # vitest
pnpm e2e                 # playwright
```

Then: read `CLAUDE.md` → this file → continue at **Next**.

## Verification results

Not yet run — Phase 0 in progress.
