# Current delivery and future host support — 2026-09-14

User-authorized scheduling cleanup: w1 contains completed history and future public SDK/host enablement watches only. Current implementation and investigation execute solely in w2. Moving work is neither completion nor dropping requirements.

## Rules

- Concrete current implementation has exactly one owner below. Split rows separate distinct slices; they do not authorize duplicate implementation.
- Public/native gaps with evidence remain trigger-based w1 notes. Unverified current routes stay in w2 for investigation, especially workflow/background controls.
- All 61 old task records and eight milestone definitions are preserved as historical source. Their old logical IDs are not reused; replacements are explicit.
- Original closeout requirements now apply separately to each split delivery. A current milestone does not wait for the future native slice, and cannot claim to deliver it.
- Required future implementation gets new w2 tasks only after its public support trigger is met.

## Exact scope allocation

| Original logical task | Current implementation / distinct future slice                                                   | Preserved source                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| w1/m9/t001            | [w2/m7/t001](w2/done/m7/done/t001.md)                                                            | [source](w1/evidence/2026-09-14-superseded/m9.md#original-t001)  |
| w1/m9/t002            | [w1/004](w1/done/004.md)                                                                         | [source](w1/evidence/2026-09-14-superseded/m9.md#original-t002)  |
| w1/m9/t003            | [w2/m7/t002](w2/done/m7/done/t002.md)                                                            | [source](w1/evidence/2026-09-14-superseded/m9.md#original-t003)  |
| w1/m9/t004            | [w2/m7/t003](w2/done/m7/done/t003.md)                                                            | [source](w1/evidence/2026-09-14-superseded/m9.md#original-t004)  |
| w1/m9/t005            | [w2/m7/t004](w2/done/m7/done/t004.md)                                                            | [source](w1/evidence/2026-09-14-superseded/m9.md#original-t005)  |
| w1/m9/t006            | [w2/m7/t005](w2/done/m7/done/t005.md)                                                            | [source](w1/evidence/2026-09-14-superseded/m9.md#original-t006)  |
| w1/m9/t007            | [w2/m7 closing tasks](w2/done/m7/README.md); future promotion closing criteria for this source   | [source](w1/evidence/2026-09-14-superseded/m9.md#original-t007)  |
| w1/m9/t008            | [w2/m7 closing tasks](w2/done/m7/README.md); future promotion closing criteria for this source   | [source](w1/evidence/2026-09-14-superseded/m9.md#original-t008)  |
| w1/m9/t009            | [w2/m7 closing tasks](w2/done/m7/README.md); future promotion closing criteria for this source   | [source](w1/evidence/2026-09-14-superseded/m9.md#original-t009)  |
| w1/m11/t001           | [w2/m9/t002](w2/done/m9/done/t002.md)                                                            | [source](w1/evidence/2026-09-14-superseded/m11.md#original-t001) |
| w1/m11/t002           | [w1/005](UPSTREAM_DEPENDENCIES.md)                                                               | [source](w1/evidence/2026-09-14-superseded/m11.md#original-t002) |
| w1/m11/t003           | [w1/005](UPSTREAM_DEPENDENCIES.md)                                                               | [source](w1/evidence/2026-09-14-superseded/m11.md#original-t003) |
| w1/m11/t004           | [w1/005](UPSTREAM_DEPENDENCIES.md)                                                               | [source](w1/evidence/2026-09-14-superseded/m11.md#original-t004) |
| w1/m11/t005           | [w2/m9/t004](w2/done/m9/done/t004.md); [w1/005](UPSTREAM_DEPENDENCIES.md)                        | [source](w1/evidence/2026-09-14-superseded/m11.md#original-t005) |
| w1/m11/t006           | [w2/m9 closing tasks](w2/done/m9/README.md); future promotion closing criteria for this source   | [source](w1/evidence/2026-09-14-superseded/m11.md#original-t006) |
| w1/m11/t007           | [w2/m9 closing tasks](w2/done/m9/README.md); future promotion closing criteria for this source   | [source](w1/evidence/2026-09-14-superseded/m11.md#original-t007) |
| w1/m11/t008           | [w2/m9 closing tasks](w2/done/m9/README.md); future promotion closing criteria for this source   | [source](w1/evidence/2026-09-14-superseded/m11.md#original-t008) |
| w1/m14/t001           | [w2/m8/t001](w2/done/m8/done/t001.md)                                                            | [source](w1/evidence/2026-09-14-superseded/m14.md#original-t001) |
| w1/m14/t002           | [w2/m8/t002](w2/done/m8/done/t002.md)                                                            | [source](w1/evidence/2026-09-14-superseded/m14.md#original-t002) |
| w1/m14/t003           | [w1/006](w1/006.md)                                                                              | [source](w1/evidence/2026-09-14-superseded/m14.md#original-t003) |
| w1/m14/t004           | [w2/m8/t003](w2/done/m8/done/t003.md)                                                            | [source](w1/evidence/2026-09-14-superseded/m14.md#original-t004) |
| w1/m14/t005           | [w2/m8/t004](w2/done/m8/done/t004.md)                                                            | [source](w1/evidence/2026-09-14-superseded/m14.md#original-t005) |
| w1/m14/t006           | [w2/m8 closing tasks](w2/done/m8/README.md); future promotion closing criteria for this source   | [source](w1/evidence/2026-09-14-superseded/m14.md#original-t006) |
| w1/m14/t007           | [w2/m8 closing tasks](w2/done/m8/README.md); future promotion closing criteria for this source   | [source](w1/evidence/2026-09-14-superseded/m14.md#original-t007) |
| w1/m14/t008           | [w2/m8 closing tasks](w2/done/m8/README.md); future promotion closing criteria for this source   | [source](w1/evidence/2026-09-14-superseded/m14.md#original-t008) |
| w1/m15/t001           | [w2/m9/t001](w2/done/m9/done/t001.md)                                                            | [source](w1/evidence/2026-09-14-superseded/m15.md#original-t001) |
| w1/m15/t002           | [w2/m9/t003](w2/done/m9/done/t003.md); [w1/005](UPSTREAM_DEPENDENCIES.md)                        | [source](w1/evidence/2026-09-14-superseded/m15.md#original-t002) |
| w1/m15/t003           | [w2/m9/t004](w2/done/m9/done/t004.md)                                                            | [source](w1/evidence/2026-09-14-superseded/m15.md#original-t003) |
| w1/m15/t004           | [w2/m9/t005](w2/done/m9/done/t005.md)                                                            | [source](w1/evidence/2026-09-14-superseded/m15.md#original-t004) |
| w1/m15/t005           | [w2/m9 closing tasks](w2/done/m9/README.md); future promotion closing criteria for this source   | [source](w1/evidence/2026-09-14-superseded/m15.md#original-t005) |
| w1/m15/t006           | [w2/m9 closing tasks](w2/done/m9/README.md); future promotion closing criteria for this source   | [source](w1/evidence/2026-09-14-superseded/m15.md#original-t006) |
| w1/m15/t007           | [w2/m9 closing tasks](w2/done/m9/README.md); future promotion closing criteria for this source   | [source](w1/evidence/2026-09-14-superseded/m15.md#original-t007) |
| w1/m17/t001           | [w2/m7/t004](w2/done/m7/done/t004.md); [w1/007](w1/007.md)                                       | [source](w1/evidence/2026-09-14-superseded/m17.md#original-t001) |
| w1/m17/t002           | [w2/m7/t004](w2/done/m7/done/t004.md); [w1/007](w1/007.md)                                       | [source](w1/evidence/2026-09-14-superseded/m17.md#original-t002) |
| w1/m17/t003           | [w2/m7/t004](w2/done/m7/done/t004.md); [w2/m11](w2/done/m11/README.md); [w1/007](w1/007.md)      | [source](w1/evidence/2026-09-14-superseded/m17.md#original-t003) |
| w1/m17/t004           | [w2/m7 closing tasks](w2/done/m7/README.md); future promotion closing criteria for this source   | [source](w1/evidence/2026-09-14-superseded/m17.md#original-t004) |
| w1/m17/t005           | [w2/m7 closing tasks](w2/done/m7/README.md); future promotion closing criteria for this source   | [source](w1/evidence/2026-09-14-superseded/m17.md#original-t005) |
| w1/m17/t006           | [w2/m7 closing tasks](w2/done/m7/README.md); future promotion closing criteria for this source   | [source](w1/evidence/2026-09-14-superseded/m17.md#original-t006) |
| w1/m20/t001           | [w2/m10/t001](w2/done/m10/done/t001.md); [w1/008](w1/008.md); [w1/009](UPSTREAM_DEPENDENCIES.md) | [source](w1/evidence/2026-09-14-superseded/m20.md#original-t001) |
| w1/m20/t002           | [w2/m10/t001](w2/done/m10/done/t001.md)                                                          | [source](w1/evidence/2026-09-14-superseded/m20.md#original-t002) |
| w1/m20/t003           | [w1/008](w1/008.md)                                                                              | [source](w1/evidence/2026-09-14-superseded/m20.md#original-t003) |
| w1/m20/t004           | [w1/009](UPSTREAM_DEPENDENCIES.md)                                                               | [source](w1/evidence/2026-09-14-superseded/m20.md#original-t004) |
| w1/m20/t005           | [w2/m10 closing tasks](w2/done/m10/README.md); future promotion closing criteria for this source | [source](w1/evidence/2026-09-14-superseded/m20.md#original-t005) |
| w1/m20/t006           | [w2/m10 closing tasks](w2/done/m10/README.md); future promotion closing criteria for this source | [source](w1/evidence/2026-09-14-superseded/m20.md#original-t006) |
| w1/m20/t007           | [w2/m10 closing tasks](w2/done/m10/README.md); future promotion closing criteria for this source | [source](w1/evidence/2026-09-14-superseded/m20.md#original-t007) |
| w1/m21/t001           | [w2/m5/t009](w2/done/m5/done/t009.md); [w1/010](w1/010.md); [w1/011](UPSTREAM_DEPENDENCIES.md)   | [source](w1/evidence/2026-09-14-superseded/m21.md#original-t001) |
| w1/m21/t002           | [w2/m5/t009](w2/done/m5/done/t009.md)                                                            | [source](w1/evidence/2026-09-14-superseded/m21.md#original-t002) |
| w1/m21/t003           | [w2/m5/t003](w2/done/m5/done/t003.md); [w1/010](w1/010.md)                                       | [source](w1/evidence/2026-09-14-superseded/m21.md#original-t003) |
| w1/m21/t004           | [w2/m5/t010](w2/done/m5/done/t010.md)                                                            | [source](w1/evidence/2026-09-14-superseded/m21.md#original-t004) |
| w1/m21/t005           | [w1/011](UPSTREAM_DEPENDENCIES.md)                                                               | [source](w1/evidence/2026-09-14-superseded/m21.md#original-t005) |
| w1/m21/t006           | [w2/m5 closing tasks](w2/done/m5/README.md); future promotion closing criteria for this source   | [source](w1/evidence/2026-09-14-superseded/m21.md#original-t006) |
| w1/m21/t007           | [w2/m5 closing tasks](w2/done/m5/README.md); future promotion closing criteria for this source   | [source](w1/evidence/2026-09-14-superseded/m21.md#original-t007) |
| w1/m21/t008           | [w2/m5 closing tasks](w2/done/m5/README.md); future promotion closing criteria for this source   | [source](w1/evidence/2026-09-14-superseded/m21.md#original-t008) |
| w1/m23/t001           | [w2/m10/t002](w2/done/m10/done/t002.md)                                                          | [source](w1/evidence/2026-09-14-superseded/m23.md#original-t001) |
| w1/m23/t002           | [w2/m10/t003](w2/done/m10/done/t003.md)                                                          | [source](w1/evidence/2026-09-14-superseded/m23.md#original-t002) |
| w1/m23/t003           | [w1/012](UPSTREAM_DEPENDENCIES.md)                                                               | [source](w1/evidence/2026-09-14-superseded/m23.md#original-t003) |
| w1/m23/t004           | [w2/m10/t004](w2/done/m10/done/t004.md)                                                          | [source](w1/evidence/2026-09-14-superseded/m23.md#original-t004) |
| w1/m23/t005           | [w2/m10/t005](w2/done/m10/done/t005.md)                                                          | [source](w1/evidence/2026-09-14-superseded/m23.md#original-t005) |
| w1/m23/t006           | [w2/m10 closing tasks](w2/done/m10/README.md); future promotion closing criteria for this source | [source](w1/evidence/2026-09-14-superseded/m23.md#original-t006) |
| w1/m23/t007           | [w2/m10 closing tasks](w2/done/m10/README.md); future promotion closing criteria for this source | [source](w1/evidence/2026-09-14-superseded/m23.md#original-t007) |
| w1/m23/t008           | [w2/m10 closing tasks](w2/done/m10/README.md); future promotion closing criteria for this source | [source](w1/evidence/2026-09-14-superseded/m23.md#original-t008) |

## Other consolidation

- w1/001 moves to [w2/011](w2/011.md), retaining its [original source](w1/evidence/2026-09-14-superseded/001.md).
- w1/m25 was already superseded by [w2/m4](w2/done/m4/README.md); its original source and eight-task mapping remain intact.
- w2/m5 owns all current model/provider/effort/recommendation work, including client gateway provisioning in t009 and recommendations in t010.
- w2/m6 is the capability classification and residual routing consistency owner, not a duplicate implementation milestone for m4/m5/m7–m10. It consumes this ledger and verifies uncovered rows rather than reassigning already-owned work.
- Closed w1/done milestones remain historical deliveries. Only necessary link relocation occurs; no completion status is changed.

## Fresh cleanup checks

Isolated loopback probes on Muse 1.2.1-R2847.1 / SDK 0.1.1 on macOS ARM64:

- A completed two-stage workspace write was followed by session/compact; it rejected with -32030 compaction_unavailable. This confirms the earlier durable-compaction boundary on this host too.
- A workflow produced a completed public workflow item; the old workflow_launch_unavailable failure did not reproduce. Workflow/background delivery therefore stays in w2. Four observed reminder-child IDs rejected session/read and session/resume with -32020; native child-history integration remains a separate watch.
- MCP initialize/list/call completed. A mixed text/image/link/structured result still reached public tool state only as flattened visibleOutput, without modelVisibleContent/outputRef. The turn completed; do not retain the old projectionError as a universal blocker.
- Fresh 1.2.1 HTTP 503 recheck completed with retryable modelError after provider retries (20 requests total including subordinate activity); no turn/retryScheduled event occurred. Transport attempts are not native scheduled-retry notifications.

Probe code/logs: gitignored artifacts/w1-cleanup and existing .tmp loopback fixtures.
No paid providers or production state was touched. These are narrow reassessments,
not production regression coverage or proof of all platform/version behavior.

## Cleanup validation

Validated after the split: 209 unique repository task IDs, all dependency targets
exist, no cycles, and every same-milestone prerequisite precedes its dependent
in the task table. w1 has no active milestone directory and has exactly 11 future
watches (002–012). w2/m4–m10 contain 65 todo tasks, plus inbox 011. Every one of
the 61 superseded task rows has an explicit destination; every original acceptance
bullet was checked against the preserved source. All local Markdown links resolve
and changed Markdown formatting/diff whitespace checks passed. No implementation
or historical completion status was changed by this cleanup.

## Host-schema correction during w2/m9

The 1.2.1 host exports public methods absent from SDK 0.1.1. Real item/readOutput
returned bounded stored shell bytes; retrieval is promoted to w2/m11, with only
missing rich-media preservation left in w1/007. Native session/rename accepts
slug names (free-text spaces reject); w2/m10 retains ownership of user titles.
