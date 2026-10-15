# w3 · m17 — Catch up to ACP SDK 1.8.0 and Muse SDK 1.4.8

**Worker:** worker1 **Goal:** The adapter runs on `@agentclientprotocol/sdk` 1.8.0 and `@muse-code/sdk` 1.4.8, verified on Muse 1.4.8, with an evidence-backed map of the new standard ACP surfaces. **Status:** done

## Tasks (in order)

| id   | title                                                       | est  | depends_on                                         |
| ---- | ----------------------------------------------------------- | ---- | -------------------------------------------------- |
| t001 | Bump the ACP SDK to 1.8.0 — **DONE**                        | 1h   | —                                                  |
| t002 | Bump the Muse SDK to 1.4.8 and verify Muse 1.4.8 — **DONE** | 1.5h | —                                                  |
| t003 | Map the new ACP surfaces to Muse public signals — **DONE**  | 1.5h | w3/m17/t001, w3/m17/t002                           |
| t004 | Adoption surface — **DONE**                                 | 30m  | w3/m17/t001, w3/m17/t002, w3/m17/t003              |
| t005 | Simplify milestone changes — **DONE**                       | 30m  | w3/m17/t004                                        |
| t006 | CI and behavior coverage — **DONE**                         | 45m  | w3/m17/t001, w3/m17/t002, w3/m17/t003, w3/m17/t005 |
| t007 | Close out milestone — **DONE**                              | 15m  | w3/m17/t006                                        |

## Definition of done

- `package.json` pins `@agentclientprotocol/sdk` 1.8.0 and `@muse-code/sdk` 1.4.8 exactly, the lockfile is updated, and `npm run check`, `npm run build`, `npm run test:unit` and `npm run test:pack-smoke` pass.
- `MUSE_CODE_ACP_REQUIRE_MUSE=1 npm run test:muse-loopback` passes on Muse 1.4.8-R6256.1, and the CI baseline leg still passes.
- Existing wire tests pass unmodified, or each change is listed with its justification.
- `docs/capability-audit.md` classifies every ACP schema type added between 1.3.0 and 1.8.0 as implemented, backed, unbacked or deferred, with evidence.

## Source + Goal linkage

- **Source:** 2026-10-15 `/pm-brainstorm` "to improve code quality and ensure it's best muse code acp on the market", materialized by `/pm them all for w3`. On 2026-10-15 npm reported `@agentclientprotocol/sdk` 1.8.0 (pinned 1.3.0) and `@muse-code/sdk` 1.4.8 (pinned 1.4.7); the maintainer host is Muse 1.4.8-R6256.1. Schema `$defs` diff 1.3.0 → 1.8.0: added `CompactionCapabilities`, `CompactionId`, `CompactionStatus`, `CompactionSummaryChunk`, `CompactionUpdate`, `ErrorStopReason`, `IdleStateUpdate`, `McpError`, `McpRequestId`, `Notice`, `NoticeCapabilities`, `NoticeSeverity`, `RequiresActionStateUpdate`, `RunningStateUpdate`, `SessionCancelCapabilities`, `SessionMessage`, `SessionMessageChunk`, `StateUpdate`, `SubagentCapabilities`, `SubagentSessionCapabilities`, `SubagentUpdate`, `UnknownStateUpdate`; removed `AuthEnvVar`, `AuthMethodEnvVar`, `ConnectMcpRequest`/`Response`, `DisconnectMcpRequest`/`Response`, `McpConnectionId` (no `src/` references). Whether the added types are stable or unstable has not been verified.
- **Goal linkage:** Verified public SDK behavior kept current; truthful capabilities against the protocol editors actually speak.
- **Expected outcome:** Users get Muse 1.4.8 host fixes through the adapter, editors on current ACP negotiate against a current schema, and w3/m19 is scoped from evidence.
- **Why now:** The ACP SDK is five minor versions behind, and w3/m19 depends on the upgrade.
- **Adoption surface:** Separate task t004: CHANGELOG Dependencies/Compatibility, README host-version statements and `docs/sdk-migration.md` versions. t003 writes the `docs/capability-audit.md` mapping as implementation.
- **Constraints:** Exact pins; feature detection and documented schema compatibility (DO_NOT_DO); no invented MSP methods; new Muse items render as generic cards unless verified.

## Validation evidence

2026-10-15. `@agentclientprotocol/sdk` 1.8.0, `@muse-code/sdk` 1.4.8.

- Muse 1.4.8-R6256.1 loopback suite, all capabilities required: 21/21 files, 68/68 (65/68 at `adae363` before this milestone). GitHub CI [run 38724727770](https://github.com/bex-co/muse-code-acp/actions/runs/38724727770) on the identical tree: 1.4.8 leg 68/68, 1.1.1 leg 63 + 5 capability skips, build and standalone green.
- `npm run check`, `build`, `test:coverage` (510/510), shuffled run, `test:pack-smoke`: passed.
- Wire changes, both deliberate: the API-key auth method is now a standard agent method (ACP removed `env_var`); an incoming message over the SDK's 32 MiB limit now exits 1 with the reason instead of exiting 0 silently.
- Findings routed elsewhere: `turn/modelRetryScheduled` observed on 1.4.8 (new inbox w3/010, w1/006 trigger met); ACP 1.8 state/stop-reason types are unstable child-session types, so w3/m19's premise does not hold (t003).
