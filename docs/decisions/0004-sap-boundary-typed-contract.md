# 4. Encode the SAP boundary as a typed contract

Date: 2026-07-16
Status: Accepted

## Context

The brief calls the SAP boundary sacred, and it is the commercial heart of this module:
the OAT is sellable _because_ it does not touch SAP's role as financial system of record.
Three rules must hold for the life of the system:

1. SAP → OAT is a one-way master sync.
2. OAT → SAP carries **only** accounting-relevant events (`DISPOSAL_PROPOSED`,
   `IMPAIRMENT_FLAG`, `LOCATION_CHANGED`), via released APIs, behind approval.
3. Telemetry (heartbeat, idle, utilisation, location pings) **never** reaches SAP.

Rule 3 is the one that will be violated by accident. Some future session — quite plausibly
one of mine, months from now, holding a summarised context — will be asked for "richer SAP
reporting" and will reach for the nearest write client with a `SignalEvent` in hand. A
comment saying "don't do this" will not stop that. Code review might, once, if the reviewer
remembers why the rule exists.

The brief's own instruction is the answer: make violations _impossible by construction_.

## Decision

`packages/sap` exposes no general-purpose write surface. Its outbound port accepts a
closed, discriminated union — `SapOutboundEvent` — of exactly the three permitted event
types, each with an explicit payload type carrying only accounting-relevant fields.
There is no `sendRaw`, no `post(path, body)`, no generic escape hatch exported from the
package boundary.

Consequently:

- A `SignalEvent` is **not assignable** to any outbound payload type. Pushing telemetry to
  SAP is not a policy breach to be caught in review; it is a type error at compile time.
- The HTTP/OData client is package-private. Only the port sees it.
- Every outbound event carries an approval reference; the port rejects unapproved events at
  runtime as a second line of defence (types do not survive `any` or a JSON boundary).
- Inbound sync is a separate port with no write capability, so "sync" cannot grow a
  write path by accretion.

The typed shape is the contract; a mock and the real OData client are two implementations
of it, which is also what makes the real endpoint a config swap (see A2 in `PROGRESS.md`).

## Consequences

- The boundary survives contributor turnover and lossy context, because the compiler
  enforces it rather than the reader's memory.
- Adding a legitimately new accounting-relevant event type is a deliberate act: extend the
  union, write an ADR, get approval. That friction is the point.
- Cost: more ceremony than "just call the API". Accepted — this is the one rule where
  ceremony is worth more than convenience.
- Runtime approval checks duplicate what types express. Kept anyway: types are erased at
  runtime and the write-back path may one day be driven by a queue payload.
