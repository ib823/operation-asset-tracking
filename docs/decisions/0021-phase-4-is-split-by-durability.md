# 21. Phase 4 is split by durability: final logic, provisional presentation

Date: 2026-07-17
Status: Accepted

## Context

Phase 4 contains two kinds of work with very different lifespans.

Some of it is **durable**: the disclosure test, worker health, the SIEM export, the hardening
pass, the handover docs. Nobody will restyle a security header. These are load-bearing and
should be built to the standard of everything before them.

The rest — the 32-site heatmap, the location-history view, the alerting UI — will be
**restyled by a shared design system** that does not exist yet. Any visual decision made now
is a decision someone will undo.

Polishing markup that is scheduled for replacement is waste. But there is a worse failure in
the other direction, and it is the one this ADR exists to prevent: **plain markup reads as
unfinished work.** A future session — quite plausibly one of mine, months from now, holding a
summarised context — opens an unstyled heatmap, concludes it was abandoned mid-build, and
rewrites the aggregation logic underneath it. The logic was finished. The CSS was not. Those
are not the same thing, and nothing in the code says which.

## Decision

Phase 4 work is explicitly labelled by durability.

**Built fully** — final, held to the usual standard:

- The route/page disclosure test
- Scheduler last-run surfacing and the worker-health indicator
- The SIEM/audit export
- The security-hardening pass
- Handover docs, SBOM, AMS runbook

**Functional-not-final** — logic final, presentation provisional:

- The 32-site utilisation heatmap
- The location-history view
- The alerting UI

For the second group:

1. **The data and the logic are final.** Scoping, aggregation, the honest handling of
   "not measured" (ADR-0015), and correctness generally get the same rigour as everything
   else. They are not scheduled for replacement; only the markup is.
2. **The presentation is deliberately plain.** Semantic HTML, existing primitives, no bespoke
   visual work. No new colour scales, no animation, no layout invention.
3. **Every such file says so at the top**, naming this ADR. That is the whole point: the next
   reader must be able to tell "plain on purpose, logic reviewed" from "abandoned halfway".
4. **They are tested like everything else.** Tests assert behaviour and disclosure, not
   appearance — which is exactly what survives a restyle. A test asserting a hex colour would
   be deleted by the design system; a test asserting a branch user sees one site would not.

## Consequences

- The design system can restyle these three views without touching logic, and without needing
  to re-derive what the logic was supposed to do.
- A future session cannot mistake provisional styling for missing functionality — the file
  says which, and the tests pin the behaviour.
- Cost: three views look unfinished to a client demo. Worth naming explicitly at the phase
  gate rather than discovering in a meeting. The alternative — styling them twice — is worse.
- The line is "presentation vs logic", not "important vs unimportant". The heatmap's
  aggregation is as consequential as anything in Phase 2: it is the estate-wide utilisation
  picture, and it is the view most likely to be screenshotted into a disposal decision.
