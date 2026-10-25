# ADR003: Muse Code ACP feature parity with Codex ACP

- **Date:** 2026-09-12
- **Status:** Accepted as the parity tracking approach; feature delivery remains per row.
- **Scope:** User-visible ACP behavior, extensions, host integration, and distribution.
- **Muse source snapshot:** `3b268916e294621de845e858ae528aac8373ff28` plus the local work board inspected on this date; package version `0.2.0`.
- **Codex reference snapshot:** `.tmp/codex-acp` at `effb0fe670a49dfbb5071764b5f8a2e3c09e2393`; package version `1.11.0`.

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

## Prompts and configuration

| Feature                                          | Codex ACP reference                         | Muse Code ACP                    | Parity limit / work                                                                                                                                                        |
| ------------------------------------------------ | ------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text prompts and streamed assistant text         | Supported                                   | Supported                        | Baseline behavior on SDK and exec.                                                                                                                                         |
| Multiple turns with retained conversation        | Supported                                   | Supported                        | Native Muse history retained; reload and restart coverage exists.                                                                                                          |
| Resource links                                   | Supported                                   | Supported                        | Muse encodes attributed links as text and never fetches URIs during conversion.                                                                                            |
| Embedded text / unsaved editor context           | Supported                                   | Supported                        | m8 delivered; attributed JSON, 64 KiB aggregate serialized embedded-context limit.                                                                                         |
| Embedded binary resources                        | Encodes blobs, with image-specific handling | Partial                          | w2/m10 delivers attributed images and bounded explicitly encoded binary bytes; semantic document decoding remains unavailable.                                             |
| Image prompts                                    | Supported                                   | Supported                        | Muse accepts PNG/JPEG/GIF/WebP; SDK preserves mixed-block order. Exec stages images separately and requires accompanying text/context.                                     |
| Audio prompts                                    | Not advertised; conversion rejects audio    | Not advertised; rejected         | Shared limitation, not a Codex parity gap.                                                                                                                                 |
| Additional workspace directories                 | Supported                                   | Missing                          | One canonical Muse workspace; no verified multi-root mapping or delivery task.                                                                                             |
| Model configuration                              | Supported                                   | Supported                        | Provider-qualified catalogs; idle changes use isolated settings and an explicit setter even when resume metadata already agrees. Both hosts verified on the provider wire. |
| Runtime model discovery                          | Supported                                   | Supported                        | Public `model/list` on execution connections; `/models` refreshes before inference. Session creation uses cached/current choices without a catalog host.                   |
| Reasoning-effort configuration                   | Supported with model-specific choices       | Supported with limits            | Requested tiers: 1.1.1 omits main effort; 1.2.1 maps none→minimal and ultra→max. Model restrictions remain unknown.                                                        |
| Fast/service-tier mode                           | Supported                                   | Missing                          | No verified Muse equivalent; not scheduled separately.                                                                                                                     |
| Recommended config values                        | Opt-in AIR metadata                         | Missing                          | Runtime discovery is not a recommendation contract; no dedicated task.                                                                                                     |
| Read-only / approval / sandbox modes             | Supported                                   | Partial                          | SDK offers prompted, automatic once approval/rejection and independent sandbox controls; native non-default policies require 1.2.1+. Exec yolo remains separate.           |
| Dedicated collaboration/plan mode                | Default/plan configuration and `/plan`      | Supported adapter workflow (SDK) | m22 persists plan mode and enforces read-only host flags. Explicit client mode change required; MCP excluded. See [contract](workflows.md).                                |
| Client-provided model providers / custom gateway | Provider capability and gateway auth        | Supported (negotiated SDK)       | `muse/provider` isolates explicit gateway settings and bearer credentials; failed endpoints never fall back.                                                               |

Evidence: [prompt conversion](../src/prompt-content.ts),
[configuration](../src/config-options.ts), [discovery](../src/model-discovery.ts),
[ACP capabilities](../src/agent-capabilities.ts), and
[observed m8 support](sdk-migration.md#observed-host-support-m8).

## Session lifecycle and interaction

| Feature                          | Codex ACP reference                                | Muse Code ACP                       | Parity limit / work                                                                                                                                                                   |
| -------------------------------- | -------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New session                      | Supported                                          | Supported                           | Muse validates and canonicalizes workspace ownership.                                                                                                                                 |
| List sessions                    | Supported                                          | Partial                             | SDK uses public 50-session pages and scoped cursors; explicit exec retains store scanning. See [discovery](session-discovery.md).                                                     |
| Load session with history replay | Supported                                          | Supported with different internals  | Complete export replay remains explicit; public anchored/snapshot history is not silently treated as a full transcript.                                                               |
| Resume without replay            | Supported                                          | Supported                           | Muse refreshes MCP configuration and restores model/effort; live settings are preserved where applicable.                                                                             |
| Close and release resources      | Supported                                          | Supported                           | Cancels work and releases host/state; does not delete native history.                                                                                                                 |
| Delete session                   | Supported                                          | Missing                             | Close is not delete. No dedicated deletion task; public host support must be established.                                                                                             |
| Fork session                     | Supported                                          | Supported (SDK)                     | m12 verifies native full/explicit history boundaries, model/effort preservation and independent restart continuity. See [semantics](session-fork.md).                                 |
| Live titles / rename / metadata  | Title updates, generated fallback and `/rename`    | Partial                             | List/load/cold-resume/turn updates use observed metadata and bounded first-prompt fallback. w2/m10 adds persistent adapter user titles; native allocated names are distinct.          |
| Cancellation                     | Supported                                          | Supported                           | Permission/elicitation cleanup and late-reply protection exist.                                                                                                                       |
| Mid-turn steering                | Codex steering contract; handles active/idle cases | Supported with a different contract | m10 delivered Muse-specific negotiation and exact active-turn targeting. No idle fallback. w2/m10 also accepts negotiated `_session/steering` for active turns; idle requests reject. |
| Reusable execution host          | Persistent app-server integration                  | Supported                           | m10 delivered session-owned reuse; no sharing between unrelated sessions.                                                                                                             |
| Form elicitation                 | Supported                                          | Supported with limits               | Muse single/multiple selections and free text up to 500 characters; requires client form capability.                                                                                  |
| URL elicitation                  | Supported, including auth flows                    | Missing                             | Muse's current bridge handles form elicitation only; no dedicated task.                                                                                                               |

Muse steering requires `clientCapabilities._meta["muse/steering"] = 1` and uses
`_muse/steer` with `expectedTurnId`. Acceptance is admission, not completion or a
guarantee that another provider call will occur. A compatible host expires after
60 seconds idle or rotates after 32 successful turns. Configuration, credentials,
workspace, mode, or MCP changes can require replacement. See
[host lifecycle and steering](sdk-migration.md#session-owned-hosts-and-steering),
[steering protocol](../src/steering-protocol.ts),
[session store](../src/session-store.ts), and [elicitation](../src/muse-user-input.ts).

## Runtime visibility, tools and review

| Feature                                        | Codex ACP reference                                 | Muse Code ACP                    | Parity limit / work                                                                                                                            |
| ---------------------------------------------- | --------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool lifecycle, arguments and text results     | Supported                                           | Supported                        | Muse correlates tool IDs, revisions and completion-only items.                                                                                 |
| Live terminal/tool-output deltas               | Supported with terminal presentation modes          | Partial                          | SDK tool output deltas preserve call IDs; bounded snapshots and explicit unavailable media/reference fallbacks.                                |
| Rich tool-output images, links and artifacts   | Supported, including image view/generation          | Missing                          | Input images do not imply output-artifact support; m17. Actual image-generation tool availability is provider-dependent.                       |
| Web-search-specific presentation               | Specialized search/action mapping                   | Partial                          | w2/m10 maps search/web_search to search cards with bounded public pattern/query titles; output remains observed text.                          |
| File paths and edit presentation               | Supported                                           | Partial                          | Muse reports recognized paths; SDK diffs use bounded observed states, and exec retains result text.                                            |
| Accurate before/after diffs                    | Structured file-change mapping                      | Partial                          | m13 uses working-tree/approval observations and explicit concurrency limits; unknown preimages are not fabricated.                             |
| Per-turn file-change report                    | Negotiated report with completeness/uncertainty     | Supported with partial coverage  | m13 reports recognized native file-tool declarations; shell/generated/child completeness stays unknown. See [contract](file-change-report.md). |
| Review commands / review events                | `/review`, `/review-branch`, `/review-commit`       | Supported adapter workflow (SDK) | m22 captures bounded Git snapshots for ordinary read-only Muse turns and negotiated review status. No native review API claimed.               |
| Plan/todo updates                              | Supported                                           | Supported with limits            | w2/m7 maps complete native todo snapshots to ACP plans, including empty clears.                                                                |
| Reasoning summaries/thought chunks             | Supported                                           | Supported with limits            | w2/m7 streams only public summary parts; both supported hosts verified. No private reasoning.                                                  |
| Token usage                                    | Supported                                           | Supported with limits            | w2/m7 forwards authoritative root totals through negotiated metadata and /status; no child summation.                                          |
| Context usage/pressure                         | Context-window and compaction reporting             | Supported with limits            | w2/m7 reports known context values; missing window size remains unknown.                                                                       |
| Explicit compaction and lifecycle              | `/compact` and compaction events                    | Supported on Muse 1.4.12+        | `/compact` over `session/compact` (w3/m9); the blocker below held on 1.1.1–1.4.8 test providers.                                               |
| Worker/workflow lifecycle cards                | Native and legacy fallback presentation             | Supported (SDK)                  | w2/m9 stable public cards and retained background updates; child history remains w1/005.                                                       |
| Native child sessions, histories and approvals | Negotiated child sessions and root-routed approvals | Blocked                          | 1.1.1 workflow launch fails; 1.2.1 succeeds. Current lifecycle/controls: w2/m9; inaccessible child history: w1/005.                            |
| Worker controls                                | Reference supports delegated-agent operations       | Supported with host limits       | w2/m9 negotiates exact workflow cancellation on 1.2.1; child controls remain unadvertised.                                                     |
| Background commands beyond prompt completion   | Negotiated async tasks, status and targeted stop    | Supported with limits            | w2/m9 retains output and actual terminal updates; host loss is unknown. Direct shell stop is not a served MSP action.                          |
| Persistent goal snapshots                      | Goal extension                                      | Supported (SDK)                  | m18 forwards negotiated public goal observations, restores history and preserves explicit clearing. See [contract](goal-extension.md).         |
| Goal set/pause/resume/clear                    | Advertised goal actions and `/goal`                 | Controls unavailable             | Read-only `/goal` is supported; no verified public MSP control API, so controls remain unadvertised.                                           |
| Unknown item kinds / truncation visibility     | Rich event handling and fallbacks                   | Partial                          | w2/m7 renders public unknown kinds and truncation/media fallbacks; w2/m11 adds verified bounded stored-output reads on 1.2.1.                  |

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

## Authentication, permissions, MCP and recovery

| Feature                                       | Codex ACP reference                                   | Muse Code ACP                         | Parity limit / work                                                                                                                                                                                                                                                          |
| --------------------------------------------- | ----------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account/browser login                         | ChatGPT login                                         | Supported for Meta login              | Muse advertises terminal-based login only when the client supports it; provider identities differ.                                                                                                                                                                           |
| API-key authentication                        | Supported                                             | Supported for `META_API_KEY`          | Environment credentials take precedence over stored Muse credentials.                                                                                                                                                                                                        |
| Logout                                        | Supported                                             | Supported with environment limitation | Muse cannot unset an externally exported key.                                                                                                                                                                                                                                |
| Observed auth identity/status                 | Connection-scoped status updates                      | Partial                               | Muse checks credential presence, not validity; observed vs configured state is m14.                                                                                                                                                                                          |
| Per-tool interactive permissions              | Supported                                             | Supported on SDK only                 | Host-offered decisions actually gate operations; exec approval policy remains internal to Muse. Multi-stage shell approvals ask once per unresolved stage (w2/m1); w2/m3 titles show host arguments and stage position without an extension, retaining the full raw command. |
| Extended permission scopes / review lifecycle | Detailed permission extension and review presentation | Muse subset supported                 | m22 forwards observed stage, scope and decision metadata with opt-in; unknown stages preserved, Codex-specific fields absent. w2/m1 refreshes that evidence per stage; w2/m3 preserves it while improving baseline titles.                                                   |
| Client-provided stdio MCP                     | Supported                                             | Supported                             | Private configuration overlay; merges session servers without modifying global settings.                                                                                                                                                                                     |
| Client-provided HTTP MCP                      | Supported                                             | Supported (SDK)                       | m16 verified Streamable HTTP discovery, authenticated tool invocation and failure handling; exec remains stdio only.                                                                                                                                                         |
| Standalone SSE / ACP MCP transport            | Not advertised by reference initialize                | Not advertised                        | Do not count a shared absence as a missing Codex feature.                                                                                                                                                                                                                    |
| MCP connection/tool diagnostics               | `/mcp` reports tools/resources/auth status            | Partial                               | /mcp reports inventory and sanitized last-observed startup failure. Current connection state remains unknown; no public status API.                                                                                                                                          |
| Structured failure categories                 | Transport/auth/rate/quota/overload and recovery hints | Partial                               | w2/m8 preserves native kinds, retryability, provenance and recovery hints; transport outcomes remain unknown. See [contract](failures.md).                                                                                                                                   |
| Retry progress                                | Rich error/recovery presentation                      | Missing in Muse                       | Native scheduling remains unobserved on both hosts (w1/006); w2/m8 forwards retryability without scheduling or replay.                                                                                                                                                       |
| Account quota/rate-limit state                | Rate-limit/quota metadata                             | Supported with limits                 | Token usage in m9 and categorized errors in m14 are not account quota reporting. No verified Muse account API or dedicated task.                                                                                                                                             |
| Lost-event / host-failure handling            | History reconstruction and typed failure handling     | Supported with differences            | Muse uses SDK gap fill, fails unrecoverable turns, and never silently replays them; structured recovery improvements in m14.                                                                                                                                                 |

Evidence: [authentication](../src/auth.ts), [permissions](../src/muse-permissions.ts),
[approval reconciliation and stall bounds](sdk-migration.md#multi-stage-approvals-and-stall-bounds-w2m1),
[MCP overlay](../src/mcp-overlay.ts), [MCP contract](mcp-passthrough.md),
Codex [auth status](../.tmp/codex-acp/src/AuthStatusMeta.ts), and
[permission extension](../.tmp/codex-acp/docs/permission-extension.md).

## Commands, distribution and verification

| Feature                                                   | Codex ACP reference                                   | Muse Code ACP                          | Parity limit / work                                                                                                                                          |
| --------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Skills as slash commands                                  | Supported                                             | Supported                              | Muse advertises CLI-discovered skills and passes prompts through.                                                                                            |
| `/status`, `/compact`                                     | Built-in handlers                                     | `/status` built in; `/compact` 1.4.12+ | m9; a skill with the same name is not an adapter-owned handler.                                                                                              |
| `/mcp`                                                    | Built-in handler                                      | Supported (SDK inventory)              | Local command; no model execution, connection probe or credential output.                                                                                    |
| `/goal`                                                   | Built-in inspection/control                           | Inspection supported (SDK)             | m18; no model turn and no advertised control actions.                                                                                                        |
| `/skills`, `/logout`, `/rename`, `/plan`, review commands | Built-in handlers                                     | Partial                                | m22 delivers planning and review handlers. w2/m10 delivers local skills/logout and persistent adapter rename.                                                |
| npm CLI and executable override                           | Supported                                             | Supported                              | Muse requires separately installed `muse`; Codex package includes its compatible CLI dependency.                                                             |
| Standalone platform binaries                              | Build/package scripts for multiple platforms          | Apple Silicon macOS supported locally  | m24 adds Node-based standalone build and real-host installation smoke; Muse stays external. Other native targets are unverified. See [scope](standalone.md). |
| Release automation                                        | Stable/preview and registry workflows                 | Partial / different policy             | Muse CI-gated release publishing exists; reference preview/registry distribution is not a claimed parity target.                                             |
| Contract and real-host testing                            | Event/wire and opt-in end-to-end suites               | Supported with different coverage      | Muse has unit/wire, sandboxed loopback, restart, approval and package smoke suites. This is not proof of every reference feature.                            |
| Editor-owned filesystem/terminal execution                | Not established as a general reference guarantee here | Not implemented by Muse                | Reporting paths, diffs or terminal output is not client-side fs/terminal RPC execution. No parity claim without a specific verified reference contract.      |

Sources: [skills](../src/skills.ts), [package scripts](../package.json),
[CI workflow](../.github/workflows/ci.yml), and
[Codex commands](../.tmp/codex-acp/src/CodexCommands.ts).

## Delivery map

The [w1 board](../.pm/w1/README.md) owns task status and dependencies. These labels
are a dated summary; update links if open milestones are archived.

| Milestone | Scope                                                                      | Snapshot status                                                      |
| --------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| m7        | Shutdown, workspace ownership, content metadata and lifecycle combinations | Done                                                                 |
| m8        | Embedded text, model discovery and verified support claims                 | Done                                                                 |
| m9        | Usage/context, compaction, plans, summaries, live output and status        | Open; durable compaction blocked                                     |
| m10       | Reusable hosts and negotiated exact-target steering                        | Done                                                                 |
| m11       | Worker visibility, child sessions, histories, approvals and controls       | Open; worker host support blocked                                    |
| m12       | Session branching                                                          | Implemented; native fork and restart acceptance                      |
| m13       | Accurate diffs and per-turn change reports                                 | Delivered: bounded observations and negotiated partial reports       |
| m14       | Failure categories, retry progress and truthful authentication state       | Planned                                                              |
| m15       | Background command lifecycle and verified targeted controls                | Planned                                                              |
| m16       | Remote MCP and diagnostics                                                 | Done                                                                 |
| m17       | Rich tool results and artifacts                                            | Planned                                                              |
| m18       | Goal state and independently verified controls                             | Observation delivered; controls conditionally unavailable            |
| m19       | Public/paginated session discovery, history and live metadata              | Delivered: public pages, observed metadata, complete export fallback |

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
- Keep [SDK compatibility](sdk-migration.md) and this inventory consistent. Resolve
  stale prose against implementation plus recorded verification, not by repeating
  old README claims.
- Local `.tmp/codex-acp` links are inspection references and may be absent from an
  installed package. The recorded commit pins the comparison; repository-owned
  source, docs and work items preserve the conclusions independently.
- This documentation change does not run new host acceptance tests. Existing
  evidence is cited above; unverified provider/host surfaces remain explicitly so.
