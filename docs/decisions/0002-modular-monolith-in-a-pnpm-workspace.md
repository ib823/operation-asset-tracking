# 2. Modular monolith in a pnpm workspace

Date: 2026-07-16
Status: Accepted

## Context

The OAT is an optional module serving 32 sites and a modest asset population (order of
thousands, not millions). It must be deployable by a client IT team without a platform
engineering group, and handed over as maintainable source.

The domain does have genuine seams: the SAP boundary, the connector adapters, the domain
core, and the UI. Those seams carry real architectural meaning — particularly the SAP
boundary, which the brief calls sacred — so they must be visible and enforceable, not
merely conventional.

Options considered:

1. **Single Next.js app, folders only.** Simplest, but the SAP boundary would be a naming
   convention. Nothing stops a UI file importing an SAP write client and pushing telemetry.
2. **Microservices.** Enforces boundaries via the network, at the cost of deployment
   complexity far beyond this system's scale and the client's operating capability.
3. **Modular monolith in a workspace.** One deployable, but boundaries are package
   boundaries: enforced by the module graph and by TypeScript at compile time.

## Decision

A modular monolith in a pnpm workspace, matching the layout in `CLAUDE.md`. One deployable
artifact (`app`), with the domain split into packages that depend on each other only in one
direction:

```
app ──▶ core ──▶ db
 │       ▲  ▲
 ├──▶ sap ┘  └── connectors
 └──▶ auth
```

Rules: `core` never imports `sap` or `connectors`; `sap` and `connectors` depend on `core`
for types. Signals enter through `connectors`; SAP crosses only through `sap`.

pnpm over npm/yarn workspaces: strict `node_modules` layout means an undeclared dependency
fails at build time rather than resolving by accident — the same "enforced by construction"
property we want for the boundary. pnpm is MIT.

## Consequences

- The SAP boundary is checkable mechanically (dependency direction), not by review alone.
- Any package can later be extracted into its own service without rewriting call sites,
  should a connector need independent deployment.
- Cost: workspace tooling and TS project references add setup overhead, and contributors
  must know pnpm.
- Single deploy unit keeps `docker-compose up` a two-container story (app + postgres).
