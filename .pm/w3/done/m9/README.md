# w3 · m9 — Native session compaction

**Worker:** worker1 **Goal:** A `/compact` command compacts the session through public `session/compact` where the host completes it, and reports refusals truthfully. **Status:** done

## Tasks (in order)

| id   | title                                                             | est | depends_on              |
| ---- | ----------------------------------------------------------------- | --- | ----------------------- |
| t001 | Verify native session compaction on the installed host — **DONE** | 1h  | w3/m7/t006              |
| t002 | Implement native session compaction — **DONE**                    | 2h  | w3/m9/t001, w3/m17/t001 |
| t003 | Adoption surface — **DONE**                                       | 30m | w3/m9/t001, w3/m9/t002  |
| t004 | Simplify milestone changes — **DONE**                             | 30m | w3/m9/t003              |
| t005 | CI and behavior coverage — **DONE**                               | 45m | w3/m9/t004              |
| t006 | Close out milestone — **DONE**                                    | 15m | w3/m9/t005              |

## Definition of done

- On hosts where compaction completes, `/compact` compacts without a model turn from the adapter and reports the outcome; on refusing hosts it is not advertised or fails with the host reason; history and continuation stay correct afterwards.
- Unverified operations remain unadvertised with a recorded reason.

## Source + Goal linkage

- **Source:** 2026-10-12 Muse feature research (user request "research recent muse wonder and add them to the offering"; `/pm all for w3`). SDK 1.3.0/1.4.4/1.4.6 method registries compared against adapter call sites: the SDK facade covers only turns, approvals and user input, and the adapter calls `session/read`, `view/page`, `model/list`, `session/setModel`, `session/setApprovalMode`, `session/list`, `session/fork`, `workflow/cancel`, `item/readOutput`, `turn/cancel`, `turn/steer`, `approval/decide` and `userInput/answer|cancel` only.
- **Goal linkage:** Truthful capabilities and usable editor integration: offer verified public Muse features through ACP instead of leaving them unreachable.
- **Expected outcome:** Users can shrink long sessions natively.
- **Methods:** session/compact (since SDK 1.3.0).
- **Why now:** Long sessions hit context limits; the method is public and may now work on 1.4.x.
- **Adoption surface:** separate closing task t003.
- **Constraints:** public SDK/MSP only, feature-detected and live-verified on the installed host before advertisement (DO_NOT_DO); no fabricated controls; safe defaults unchanged.
- **Triage 2026-10-15:** ACP SDK 1.8.0 (stable schema) standardizes compaction reporting: `clientCapabilities.session.compaction`, then `CompactionUpdate` and `CompactionSummaryChunk` session updates. It adds no client→agent compact method. `/compact` therefore stays the trigger, but t002 reports the outcome through the standard updates instead of a custom extension. t002 now depends on w3/m17/t001 (ACP SDK 1.8.0 bump). w3/m17/t003 and w3/m19 defer `CompactionUpdate` to this milestone.

## Validation evidence

### Blocker — 2026-10-12

t001 found no host that completes `session/compact`: Muse 1.4.6 with the loopback provider rejects with `compaction_unavailable` after real turns (`missing_run` on an empty session), with or without a configured compaction strategy. Implementing `/compact` now would advertise an operation never observed to work, contrary to this milestone's definition of done.

Resume when either: (a) the user approves one small real-provider probe (a few turns plus `session/compact` in a throwaway workspace) and it completes, or (b) Muse documents when `session/compact` is available. Until then `/compact` stays ordinary prompt text, as `docs/capability-audit.md` records. No dependents.

### Blocker re-check — 2026-10-15

Muse 1.4.8-R6256.1 through the public SDK connection (`@muse-code/sdk` 1.4.7 client), throwaway probe, no paid tokens:

| Provider                                                                   | Empty session                   | After three completed turns                | Compaction item | Next turn |
| -------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------ | --------------- | --------- |
| Loopback (`endpoint_transport` to a local fake)                            | `commandRejected` `missing_run` | `commandRejected` `compaction_unavailable` | none            | completes |
| Loopback with `context_compaction_strategy: "summary-preserved-suffix/v1"` | `commandRejected` `missing_run` | `commandRejected` `compaction_unavailable` | none            | completes |
| Built-in `muse serve --provider echo`                                      | `commandRejected` `missing_run` | `commandRejected` `compaction_unavailable` | none            | completes |

SDK 1.4.8 leaves `SessionCompactParams`/`SessionCompactResult` unchanged and still does not document when compaction is available. The blocker and resume conditions above stand. This also answers w3/m17/t002's `session/compact` re-probe: behavior unchanged on 1.4.8.

### Blocker re-check — 2026-10-23

Muse 1.4.12-R6909.1 with `@muse-code/sdk` 1.4.12, same three-provider probe: identical results (`missing_run` empty, `compaction_unavailable` after three turns, no compaction item, next turn completes). Also refused with model id `muse-wonder-full-1.0` and 900k reported input tokens. Hypothesis (unproven): the loopback's bundled-catalog model has `contextLimit: null`, which may disable compaction. CLI help and the SDK still do not document availability.

New public evidence: [muse-code-sdk#112](https://github.com/meta-models/muse-code-sdk/issues/112) reports `session/compact` completing with a real `muse-wonder-full-1.0` provider on 1.4.11/1.4.12, but MCP is lost after resuming the compacted session ("MCP startup audit failed"). Resume condition (a), one user-approved real-provider probe, is now more likely to succeed. If it does, t002 must handle the #112 resume defect (warn, or re-check MCP after a compacted resume). Still blocked.

### Blocker resolved — 2026-10-25

User-approved real-provider probe (`muse-spark-1.3`, Muse 1.4.12-R6909.1, throwaway workspace): `session/compact` was accepted and the manual compaction item completed (`compacted`, 30585 → 23051 tokens); continuation and resume worked. Resume condition (a) is met, so t002 is implemented and gated to Muse 1.4.12+. The loopback provider is still refused, which the live suite now asserts. #112 (MCP lost after resuming a compacted session) was not reproduced: no MCP servers were configured in the probe.
