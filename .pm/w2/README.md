# w2 — project workstream (worker1)

**Worker:** worker1. This is a general-purpose muse-code-acp workstream. Placement records scheduling and history, not permanent ownership or a component boundary.

## Milestones

- [x] **m1** — Multi-stage approval reconciliation and silent-stall guardrails (9 tasks) ← from w2/004 triage (2026-09-13)
- [x] **m2** — Muse 1.2.1 host support: resolve or record the six real-host failures (7 tasks) ← from m1 real-host verification (2026-09-14)
- [x] **m3** — Distinguishable staged permission prompts (6 tasks) ← from w2/005 (2026-09-14)

- [x] [**m4** — Verified approval policies and independent sandbox controls](done/m4/README.md) (11 tasks) ← feasibility research and user handoff (2026-09-14)

- [x] [**m5** — Faithful model, effort and restored session settings](done/m5/README.md) (10 tasks) ← feasibility research and user handoff (2026-09-14)

- [x] [**m6** — Capability audit and evidence-backed directive fixes](done/m6/README.md) (9 tasks) ← feasibility research and user handoff (2026-09-14)

- [x] [**m7** — Usage, plans and truthful output visibility](done/m7/README.md) (9 tasks) ← w1 cleanup and explicit scope allocation (2026-09-14)

- [x] [**m8** — Actionable failures and observed authentication](done/m8/README.md) (8 tasks) ← w1 cleanup and explicit scope allocation (2026-09-14)

- [x] [**m9** — Observed worker and background task lifecycle](done/m9/README.md) (9 tasks) ← w1 cleanup and explicit scope allocation (2026-09-14)

- [x] [**m10** — Embedded input and independent session commands](done/m10/README.md) (9 tasks) ← w1 cleanup and explicit scope allocation (2026-09-14)

- [x] [**m11** — Verified stored-output retrieval](done/m11/README.md) (6 tasks) ← real host output-read evidence during m9 (2026-09-14)

- [x] [**m12** — Reliable SDK startup and truthful lifecycle failures](done/m12/README.md) (8 tasks) ← promoted from w2/012 after confirmed startup-timeout triage.

- [x] [**m13** — Nonblocking catalogs and native startup handoff](done/m13/README.md) (7 tasks) ← from w2/013 and experimental diagnosis.

## Inbox

Empty. The native startup follow-up (former 014, upstream #11) is tracked in [UPSTREAM_DEPENDENCIES.md](../UPSTREAM_DEPENDENCIES.md#startup-latency).

Note 010 was promoted into m4 with its complete source preserved. Note 012 was promoted into [m12](done/m12/README.md), with its [original report](done/m12/source-012.md) and [captured evidence](evidence/012-startup-timeout.md) preserved.

## Done

- [x] [011 — Reconcile ADR003 and current capability ownership](done/011.md) — reconciled to 0.11.0 (2026-10-26).

- [x] [001 — `/goal <objective>` command UX](done/001.md) — shipped in `d9f509f`; executes the task once with an explicit persistence limitation.
- [x] [002 — Slash-command routing with editor context](done/002.md) — shipped in `d9f509f`; preserves context and workflow enforcement.

- [x] [003 — Repeated Allow once confirmations](done/003.md) — closed as expected behavior; automatic-execution follow-up is now scheduled in [w2/m4](done/m4/README.md).

- [x] [m1 — Multi-stage approval reconciliation and silent-stall guardrails](done/m1/README.md) — consumed inbox note 004; multi-stage shell approvals now complete on the SDK backend and stalled host requests fail with diagnostics. Verified on Muse 1.2.1-R2847.1.

The 001/002 fixes, m1–m3, and session-state reporting are published in
[0.5.0](https://github.com/bex-co/muse-code-acp/releases/tag/v0.5.0), npm's verified
latest version. The SDK multi-stage hang no longer requires the exec workaround.
The documented 1.2.1 legacy-reviewer host limitation remains.

- [x] [m2](done/m2/README.md) — HTTP MCP startup failures restored; legacy-profile host limitation reproduced and explained.

- [x] [m3](done/m3/README.md) — Permission titles distinguish host stages in plain ACP clients; verified through Bex and both host versions.

- [x] [006 — Observe host session state](done/006.md) — negotiated reporting, idle model/mode changes and durable policy-persistence outcomes; 377 unit and 29 live tests passed on both host versions.

- [x] [007 — Notification observation recommendation](done/007.md) — retain SDK routing and narrow public reads; alternatives and engineering costs recorded.

- [x] [008 — Report SDK approval routing defect](done/008.md) — filed [upstream #10](https://github.com/meta-models/muse-code-sdk/issues/10) with a fresh SDK-only reproduction.

- [x] [009 — Publish the completed w2 fixes](done/009.md) — 0.5.0 released; full release CI, npm latest, published-package smoke and GitHub release verified.

## Capability follow-up handoff

[Feasibility research](evidence/capability-feasibility.md) covers all requested categories. m4, m5 and m6 can begin independently; each has explicit internal dependencies. Earlier completed milestones remain historical delivery.

## Current-work ownership

[Exact w1 cleanup ledger](../ownership-2026-09-14.md) assigns every former open task. All current delivery and investigation is here; w1 contains only future public-host watches. m7–m10 have no dependency on a future w1 note.
