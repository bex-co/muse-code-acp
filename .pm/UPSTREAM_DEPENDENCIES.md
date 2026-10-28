# Upstream dependencies

The single index of everything this adapter is blocked on, or works around,
because of Muse (host or SDK) or ACP. Blocked work lives **here**, not as board
watches: when an item becomes unblocked, promote it to a w1 inbox note or
milestone (see "Promoting"), and keep its row until the delivery ships.

Status checked **2026-10-28** (adapter 0.11.0+main pinning `@muse-code/sdk` 1.4.13;
Muse 1.4.14-R7309.1 and `@muse-code/sdk` 1.4.14 are out, adoption is
[w1/m26](w1/m26/README.md); ACP SDK 1.8.0). Host checks used pinned binaries
verified against Meta's manifest SHA-256, because the `muse` launcher auto-updates. Issues are in
[meta-models/muse-code-sdk](https://github.com/meta-models/muse-code-sdk/issues)
unless noted; "filed by us" means the maintainer account reported it.

## Maintaining

- Re-check open rows on every Muse or SDK bump (`gh issue view <n> -R meta-models/muse-code-sdk`)
  and each blocked capability's revisit trigger against the new `msp.d.ts`, CLI help
  and ACP schema. `/qa-find-bugs` tags these items as known.
- When a fix or surface ships: verify it on the real host (feature-detected, never
  assumed), remove any adapter workaround, and move the row to **Resolved** with the
  version and evidence.
- Rules for every blocked capability below: verify both public admission and the
  user-visible outcome before advertising anything; no private APIs, TUI automation
  or fake outcomes (`.pm/DO_NOT_DO.md`); keep blocked variants explicit; don't poll
  without a new public artifact or a concrete reproduction.

### Promoting

Trigger met → add a w1 inbox note (≤1h) or milestone with the evidence and the
acceptance criteria from its section here, then mark the row "unblocked → w1/…".

## Open issues: affect users today

| Issue                                                                                                                                                                                                        | Status                                                                                                                                                                                      | What it breaks                                                                                                                                                | Adapter today                                                                                                                                                                     | Board                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| [#121](https://github.com/meta-models/muse-code-sdk/issues/121) `session/resume` reports a finished turn as `activeTurnId` after `session/compact` (1.4.12, 1.4.13). Filed by us.                            | Open, no reply. **Fixed in 1.4.14** by our check (2026-10-28): the same adapter repro logs the phantom on 1.4.13-R6996.1 and not on 1.4.14-R7309.1 (two runs)                               | A compacted session looked busy forever after an editor restart (only `session/resume` reports the phantom; `session/read` and `session/fork` are unaffected) | Worked around in 0.11.0 (only `pendingRequests` block; Muse's admission decides). Fork verified unaffected 2026-10-27                                                             | unblocked → [w1/m26](w1/m26/README.md) t003       |
| [#120](https://github.com/meta-models/muse-code-sdk/issues/120) `session/fork` always fails on Linux: "file birth time is unavailable" (1.4.12, 1.4.13; 1.4.8 worked). We added CI evidence.                 | Open. **Fixed in 1.4.14** by our check (2026-10-28): MSP `session/start` + `session/fork` in a Linux aarch64 container fails on 1.4.13, forks on 1.4.14; x86 CI confirmation in w1/m26 t001 | Forking on Linux                                                                                                                                              | Reports Muse's message; live tests record the limitation (`forkUnavailable()` in `src/tests/acp-real-host-helpers.ts`)                                                            | unblocked → [w1/m26](w1/m26/README.md) t001, t003 |
| [#97](https://github.com/meta-models/muse-code-sdk/issues/97) `session/fork` accepts only the latest completed turn as a boundary (1.4.3–1.4.11). Filed by us.                                               | Open; fixed in 1.4.12 per our comment, awaiting maintainer close (unchanged 2026-10-28)                                                                                                     | Forking at an earlier turn on ≤1.4.11                                                                                                                         | Names the latest turn in the error; tests enumerate affected builds (`FORK_CUT_LATEST_ONLY`)                                                                                      | [w3/m2](w3/done/m2/README.md)                     |
| [#11](https://github.com/meta-models/muse-code-sdk/issues/11) `muse serve` initialization traverses the whole session history. Filed by us.                                                                  | Open; maintainer: "tracked internally (P2)". Not fixed in 1.4.14: `session/start` on the real large history took 13.8/14.8 s on 1.4.13 and 15.3/14.3 s on 1.4.14 (2026-10-28)               | Slow first prompt (`session/start` ≈ 12 s on a large history)                                                                                                 | Hidden by background host prewarm (0.11.0) and lazy catalogs (w2/m13)                                                                                                             | [below](#startup-latency)                         |
| [#112](https://github.com/meta-models/muse-code-sdk/issues/112) After resuming a compacted session, MCP startup is skipped and turns fail ("MCP startup audit failed") (1.4.11; reproduced by us on 1.4.13). | **Closed 2026-10-28** (completed, fixed in 1.4.14 per the reporter); our `/qa-find-bugs` R5 passes on 1.4.14 (2026-10-28)                                                                   | `/compact` + resume with MCP servers configured                                                                                                               | Not worked around on 1.4.11–1.4.13 (reproduced 2026-10-26 on 1.4.13 by `/qa-find-bugs` R5: the next turn fails with "MCP startup audit failed; MCP is disabled for this runtime") | unblocked → [w1/m26](w1/m26/README.md) t003       |
| [#99](https://github.com/meta-models/muse-code-sdk/issues/99) Headless `muse exec` waits forever when the reviewer escalates (1.4.4). Filed by us.                                                           | Open                                                                                                                                                                                        | Legacy exec backend approvals                                                                                                                                 | Exec stops after `MUSE_CODE_ACP_EXEC_APPROVAL_STALL_MS` with a diagnostic                                                                                                         | [w3/m6](w3/done/m6/README.md)                     |
| [#80](https://github.com/meta-models/muse-code-sdk/issues/80) No approval judge / reviewer field for `muse serve`. We added a supplemental comment.                                                          | Open (feature)                                                                                                                                                                              | Exec sessions saved with `:auto-review` cannot be loaded through serve                                                                                        | Documented limitation (`docs/sdk-migration.md`)                                                                                                                                   | [w3/m6](w3/done/m6/README.md)                     |
| [#13](https://github.com/meta-models/muse-code-sdk/issues/13) `Item.childSessionId` documented as readable, but child reads/resume are rejected. Filed by us.                                                | Open; partly moved on 1.4.12 (reads work for children that kept a transcript; resume still -32020). SDK 1.4.14 adds only child `worktree` facts and `spawnedBy` provenance                  | Child-session history and controls                                                                                                                            | Worker cards with attribution only                                                                                                                                                | [below](#child-sessions)                          |
| [#51](https://github.com/meta-models/muse-code-sdk/issues/51) Session housekeeping over MSP: archive/delete, search, export.                                                                                 | Open (feature); 1.4.12's `session/leave` only releases; no new session method in SDK 1.4.14                                                                                                 | Deleting a root session from the editor                                                                                                                       | Not offered                                                                                                                                                                       | [below](#root-session-deletion)                   |
| [#43](https://github.com/meta-models/muse-code-sdk/issues/43) Permission profiles, approval judge, workspace trust and worktrees on `session/start`.                                                         | Open (feature). `permissionProfile` on `session/start`/`resume` exists (≤1.4.13); judge, workspace trust and worktrees still absent in SDK 1.4.14                                           | Plan/read-only parity with the CLI on the SDK backend                                                                                                         | Adapter-owned modes and read-only flags                                                                                                                                           | [w2/m4](w2/done/m4/README.md)                     |
| [#31](https://github.com/meta-models/muse-code-sdk/issues/31) Windows: `session/fork` fails with `WriteFailed`.                                                                                              | Open; maintainer-confirmed, tracked internally                                                                                                                                              | Forking on Windows (not CI-verified by us)                                                                                                                    | None                                                                                                                                                                              | —                                                 |
| [#79](https://github.com/meta-models/muse-code-sdk/issues/79) Event log fails after a compaction checkpoint; later turns conflict, serve stops answering (reported on 1.4.0-era hosts).                      | Open                                                                                                                                                                                        | Possible failure after `/compact` on affected hosts                                                                                                           | Not reproduced on 1.4.12/1.4.13; `/compact` is gated to 1.4.12+                                                                                                                   | [w3/m9](w3/done/m9/README.md)                     |
| [#103](https://github.com/meta-models/muse-code-sdk/issues/103) A fork taken during a running turn copies that turn past the cut (1.4.2).                                                                    | Open                                                                                                                                                                                        | Fork while a turn runs                                                                                                                                        | Adapter refuses to fork a source Muse reports as running or waiting on input                                                                                                      | [docs/session-fork.md](../docs/session-fork.md)   |

## Blocked capabilities

| Capability                                                                    | Blocked on | Upstream                                                      | Section                                         |
| ----------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------- | ----------------------------------------------- |
| Live MCP connection status and tool counts                                    | Muse       | no issue                                                      | [MCP status](#mcp-status)                       |
| Native child sessions and isolated child controls                             | Muse       | [#13](https://github.com/meta-models/muse-code-sdk/issues/13) | [Child sessions](#child-sessions)               |
| Rich media (images, structured results) preserved through turns               | Muse       | no issue                                                      | [Rich media](#rich-media)                       |
| Correlated URL elicitation                                                    | Muse       | no issue                                                      | [URL elicitation](#url-elicitation)             |
| Native service tiers                                                          | Muse       | no issue                                                      | [Service tiers](#service-tiers)                 |
| Authoritative account rate limits                                             | Muse       | no issue                                                      | [Rate limits](#rate-limits)                     |
| Root-session deletion                                                         | Muse       | [#51](https://github.com/meta-models/muse-code-sdk/issues/51) | [Root-session deletion](#root-session-deletion) |
| Fast `muse serve` startup on a large history                                  | Muse       | [#11](https://github.com/meta-models/muse-code-sdk/issues/11) | [Startup latency](#startup-latency)             |
| Compaction with the local loopback provider (CI coverage of the success path) | Muse       | no issue                                                      | [Loopback compaction](#loopback-compaction)     |
| Side chats                                                                    | ACP        | —                                                             | [Side chats](#side-chats)                       |
| Computer-use settings and setup                                               | ACP        | —                                                             | [Computer use](#computer-use)                   |
| Root-session state and error stop reasons                                     | ACP        | —                                                             | [Root-session state](#root-session-state)       |

### MCP status

Why: `/mcp status` reports the configured inventory and observed startup failures, but not the host's live connection state or tool/resource counts.

- Evidence: SDK 1.4.12/1.4.13 experimental `mcpServer/list` returns only name, oauth, source and transport ("config-and-auth facts only"; unchanged in 1.4.14); `muse mcp --help` offers OAuth login/logout only (2026-10-23).
- Revisit trigger: a documented release adds a host-owned MCP status/inventory method or notification.
- Acceptance once unblocked: a "ready" status must describe Muse's resident connection (a separate diagnostic client's initialize/tools/list is not host readiness); cover config/host identity, timestamps, unknown/stale state, tool/resource counts, auth changes and reconnects with real-host fixtures. Keep local `/mcp` free of implicit probes/OAuth; never invent counts or expose credentials.
- History: ADR003 follow-up research §3; former watch w1/003.

### Child sessions

Why: workflow/subagent children appear only as attributed worker cards; their history and targeted controls are not reachable.

- Evidence: 1.4.12 (`scripts/reproduce-delegated-workers.mjs`): `session/read`/`view/page` succeed for children that kept a transcript (4 of 9); memory-only reminder helpers return -32020; `session/resume` on a child fails -32020; no `subagent` items, `subagent/readResult` → `invalid_target`. Workflow lifecycle and exact cancel are delivered (w2/m9). The earlier `workflow/childControl` observation was withdrawn (not a public method).
- Revisit trigger: #13 resolves, or a release exposes accessible child histories plus stable routable child/control identities.
- Acceptance once unblocked: child stream negotiation, restart history, distinct parent/sibling identity, real child approval grant/deny and targeted controls; workflow handles or new root sessions are not substitutes. ACP's unstable `SubagentUpdate` is the client surface to evaluate.
- History: former watch w1/005 (and w1/m11, w1/m15).

### Rich media

Why: tools that return images, links or structured data reach the client as flattened text.

- Evidence: 1.2.1 MCP `tools/call` with mixed text/image/link/structured content produced a completed tool item with flattened `visibleOutput` only, no `modelVisibleContent` or `outputRef`. Stored text output retrieval is delivered separately (w2/m11).
- Revisit trigger: a host version preserves displayable binary/structured content in public items.
- Acceptance once unblocked: deliver ordered image/link/structured results with the original call ID; cover lifetime and cleanup; never decode placeholder descriptions or fetch arbitrary URIs.
- History: former watch w1/007 (w1/m17).

### URL elicitation

Why: ACP clients support URL elicitation, but Muse questions cannot ask for one.

- Evidence: public `userInput` questions/options and answer/cancel expose no URL request IDs or completion events; `UserInputQuestion` has no URL fields (SDK 1.4.13; unchanged in 1.4.14).
- Revisit trigger: a published host/API defines URL elicitation correlation, completion and cancellation.
- Acceptance once unblocked: request/accept/complete plus cancelled and late requests with a local fixture and client negotiation; no URL opening/fetch without the interaction contract.
- History: former watch w1/009 (w1/m20).

### Service tiers

Why: Muse may offer faster or cheaper serving tiers per model; the adapter can't show or select them.

- Evidence: `model/list` (1.4.13) has `variants`, `defaultReasoningEffort`, `reasoningEffortVariants`, `cost`, `contextLimit` and `outputLimit`, but no tier field; unchanged in SDK 1.4.14. Per-model efforts are delivered (w1/010's other half, 2026-10-27).
- Revisit trigger: a public contract names available tiers with authoritative provenance.
- Acceptance once unblocked: verify advertised values, actual provider effect and restoration; never infer tier behavior from labels.
- History: former watch w1/010 (w1/m21).

### Rate limits

Why: `/status` shows subscription usage windows (`usage/read`, 1.4.7+), but not per-account rate limits or quotas beyond them.

- Evidence: public MSP has no account quota/limit query; turn tokens, pricing and credentials don't supply limits.
- Revisit trigger: a documented response exposes authorized quota, reset and identity fields.
- Acceptance once unblocked: verify response provenance and invalidation on account change; missing data stays "unknown"; secrets never appear.
- History: former watch w1/011 (w1/m21); usage windows delivered in w3/m13.

### Root-session deletion

Why: users can't delete a Muse session from the editor.

- Evidence: no deletion method in the stable or experimental schema or CLI. 1.4.12's `session/leave` only releases (`leaveCompleted outcome: released`; the session stays listed as `notLoaded`, `session/read` works, `session/resume` continues it).
- Revisit trigger: #51 or another documented deletion API specifying active-session behavior and durable list/read/load semantics.
- Acceptance once unblocked: delete only the target; prove later list/load absence and that other sessions are kept. Adapter-side hiding, direct store deletion or close are not equivalent.
- History: former watch w1/012 (w1/m23).

### Startup latency

Why: `muse serve` startup scans the session history, so a cold first prompt waited ~12 s on a large history.

- Evidence: public reproduction `scripts/reproduce-muse-startup.mjs` with 6,000 synthetic sessions (method and limits in `docs/muse-startup-latency.md`). 1.3.0: initialize 80 ms empty / 998 ms populated / 11.8–12.0 s at 16 concurrent. 1.4.12: 438 ms empty / 413 ms populated / 2.1–2.9 s at 16 concurrent; provider requests 0. Maintainer (2026-10-02): tracked internally (P2), fix will bound or defer the scan.
- Adapter mitigation: lazy catalogs (w2/m13) and background host prewarm (0.11.0) hide it from the first prompt (measured 9 ms adapter wait).
- Revisit trigger: #11 reports a fix. Then rerun the empty/populated × 1/16 matrix and close only with a measured improvement and no session-visibility regression.
- History: former note w2/014, evidence in `w2/evidence/`.

### Loopback compaction

Why: CI can only test `/compact`'s refusal path, because Muse refuses compaction (`compaction_unavailable`) for the local loopback provider.

- Evidence: w3/m9 probes on 1.4.8–1.4.13 with and without `context_compaction_strategy`; the same requests compact with a real provider. Hypothesis (unproven): the loopback's bundled-catalog model has `contextLimit: null`.
- Revisit trigger: Muse documents compaction availability, or a loopback configuration that compacts is found.
- Acceptance once unblocked: add the completion path to `compaction-live.test.ts`.

### Side chats

Why: Muse 1.4.4+ `session/sideChat` opens a side session with provenance; ACP has no side-chat concept.

- Evidence: ACP 1.8.0's unstable `SubagentUpdate` covers agent-owned children, not user-opened side sessions; `sideChat` items render as generic cards. Unchanged in SDK 1.4.14.
- Revisit trigger: ACP gains a side-conversation surface, or a client asks for a mapping (likely fork-style session creation).
- History: former note w3/005.

### Computer use

Why: Muse 1.4.4+ `computerUseSettings/*` and `computerUseSetup/*` configure macOS computer use (per-app choices since 1.4.8); ACP has no host-settings surface.

- Evidence: no ACP surface (1.8.0). SDK 1.4.12/1.4.13 add approval `cuaCardFacts` (page host, steps, data facts with secret masks) that could enrich computer-use permission prompts independently.
- Revisit trigger: ACP gains a settings surface, or a client needs it. Never change the user's computer-use permissions implicitly.
- History: former note w3/006.

### Root-session state

Why: ACP 1.8's `StateUpdate` (idle/running/requires-action) and `ErrorStopReason` would let clients show richer session state.

- Evidence: in ACP 1.8.0 both are referenced only by the unstable `SubagentUpdate`; prompt `StopReason` has no error variant. The adapter keeps `muse/*` progress and failure reporting.
- Revisit trigger: ACP makes them available for root sessions.
- History: w3/m19, dropped 2026-10-15.

## Resolved

| Issue                                                                                                                                                                | Resolution                  | Adapter follow-up                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------ |
| [#10](https://github.com/meta-models/muse-code-sdk/issues/10) SDK `onApproval` not rerouted when `approval/updated` advances a multi-stage requirement. Filed by us. | Closed; fixed in SDK 1.3.0  | Adapter decides approvals from the fold, unaffected ([w2/008](w2/done/008.md)) |
| [#6](https://github.com/meta-models/muse-code-sdk/issues/6) `turn/start` `reasoningEffort` accepted but never forwarded                                              | Closed                      | Effort sent per turn; verified live (`settings-live.test.ts`)                  |
| [#7](https://github.com/meta-models/muse-code-sdk/issues/7) serve ignored the session model pin                                                                      | Closed                      | Explicit `session/setModel` on every host open                                 |
| [#63](https://github.com/meta-models/muse-code-sdk/issues/63) `denyUnmatched` denied Muse's own reminder decision, holding turns ~60 s                               | Closed; fixed in host 1.4.2 | None needed ([w3/m6](w3/done/m6/README.md))                                    |
