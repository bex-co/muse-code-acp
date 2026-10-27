# ADR003: Muse Code ACP feature parity with Codex ACP

- **Date:** 2026-09-12
- **Status:** Accepted as the parity tracking approach; feature delivery remains per row.
- **Scope:** User-visible ACP behavior, extensions, host integration, and distribution.
- **Muse source snapshot:** `3b268916e294621de845e858ae528aac8373ff28` plus the local work board inspected on this date; package version `0.2.0`.
- **Codex reference snapshot:** `.tmp/codex-acp` at `effb0fe670a49dfbb5071764b5f8a2e3c09e2393`; package version `1.11.0`.
- **Rows reconciled:** 2026-10-26 against adapter `0.11.0`, Muse `1.4.13-R6996.1`, `@muse-code/sdk` `1.4.12` and ACP SDK `1.8.0` ([status note](#status-as-of-2026-10-26-0110)). The Codex reference snapshot is unchanged.

## Context

Muse Code ACP adapts Muse's public SDK/MSP and an explicit legacy exec backend to
ACP. Codex ACP provides a useful reference for editor integration, runtime
visibility, session control, and negotiated extensions. Equivalent provider
capabilities do not automatically produce equivalent ACP behavior: an adapter
must translate, advertise, and validate them.

This document consolidates both source comparisons and their w1 handoffs. It is
a repository implementation snapshot, not a claim about the latest npm release
or a promise that every feature works on every provider or editor. In particular,
the old w1 queues have been split into current w2 delivery and future native
watches. The [dated capability audit](capability-audit.md) supersedes blanket
worker/compaction blockers: 1.2.1 workflow launch succeeds, while durable
compaction rejects on both tested hosts and does not block usage reporting.
Earlier statements that models are static or every SDK turn spawns a new host
no longer describe the current implementation.

## Decision

Track parity by observable behavior and protocol contract, using Codex ACP as a
reference rather than copying provider-specific internals. Prefer standard ACP
fields; document and negotiate extensions where needed. Preserve useful baseline
behavior for clients that do not support an extension.

Public SDK declarations are investigation leads, not proof of host support.
Advertise only implemented behavior supported by the selected backend. Preserve
Muse's sandbox defaults and real host-offered permission choices; never implement
parity by automating the TUI, inventing MSP methods, or replaying an ambiguous turn
through another backend. See [anti-goals](../.pm/DO_NOT_DO.md).

### Reading the matrices

- **Supported:** Implemented for the stated scope; not necessarily identical wire semantics.
- **Partial:** Some behavior exists, with material differences described in the row.
- **Missing:** No corresponding adapter feature; a plan or SDK type does not count.
- **Blocked:** Required host behavior has a recorded failure preventing delivery.
- **Not advertised:** Deliberately absent from the capability contract.

Muse status refers to the default SDK backend unless the row says otherwise.
Codex entries describe the inspected reference checkout, including its experimental
extensions. “Negotiated” does not mean a standard ACP feature or universal client
support. Workstream references identify scheduled scope, not delivery evidence.

## Status as of 2026-10-26 (0.11.0)

The Muse columns below were reconciled on 2026-10-26 against source, the
[changelog](../CHANGELOG.md) through 0.11.0 and the `.pm` board. The Codex column,
the [recorded compaction blocker](#recorded-durable-compaction-blocker) and the
[delivery map](#delivery-map) keep their original dates; where they disagree with
a row, the row is current. Owner references now use these forms:

- **Delivered:** the archived milestone that shipped it (`w1/done`, `w2/done`,
  `w3/done`). Old w1 milestone numbers that were split on 2026-09-14 (m9, m11,
  m14, m15, m17, m20, m21, m23) point to their w2 replacements through the
  [ownership ledger](../.pm/ownership-2026-09-14.md).
- **Planned:** an open board note (for example [w3/010](../.pm/w3/done/010.md)).
  A note is scope, not a commitment or delivery.
- **Upstream-blocked:** a row in [upstream dependencies](../.pm/UPSTREAM_DEPENDENCIES.md),
  by Muse issue number where one exists, plus its w1 future watch.
- **Non-target:** a shared absence or editor-owned behavior the reference does not
  establish either. The original audio, standalone SSE / ACP MCP transport and
  editor-owned filesystem/terminal RPC decisions are unchanged.

Since the 2026-09-12 snapshot, delivered rows include goal controls (Muse 1.4.6+),
task/workflow controls (1.4.6+), `/recap`, native rename sync, skill activation and
import, `/feedback`, `/plugins` and `/hooks` (1.4.7+), native usage in `/status`
(1.4.7+), `/compact` (1.4.12+), stored-output reads (1.2.1+), configuration
recommendations and background host prewarm. Watches [w1/002](../.pm/w1/done/002.md)
(goal controls) and [w1/004](../.pm/w1/done/004.md) (compaction) are therefore met;
closing them is [w3/014](../.pm/w3/done/014.md). Newer-host features stay gated by
version in `src/muse-host.ts`.

## Prompts and configuration

| Feature                                          | Codex ACP reference                         | Muse Code ACP                    | Parity limit / work                                                                                                                                                                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text prompts and streamed assistant text         | Supported                                   | Supported                        | Baseline behavior on SDK and exec.                                                                                                                                                                                                                                                  |
| Multiple turns with retained conversation        | Supported                                   | Supported                        | Native Muse history retained; reload and restart coverage exists.                                                                                                                                                                                                                   |
| Resource links                                   | Supported                                   | Supported                        | Muse encodes attributed links as text and never fetches URIs during conversion.                                                                                                                                                                                                     |
| Embedded text / unsaved editor context           | Supported                                   | Supported                        | [w1/m8][w1m8] delivered; attributed JSON, 64 KiB aggregate serialized embedded-context limit.                                                                                                                                                                                       |
| Embedded binary resources                        | Encodes blobs, with image-specific handling | Partial                          | [w2/m10][w2m10] delivered attributed images and bounded explicitly encoded binary bytes; semantic document decoding and video MIME types remain unsupported.                                                                                                                        |
| Image prompts                                    | Supported                                   | Supported                        | Muse accepts PNG/JPEG/GIF/WebP; SDK preserves mixed-block order. Exec stages images separately and requires accompanying text/context.                                                                                                                                              |
| Audio prompts                                    | Not advertised; conversion rejects audio    | Not advertised; rejected         | Non-target: shared limitation, not a Codex parity gap.                                                                                                                                                                                                                              |
| Additional workspace directories                 | Supported                                   | Missing                          | All lifecycle entries reject extra roots ([w2/m6][w2m6]). Planned: [w3/013](../.pm/w3/done/013.md) verifies Muse 1.4.12 public `workspaceRoots` enforcement; future watch [w1/008](../.pm/w1/done/008.md).                                                                          |
| Model configuration                              | Supported                                   | Supported                        | [w2/m5][w2m5]: provider-qualified and profiled catalogs; idle changes use isolated settings and an explicit setter even when resume metadata already agrees. Verified on the provider wire.                                                                                         |
| Runtime model discovery                          | Supported                                   | Supported                        | Public `model/list`; `/models` refreshes before inference. Since 0.11.0 the prewarmed host publishes the catalog without `/models` ([w3/m20][w3m20]).                                                                                                                               |
| Reasoning-effort configuration                   | Supported with model-specific choices       | Supported with limits            | Requested tiers: 1.1.1 omits main effort; 1.2.1 maps none→minimal and ultra→max; `max` offered on 1.3+. Choices follow each model's `model/list` effort variants, with Muse's descriptions; service tiers remain blocked ([w1/010](../.pm/UPSTREAM_DEPENDENCIES.md#service-tiers)). |
| Fast/service-tier mode                           | Supported                                   | Missing                          | Upstream-blocked: Muse exposes no service tiers ([upstream row][upnoissue]; [w1/010](../.pm/UPSTREAM_DEPENDENCIES.md#service-tiers)).                                                                                                                                               |
| Recommended config values                        | Opt-in AIR metadata                         | Supported (negotiated SDK)       | `muse/configRecommendations` marks available model/effort choices with provenance ([w2/m5/t010][w2m5]); advisory only, no automatic selection.                                                                                                                                      |
| Read-only / approval / sandbox modes             | Supported                                   | Supported with limits            | [w2/m4][w2m4]: prompted, automatic once approval/rejection and independent sandbox controls; non-default native policies require 1.2.1+. Native permission profiles on `muse serve` are upstream ([#43][u43]). Exec yolo is separate.                                               |
| Dedicated collaboration/plan mode                | Default/plan configuration and `/plan`      | Supported adapter workflow (SDK) | [w1/m22][w1m22] persists plan mode and enforces read-only host flags. Explicit client mode change required; MCP excluded. See [contract](workflows.md).                                                                                                                             |
| Client-provided model providers / custom gateway | Provider capability and gateway auth        | Supported (negotiated SDK)       | `muse/provider` ([w2/m5/t009][w2m5]) or `MUSE_CODE_ACP_GATEWAY_URL`/`_KEY` isolate explicit gateway settings and bearer credentials; failed endpoints never fall back.                                                                                                              |

Evidence: [prompt conversion](../src/prompt-content.ts),
[configuration](../src/config-options.ts), [discovery](../src/model-discovery.ts),
[ACP capabilities](../src/agent-capabilities.ts), and
[observed m8 support](sdk-migration.md#observed-host-support-m8).

## Session lifecycle and interaction

| Feature                          | Codex ACP reference                                | Muse Code ACP                       | Parity limit / work                                                                                                                                                                                                                |
| -------------------------------- | -------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New session                      | Supported                                          | Supported                           | Muse validates and canonicalizes workspace ownership.                                                                                                                                                                              |
| List sessions                    | Supported                                          | Partial                             | [w1/m19][w1m19]: public 50-session pages and scoped cursors; explicit exec retains store scanning. See [discovery](session-discovery.md).                                                                                          |
| Load session with history replay | Supported                                          | Supported with different internals  | Complete export replay remains explicit; public anchored/snapshot history is not silently treated as a full transcript. 0.11.0 keeps message boundaries ([w3/m20][w3m20]); reminder-card order is [w3/017](../.pm/w3/done/017.md). |
| Resume without replay            | Supported                                          | Supported                           | Refreshes MCP configuration and restores model/effort. After `/compact`, Muse reports a finished turn as active ([#121][u121], worked around) and skips MCP startup ([#112][u112], not worked around).                             |
| Close and release resources      | Supported                                          | Supported                           | Cancels work and releases host/state; does not delete native history.                                                                                                                                                              |
| Delete session                   | Supported                                          | Missing                             | Upstream-blocked: no public MSP deletion ([#51][u51]; 1.4.12 `session/leave` only releases). Future watch [w1/012](../.pm/UPSTREAM_DEPENDENCIES.md#root-session-deletion).                                                         |
| Fork session                     | Supported                                          | Supported with host limits (SDK)    | [w1/m12][w1m12]; see [semantics](session-fork.md). Upstream: Linux forks fail on 1.4.12+ ([#120][u120]), Windows ([#31][u31]), earlier boundaries on ≤1.4.11 ([#97][u97]); compacted sources [w3/016](../.pm/w3/README.md).        |
| Live titles / rename / metadata  | Title updates, generated fallback and `/rename`    | Supported with limits               | Observed metadata and bounded first-prompt fallback ([w1/m19][w1m19]); persistent adapter titles ([w2/m10][w2m10]) synced to native `session/rename` on 1.4.7+ ([w3/m11][w3m11]); `/recap` on 1.4.7+.                              |
| Cancellation                     | Supported                                          | Supported                           | Permission/elicitation cleanup and late-reply protection exist.                                                                                                                                                                    |
| Mid-turn steering                | Codex steering contract; handles active/idle cases | Supported with a different contract | [w1/m10][w1m10] Muse-specific negotiation and exact active-turn targeting; [w2/m10][w2m10] also accepts negotiated `_session/steering` for active turns. No idle fallback; idle requests reject.                                   |
| Reusable execution host          | Persistent app-server integration                  | Supported                           | [w1/m10][w1m10] session-owned reuse; 0.11.0 prewarms on open/restore/fork ([w3/m20][w3m20]). Slow `muse serve` init is upstream ([#11][u11]); concurrent load is [w2/014](../.pm/UPSTREAM_DEPENDENCIES.md#startup-latency).        |
| Form elicitation                 | Supported                                          | Supported with limits               | Muse single/multiple selections and free text up to 500 characters; requires client form capability.                                                                                                                               |
| URL elicitation                  | Supported, including auth flows                    | Missing                             | Upstream-blocked: `UserInputQuestion` has no URL fields on 1.4.12 ([upstream row][upnoissue]). Future watch [w1/009](../.pm/UPSTREAM_DEPENDENCIES.md#url-elicitation).                                                             |

Muse steering requires `clientCapabilities._meta["muse/steering"] = 1` and uses
`_muse/steer` with `expectedTurnId`. Acceptance is admission, not completion or a
guarantee that another provider call will occur. A compatible host expires after
60 seconds idle or rotates after 32 successful turns. Configuration, credentials,
workspace, mode, or MCP changes can require replacement. See
[host lifecycle and steering](sdk-migration.md#session-owned-hosts-and-steering),
[steering protocol](../src/steering-protocol.ts),
[session store](../src/session-store.ts), and [elicitation](../src/muse-user-input.ts).

## Runtime visibility, tools and review

| Feature                                        | Codex ACP reference                                 | Muse Code ACP                    | Parity limit / work                                                                                                                                                                                                         |
| ---------------------------------------------- | --------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool lifecycle, arguments and text results     | Supported                                           | Supported                        | Muse correlates tool IDs, revisions and completion-only items.                                                                                                                                                              |
| Live terminal/tool-output deltas               | Supported with terminal presentation modes          | Partial                          | [w2/m7][w2m7]: deltas preserve call IDs; bounded snapshots and explicit unavailable media/reference fallbacks. Full stored shell output is readable on 1.2.1+ ([w2/m11][w2m11]).                                            |
| Rich tool-output images, links and artifacts   | Supported, including image view/generation          | Missing                          | Input images do not imply output artifacts. Original w1/m17 split: [w2/m7][w2m7] labels flattened media; native preservation is upstream ([upstream row][upnoissue]; [w1/007](../.pm/UPSTREAM_DEPENDENCIES.md#rich-media)). |
| Web-search-specific presentation               | Specialized search/action mapping                   | Partial                          | [w2/m10][w2m10] maps search/web_search to search cards with bounded public pattern/query titles; Muse 1.4.6+ `webSearch` items render as generic cards. Output remains observed text.                                       |
| File paths and edit presentation               | Supported                                           | Partial                          | Muse reports recognized paths; SDK diffs use bounded observed states, and exec retains result text.                                                                                                                         |
| Accurate before/after diffs                    | Structured file-change mapping                      | Partial                          | [w1/m13][w1m13] uses working-tree/approval observations and explicit concurrency limits; unknown preimages are not fabricated.                                                                                              |
| Per-turn file-change report                    | Negotiated report with completeness/uncertainty     | Supported with partial coverage  | [w1/m13][w1m13] reports recognized native file-tool declarations; shell/generated/child completeness stays unknown. See [contract](file-change-report.md).                                                                  |
| Review commands / review events                | `/review`, `/review-branch`, `/review-commit`       | Supported adapter workflow (SDK) | [w1/m22][w1m22] captures bounded Git snapshots for ordinary read-only Muse turns and negotiated review status. No native review API claimed.                                                                                |
| Plan/todo updates                              | Supported                                           | Supported with limits            | [w2/m7][w2m7] maps complete native todo snapshots to ACP plans, including empty clears.                                                                                                                                     |
| Reasoning summaries/thought chunks             | Supported                                           | Supported with limits            | [w2/m7][w2m7] streams only public summary parts. No private reasoning.                                                                                                                                                      |
| Token usage                                    | Supported                                           | Supported with limits            | [w2/m7][w2m7] forwards authoritative root totals through negotiated metadata and `/status`; no child summation.                                                                                                             |
| Context usage/pressure                         | Context-window and compaction reporting             | Supported with limits            | [w2/m7][w2m7] reports known context values; missing window size remains unknown.                                                                                                                                            |
| Explicit compaction and lifecycle              | `/compact` and compaction events                    | Supported on Muse 1.4.12+        | `/compact` over `session/compact` with ACP `compaction_update` ([w3/m9][w3m9]). Loopback providers are refused; after-compaction defects are upstream ([#121][u121], [#112][u112], [#79][u79]).                             |
| Worker/workflow lifecycle cards                | Native and legacy fallback presentation             | Supported (SDK)                  | [w2/m9][w2m9] stable public cards and retained background updates; 1.4.13 reminder children are named or hidden ([w3/m20][w3m20]). Child history stays upstream ([#13][u13]).                                               |
| Native child sessions, histories and approvals | Negotiated child sessions and root-routed approvals | Blocked                          | Upstream: child reads work only for children with a transcript on 1.4.12, resume rejects ([#13][u13]; [w1/005](../.pm/UPSTREAM_DEPENDENCIES.md#child-sessions)). ACP child-session types are still unstable.                |
| Worker controls                                | Reference supports delegated-agent operations       | Supported with host limits       | Workflow cancel on verified hosts ([w2/m9][w2m9]); pause on 1.4.6+ ([w3/m10][w3m10]). Child controls stay unadvertised ([w1/005](../.pm/UPSTREAM_DEPENDENCIES.md#child-sessions)).                                          |
| Background commands beyond prompt completion   | Negotiated async tasks, status and targeted stop    | Supported with limits            | [w2/m9][w2m9] retains output and terminal updates; on 1.4.6+ tools can be backgrounded and stopped, and `/tasks` lists them ([w3/m10][w3m10]). Host loss is unknown.                                                        |
| Persistent goal snapshots                      | Goal extension                                      | Supported (SDK)                  | [w1/m18][w1m18] forwards negotiated public goal observations, restores history and preserves explicit clearing. See [contract](goal-extension.md).                                                                          |
| Goal set/pause/resume/clear                    | Advertised goal actions and `/goal`                 | Supported on Muse 1.4.6+         | `/goal set\|edit\|pause\|resume\|clear` over public `goal/*` ([w3/m8][w3m8]); refusals verbatim; older hosts keep read-only `/goal`. Watch [w1/002](../.pm/w1/done/002.md) is met ([w3/014](../.pm/w3/done/014.md)).        |
| Unknown item kinds / truncation visibility     | Rich event handling and fallbacks                   | Partial                          | [w2/m7][w2m7] renders public unknown kinds and truncation/media fallbacks; [w2/m11][w2m11] adds bounded stored-output reads. SDK 1.4.12 kinds are classified (0.11.0).                                                      |

Evidence: [SDK translator](../src/muse-sdk-events.ts),
[tool presentation](../src/tool-calls.ts), [turn handling](../src/muse-sdk.ts),
and Codex reference documents for
[async tasks](../.tmp/codex-acp/docs/async-tasks.md),
[subagents](../.tmp/codex-acp/docs/subagent-sessions.md),
[goals](../.tmp/codex-acp/docs/goal-extension.md), and
[change reports](../.tmp/codex-acp/docs/agent-file-change-report.md).

### Recorded durable-compaction blocker

The [m9 validation record](../.pm/w1/evidence/2026-09-14-superseded/m9.md) reports two
isolated loopback reproductions on Muse Code `1.1.1-R2514.1`, SDK `0.1.1`, macOS.
After a completed durable turn, public `session/compact` returned MSP `-32030`
with `compaction_unavailable`, including with experimental API negotiation.
This is admission rejection, not accepted compaction, successful noop, or a
completed lifecycle. The same investigation observed a raw token-usage event.

Thus usage is an adapter gap while durable compaction has observed host failure.
Do not generalize this into a claim about every Muse build. A newer supported
host must be tested before updating the row; schema presence and fake-host
success do not resolve this blocker. Fresh m6 probes reproduce the same rejection
on 1.2.1. Native compaction is now w1/004; current usage/output delivery is w2/m7
and has no dependency on that watch.

**Update 2026-10-26:** the blocker held for test providers on 1.1.1–1.4.8 and
still holds for the local loopback provider through 1.4.13 ([upstream row][upnoissue]).
With a real provider, compaction completed, continued and survived restart on
1.4.12 (2026-10-25), so [w3/m9][w3m9] shipped `/compact` for 1.4.12+ in 0.11.0.
The record above is kept as the dated evidence for older hosts.

## Authentication, permissions, MCP and recovery

| Feature                                       | Codex ACP reference                                   | Muse Code ACP                         | Parity limit / work                                                                                                                                                                                                                                                      |
| --------------------------------------------- | ----------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Account/browser login                         | ChatGPT login                                         | Supported for Meta login              | Muse advertises terminal-based login only when the client supports it; provider identities differ.                                                                                                                                                                       |
| API-key authentication                        | Supported                                             | Supported for `META_API_KEY`          | Environment credentials take precedence over stored Muse credentials. Since ACP 1.8.0 a standard agent method that checks the key is set.                                                                                                                                |
| Logout                                        | Supported                                             | Supported with environment limitation | Muse cannot unset an externally exported key.                                                                                                                                                                                                                            |
| Observed auth identity/status                 | Connection-scoped status updates                      | Supported with limits                 | [w2/m8][w2m8] negotiates `muse/authStatus`: configured credentials at initialize/authenticate/logout, observed SDK turn outcomes afterwards. Credential presence is not validity. See [contract](failures.md).                                                           |
| Per-tool interactive permissions              | Supported                                             | Supported on SDK only                 | Host-offered decisions gate operations; one ask per unresolved stage ([w2/m1][w2m1]) with stage-aware titles ([w2/m3][w2m3]). On 1.4.6+ Muse's reviewer approves some calls without a prompt. Exec approvals resolve in Muse; headless stalls are upstream ([#99][u99]). |
| Extended permission scopes / review lifecycle | Detailed permission extension and review presentation | Muse subset supported                 | [w1/m22][w1m22] forwards stage, scope and decision metadata, including reviewer `resolvedBy`, with opt-in; Codex-specific fields absent. Showing reviewer activity while held is planned ([w3/011](../.pm/w3/done/011.md)).                                              |
| Client-provided stdio MCP                     | Supported                                             | Supported                             | Private configuration overlay; merges session servers without modifying global settings.                                                                                                                                                                                 |
| Client-provided HTTP MCP                      | Supported                                             | Supported (SDK)                       | [w1/m16][w1m16] verified Streamable HTTP discovery, authenticated tool invocation and failure handling; exec remains stdio only.                                                                                                                                         |
| Standalone SSE / ACP MCP transport            | Not advertised by reference initialize                | Not advertised                        | Non-target: do not count a shared absence as a missing Codex feature.                                                                                                                                                                                                    |
| MCP connection/tool diagnostics               | `/mcp` reports tools/resources/auth status            | Partial                               | `/mcp` reports inventory and sanitized last-observed startup failure. Live state is upstream-blocked: 1.4.12 `mcpServer/list` has config and auth facts only ([upstream row][upnoissue]; [w1/003](../.pm/UPSTREAM_DEPENDENCIES.md#mcp-status)).                          |
| Structured failure categories                 | Transport/auth/rate/quota/overload and recovery hints | Partial                               | [w2/m8][w2m8] preserves native kinds, retryability, provenance and recovery hints; transport outcomes remain unknown. See [contract](failures.md).                                                                                                                       |
| Retry progress                                | Rich error/recovery presentation                      | Missing                               | Muse 1.4.8+ emits `turn/modelRetryScheduled` (classified, not shown); planned as ACP `Notice` in [w3/010](../.pm/w3/done/010.md), meeting watch [w1/006](../.pm/w1/done/006.md). [w2/m8][w2m8] forwards retryability without replay.                                     |
| Account quota/rate-limit state                | Rate-limit/quota metadata                             | Supported with limits                 | `/status` shows Muse `usage/read` tier and window/weekly usage on 1.4.7+ ([w3/m13][w3m13]). Authoritative quota and rate limits are upstream ([upstream row][upnoissue]; [w1/011](../.pm/UPSTREAM_DEPENDENCIES.md#rate-limits), [w3/014](../.pm/w3/done/014.md)).        |
| Lost-event / host-failure handling            | History reconstruction and typed failure handling     | Supported with differences            | SDK gap fill, failing unrecoverable turns without silent replay; structured recovery delivered by [w2/m8][w2m8] and startup failures by [w2/m12][w2m12].                                                                                                                 |

Evidence: [authentication](../src/auth.ts), [permissions](../src/muse-permissions.ts),
[approval reconciliation and stall bounds](sdk-migration.md#multi-stage-approvals-and-stall-bounds-w2m1),
[MCP overlay](../src/mcp-overlay.ts), [MCP contract](mcp-passthrough.md),
Codex [auth status](../.tmp/codex-acp/src/AuthStatusMeta.ts), and
[permission extension](../.tmp/codex-acp/docs/permission-extension.md).

## Commands, distribution and verification

| Feature                                                   | Codex ACP reference                                   | Muse Code ACP                         | Parity limit / work                                                                                                                                                                                                     |
| --------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skills as slash commands                                  | Supported                                             | Supported                             | Muse advertises CLI-discovered skills once per name and passes prompts through.                                                                                                                                         |
| `/status`, `/compact`                                     | Built-in handlers                                     | Supported; `/compact` on 1.4.12+      | `/status` ([w2/m7][w2m7], native usage [w3/m13][w3m13]); `/compact` ([w3/m9][w3m9]). A skill with the same name is not an adapter-owned handler.                                                                        |
| `/mcp`                                                    | Built-in handler                                      | Supported (SDK inventory)             | Local command; no model execution, connection probe or credential output.                                                                                                                                               |
| `/goal`                                                   | Built-in inspection/control                           | Supported; controls on 1.4.6+         | Inspection [w1/m18][w1m18]; controls [w3/m8][w3m8]. Older hosts advertise no control actions.                                                                                                                           |
| `/skills`, `/logout`, `/rename`, `/plan`, review commands | Built-in handlers                                     | Supported                             | Planning and review [w1/m22][w1m22]; skills/logout/rename [w2/m10][w2m10]; native rename sync [w3/m11][w3m11]; skill enable/disable/import on 1.4.7+ [w3/m12][w3m12].                                                   |
| `/recap`, `/feedback`, `/tasks`, `/plugins`, `/hooks`     | No equivalent in the reference snapshot               | Supported on Muse 1.4.6/1.4.7+        | Added 2026-10-26 for Muse-native commands: `/tasks` [w3/m10][w3m10]; `/recap` [w3/m11][w3m11]; `/feedback` [w3/m12][w3m12]; plugin/hook listing and local install [w3/m14][w3m14]. Marketplace management unadvertised. |
| npm CLI and executable override                           | Supported                                             | Supported                             | Muse requires separately installed `muse`; Codex package includes its compatible CLI dependency.                                                                                                                        |
| Standalone platform binaries                              | Build/package scripts for multiple platforms          | Apple Silicon macOS supported locally | [w1/m24][w1m24] adds Node-based standalone build and real-host installation smoke; Muse stays external. Other native targets are unverified. See [scope](standalone.md).                                                |
| Release automation                                        | Stable/preview and registry workflows                 | Partial / different policy            | Muse CI-gated release publishing exists; reference preview/registry distribution is not a claimed parity target.                                                                                                        |
| Contract and real-host testing                            | Event/wire and opt-in end-to-end suites               | Supported with different coverage     | Unit/wire, sandboxed loopback, restart, approval and package smoke suites; CI runs loopback on 1.1.1 and 1.4.13 with gated suites required ([w3/m16][w3m16], [w3/m20][w3m20]). Not proof of every reference feature.    |
| Editor-owned filesystem/terminal execution                | Not established as a general reference guarantee here | Not implemented by Muse               | Non-target: reporting paths, diffs or terminal output is not client-side fs/terminal RPC execution. No parity claim without a specific verified reference contract.                                                     |

Sources: [skills](../src/skills.ts), [package scripts](../package.json),
[CI workflow](../.github/workflows/ci.yml), and
[Codex commands](../.tmp/codex-acp/src/CodexCommands.ts).

## Delivery map

The [w1 board](../.pm/w1/README.md) owned task status and dependencies on
2026-09-12. The snapshot column is that dated summary; the current column follows
the 2026-09-14 [ownership ledger](../.pm/ownership-2026-09-14.md) and later board
history.

| Milestone | Scope                                                                      | Snapshot status (2026-09-12)                                         | Current owner (2026-10-26)                                                                                                                          |
| --------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| m7        | Shutdown, workspace ownership, content metadata and lifecycle combinations | Done                                                                 | [w1/done/m7](../.pm/w1/done/m7/README.md)                                                                                                           |
| m8        | Embedded text, model discovery and verified support claims                 | Done                                                                 | [w1/done/m8][w1m8]                                                                                                                                  |
| m9        | Usage/context, compaction, plans, summaries, live output and status        | Open; durable compaction blocked                                     | Split: [w2/m7][w2m7] done; compaction [w3/m9][w3m9] done (1.4.12+)                                                                                  |
| m10       | Reusable hosts and negotiated exact-target steering                        | Done                                                                 | [w1/done/m10][w1m10]                                                                                                                                |
| m11       | Worker visibility, child sessions, histories, approvals and controls       | Open; worker host support blocked                                    | Split: [w2/m9][w2m9] and [w3/m10][w3m10] done; child sessions upstream ([w1/005](../.pm/UPSTREAM_DEPENDENCIES.md#child-sessions), [#13][u13])       |
| m12       | Session branching                                                          | Implemented; native fork and restart acceptance                      | [w1/done/m12][w1m12]; host limits upstream ([#97][u97], [#120][u120], [#31][u31]); [w3/016](../.pm/w3/README.md) planned                            |
| m13       | Accurate diffs and per-turn change reports                                 | Delivered: bounded observations and negotiated partial reports       | [w1/done/m13][w1m13]                                                                                                                                |
| m14       | Failure categories, retry progress and truthful authentication state       | Planned                                                              | Split: [w2/m8][w2m8] done; retry notices planned [w3/010](../.pm/w3/done/010.md) ([w1/006](../.pm/w1/done/006.md))                                  |
| m15       | Background command lifecycle and verified targeted controls                | Planned                                                              | Split: [w2/m9][w2m9] and [w3/m10][w3m10] done; child history [w1/005](../.pm/UPSTREAM_DEPENDENCIES.md#child-sessions)                               |
| m16       | Remote MCP and diagnostics                                                 | Done                                                                 | [w1/done/m16][w1m16]; live status upstream [w1/003](../.pm/UPSTREAM_DEPENDENCIES.md#mcp-status)                                                     |
| m17       | Rich tool results and artifacts                                            | Planned                                                              | Split: [w2/m7][w2m7] and [w2/m11][w2m11] done; [w2/m10][w2m10] web search; rich media upstream [w1/007](../.pm/UPSTREAM_DEPENDENCIES.md#rich-media) |
| m18       | Goal state and independently verified controls                             | Observation delivered; controls conditionally unavailable            | [w1/done/m18][w1m18] observation; controls [w3/m8][w3m8] done (1.4.6+)                                                                              |
| m19       | Public/paginated session discovery, history and live metadata              | Delivered: public pages, observed metadata, complete export fallback | [w1/done/m19][w1m19]; titles [w2/m10][w2m10], native rename [w3/m11][w3m11]                                                                         |

Rows explicitly marked without a dedicated task are documented gaps, not new
commitments. This ADR does not silently expand milestones to include all Codex
features, mandate provider-specific functionality, or change board dependencies.

## Consequences and maintenance

- Parity is assessed per surface; avoid a single percentage that treats a custom
  extension, partial mapping, and a verified standard feature as interchangeable.
- Preserve distinctions between input images and output artifacts, plans and plan
  mode, worker sessions and background commands, close and delete, and token usage
  and account quota.
- On delivery, update the relevant row with source/test evidence and host/backend
  limits. A checked board item alone is insufficient when source behavior differs.
- Keep [SDK compatibility](sdk-migration.md), the [capability audit](capability-audit.md),
  [upstream dependencies](../.pm/UPSTREAM_DEPENDENCIES.md) and this inventory
  consistent. Resolve stale prose against implementation plus recorded
  verification, not by repeating old README claims.
- Local `.tmp/codex-acp` links are inspection references and may be absent from an
  installed package. The recorded commit pins the comparison; repository-owned
  source, docs and work items preserve the conclusions independently.
- This documentation change does not run new host acceptance tests. Existing
  evidence is cited above; unverified provider/host surfaces remain explicitly so.

[w1m8]: ../.pm/w1/done/m8/README.md
[w1m10]: ../.pm/w1/done/m10/README.md
[w1m12]: ../.pm/w1/done/m12/README.md
[w1m13]: ../.pm/w1/done/m13/README.md
[w1m16]: ../.pm/w1/done/m16/README.md
[w1m18]: ../.pm/w1/done/m18/README.md
[w1m19]: ../.pm/w1/done/m19/README.md
[w1m22]: ../.pm/w1/done/m22/README.md
[w1m24]: ../.pm/w1/done/m24/README.md
[w2m1]: ../.pm/w2/done/m1/README.md
[w2m3]: ../.pm/w2/done/m3/README.md
[w2m4]: ../.pm/w2/done/m4/README.md
[w2m5]: ../.pm/w2/done/m5/README.md
[w2m6]: ../.pm/w2/done/m6/README.md
[w2m7]: ../.pm/w2/done/m7/README.md
[w2m8]: ../.pm/w2/done/m8/README.md
[w2m9]: ../.pm/w2/done/m9/README.md
[w2m10]: ../.pm/w2/done/m10/README.md
[w2m11]: ../.pm/w2/done/m11/README.md
[w2m12]: ../.pm/w2/done/m12/README.md
[w3m8]: ../.pm/w3/done/m8/README.md
[w3m9]: ../.pm/w3/done/m9/README.md
[w3m10]: ../.pm/w3/done/m10/README.md
[w3m11]: ../.pm/w3/done/m11/README.md
[w3m12]: ../.pm/w3/done/m12/README.md
[w3m13]: ../.pm/w3/done/m13/README.md
[w3m14]: ../.pm/w3/done/m14/README.md
[w3m16]: ../.pm/w3/done/m16/README.md
[w3m20]: ../.pm/w3/done/m20/README.md
[upnoissue]: ../.pm/UPSTREAM_DEPENDENCIES.md#blocked-without-a-public-issue
[u11]: https://github.com/meta-models/muse-code-sdk/issues/11
[u13]: https://github.com/meta-models/muse-code-sdk/issues/13
[u31]: https://github.com/meta-models/muse-code-sdk/issues/31
[u43]: https://github.com/meta-models/muse-code-sdk/issues/43
[u51]: https://github.com/meta-models/muse-code-sdk/issues/51
[u79]: https://github.com/meta-models/muse-code-sdk/issues/79
[u97]: https://github.com/meta-models/muse-code-sdk/issues/97
[u99]: https://github.com/meta-models/muse-code-sdk/issues/99
[u112]: https://github.com/meta-models/muse-code-sdk/issues/112
[u120]: https://github.com/meta-models/muse-code-sdk/issues/120
[u121]: https://github.com/meta-models/muse-code-sdk/issues/121
