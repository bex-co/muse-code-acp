# SDK migration — compatibility and ACP support matrix

This adapter defaults to the Muse Code SDK path (`muse serve` via
`@muse-code/sdk`). Set `MUSE_CODE_ACP_BACKEND=exec` for the legacy
`muse exec --json` path. Unknown selectors fail at startup. SDK turn failures
never silently fall back to exec.

## Pins

| Component                  | Version                    | Notes                                             |
| -------------------------- | -------------------------- | ------------------------------------------------- |
| `@muse-code/sdk`           | **0.1.1** (exact)          | Public MuseClient / Session / Connection APIs     |
| `@agentclientprotocol/sdk` | **1.3.0** (exact)          | ACP protocol major `PROTOCOL_VERSION` (= 1)       |
| Muse host (`muse serve`)   | **1.1.1-R2514.1** verified | Default backend; `muse serve --help` must succeed |
| Muse host (`muse exec`)    | **≥ 0.2.1**                | Legacy `MUSE_CODE_ACP_BACKEND=exec` only          |

Verified locally with Muse Code **1.1.1**. Older hosts without `serve`, or hosts
that exit with the experimental SDK tier disabled, fail **before** a model turn
with an actionable upgrade hint (or set `MUSE_CODE_ACP_BACKEND=exec`).

## Rollback

```sh
MUSE_CODE_ACP_BACKEND=exec muse-code-acp
```

## ACP surface (advertised)

| Capability                            | Advertised?                                    | Contract owner                                                                    |
| ------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------- |
| Protocol major 1                      | yes (always returned as our supported version) | `src/acp-agent.ts` initialize + `src/tests/acp-wire.test.ts`                      |
| Prompt: text + resource_link          | baseline (no capability flag required)         | `src/prompt-content.ts`                                                           |
| Prompt: embedded text resource        | yes (`embeddedContext`)                        | attributed text; binary resources rejected                                        |
| Prompt: audio                         | **no**                                         | rejected with invalid params                                                      |
| MCP stdio                             | stdio and HTTP (SDK); SSE not advertised       | `docs/mcp-passthrough.md`                                                         |
| `session/load`, `session/list`        | yes                                            | public paginated list; complete export-based load                                 |
| Auth logout                           | yes                                            | `src/auth.ts`                                                                     |
| Terminal auth method                  | only if `clientCapabilities.auth.terminal`     | `src/auth.ts`                                                                     |
| Interactive permissions (SDK backend) | yes                                            | `src/muse-permissions.ts` + live approval suite                                   |
| Form elicitation (SDK user input)     | yes when client advertises `elicitation.form`  | `src/muse-user-input.ts`                                                          |
| fs / terminal RPC                     | **no**                                         | omitted client caps never invoked                                                 |
| Session fork                          | **yes** (SDK host 1.1.1-R2514.1)               | native history with verified restart continuity; see [branching](session-fork.md) |
| Session delete                        | **no**                                         | unadvertised                                                                      |

## Public SDK API map

| ACP / adapter behavior | Public SDK / MSP API                                                                             | Fallback                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Spawn MSP host         | `spawnMspConnection` + `MuseClient`                                                              | —                                                                                               |
| Handshake / durability | `initialize` + `readSessionDurability`                                                           | fingerprint mismatch is advisory                                                                |
| Start / resume session | `MuseClient.startSession` / `resumeSession`                                                      | missing session (`-32020`) → start; in-use/busy/wrong workspace fail closed                     |
| Approval mode          | `startSession({ approvalMode: "onRequest" })` + resume `setApprovalMode`                         | host default is `promptUnmatched`                                                               |
| Set model              | `Connection.command("session/setModel")`                                                         | facade has no setModel                                                                          |
| Submit turn            | `Session.sendUserTurn`                                                                           | —                                                                                               |
| Stream items / deltas  | `Turn.items()` / `Turn.deltas()` (+ fold catch-up for pre-ack deltas)                            | —                                                                                               |
| Cancel                 | `Connection.command("turn/cancel")`                                                              | close host if cancel fails                                                                      |
| Approvals              | fold `pendingApprovals` (+`latestUpdate`) → ACP `session/request_permission` → `approval/decide` | cancel/deny map to a host-offered deny choice; no fabricated grants; `-32053` re-reads the fold |
| User input             | fold `pendingUserInputs` + `userInput/answer`\|`cancel`                                          | clients without form elicitation cancel and fail the turn                                       |
| View gaps              | Session gap-fill (`view/page`) + `onGapError`                                                    | stalled/failed fill fails the prompt; no extra `turn/start`                                     |

## Retained CLI / store helpers

These stay because public SDK session APIs do not yet provide the required
legacy surface. The **default turn path** uses only the SDK backend.

| Helper                        | Why retained                                                    |
| ----------------------------- | --------------------------------------------------------------- |
| Session store listing         | ACP `session/list` workspace filtering + titles/timestamps      |
| `muse export` history replay  | Complete chronological load when SDK history APIs are absent    |
| `muse login` / logout helpers | Auth surfaces without an SDK credential API                     |
| `muse skills list`            | Slash-command advertisement                                     |
| MCP settings overlay          | Session-owned stdio/HTTP MCP merge; exec retains per-turn stdio |

## Resource-link encoding

MSP `TurnInputPart` only declares `text` \| `image`. ACP `resource_link` blocks
are encoded as ordered text parts:

```text
Resource link: {"name":"notes","uri":"file:///notes.md","size":0}
```

The JSON object preserves name, URI, title, description, MIME type, size,
annotations and opaque metadata. Absent fields are omitted; explicit nulls,
empty strings and zero sizes are retained. JSON escaping keeps quotes and
newlines inside their original field. This replaces the older newline-delimited
encoding. No URI is fetched; the same encoding is used for legacy exec.

## Modes

Legacy echo-provider history requires an explicit selection of a supported provider
model before SDK continuation; the adapter no longer silently changes that provider.

SDK reasoning-effort choices are `none`, `minimal`, `low`, `medium`, `high`,
`xhigh`, `max`, and `ultra`. Unknown selections are rejected, and an unknown
`reasoning_effort` in Muse settings is logged before the default applies. These
are requested tiers: main-provider loopback captures show Muse 1.1.1 omits effort;
Muse 1.2.1 maps `none` to `minimal`, `ultra` to `max`, and passes the other
five unchanged. From Muse 1.3, `max` is its own protocol tier and reaches the
provider as `max`, while `ultra` is gated: with the gate closed, Muse 1.4.3 sends
`xhigh`. Reminder requests are separate and do not prove main-turn effort.
Other versions and per-model restrictions remain unverified. The option description
reports these limits; effort changes preserve the idle host and apply per turn.

Explicit effort and the last successful model/provider selection are saved in
adapter-owned `$XDG_DATA_HOME/muse-code-acp/sessions/` (or
`~/.local/share/muse-code-acp/sessions/`). Restoring preserves this recorded intent;
legacy sessions without a record use public `session/read` metadata, which is host
reported, not a provider-wire observation. Restoring reapplies the recorded selection through the public setter before
another turn. Load/resume restore validated mode and safety choices; fork resets
those safety controls. Muse session logs and global settings are not modified.

Idle model/provider selections replace the execution host with an isolated public
settings overlay. Muse resume metadata may already report the new settings while
execution retains the previous model: the adapter therefore always calls public
`session/setModel` with provider identity and checks public `session/read` before
starting a turn. Actual main-provider captures verify switching on both hosts,
including a reused multi-turn session. Failed admission starts no turn and does
not persist the selection as successfully applied. Config options represent requested
settings; negotiated `muse/sessionState` reports native observations separately.
The overlay remains until its retained host closes; user settings stay intact.
Named profile identity is preserved in discovery and in the selection sent through
`session/setModel`. `model/list` reports the profile per catalog, and on Muse
1.3.0 and 1.4.3 every live provider-catalog row carries it, so profiled rows are
offered and selectable like any other choice. A selection recorded without a
profile (a turn before the catalog arrived, or an earlier adapter version) is shown
as the one catalog row it names; an ambiguous one stays a separate entry.

When Muse settings name no model, a new SDK session starts with the built-in
`muse-spark-1.2` and follows the catalog default while no turn or selection has used
it, which needs a catalog before the first turn (`/models`, or one already
discovered by this agent). A contributor catalog default yields to its listed
non-contributor model, because contributor models may use content for product
improvement. Legacy exec keeps the built-in default.

Form elicitation supports single selections, bounded multiple selections, and
free text up to 500 characters. Invalid responses fail the turn and cancel the
input request. Cancelling a turn never waits for a still-open client dialog.

| Mode              | SDK | Exec | Notes                                                   |
| ----------------- | --- | ---- | ------------------------------------------------------- |
| `default`         | yes | yes  | SDK: ACP permission gating (`onRequest`)                |
| `readOnly`        | yes | yes  | `--disable-write --disable-shell` on serve/exec         |
| `bypassApprovals` | yes | yes  | SDK selects offered approved/once choices; root refused |
| `rejectApprovals` | yes | no   | SDK selects offered denied/abort once choices           |
| `plan`            | yes | no   | Read-only planning; explicit mode change required       |
| `yolo`            | no  | yes  | requires `MUSE_CODE_ACP_ALLOW_YOLO=1`                   |

## Approval and sandbox settings

The mode config option and `session/set_mode` share one implementation. SDK
`bypassApprovals` automatically decides each current stage through public MSP;
it never constructs an ACP permission response, chooses a persistent grant,
answers user input, or overrides host denial. An absent eligible once choice
fails the turn without granting. `rejectApprovals` rejects only genuine pending
requests; it is not equivalent to native `denyUnmatched`.

| Config ID              | Values; default first                                       | Contract                                                                                                    |
| ---------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `nativeApprovalPolicy` | `onRequest`, `promptUnmatched`, `denyUnmatched`, `allowAll` | Requested native policy, independent of automatic decisions; non-default choices require 1.2.1+             |
| `sandbox`              | `enabled`, `disabled`                                       | Shell OS filesystem/network sandbox; disabling requires `MUSE_CODE_ACP_ALLOW_YOLO=1` and non-root execution |
| `sandboxNetwork`       | `proxy-only`, `restricted`, `enabled`                       | Restrict direct network or enable it; broad network refused as root                                         |
| `workspaceWrite`       | `enabled`, `disabled`                                       | Non-shell filesystem tools only; shell may still write                                                      |
| `shell`                | `enabled`, `disabled`                                       | Workspace shell execution                                                                                   |

Network restrictions require an enabled OS sandbox; selecting sandbox-off
disables that containment regardless of the network setting.

`readOnly` and `plan` always disable both shell and non-shell writes regardless
of these settings. Automatic approval does not change sandbox or workspace
trust. SDK yolo remains unavailable; exec yolo retains its combined native semantics.
The requested native policy appears in config options; the host-returned effective
policy is logged separately and sent to clients negotiating `muse/sessionState`.
An accepted native setter alone is not evidence of enforcement.

Real-host probes on macOS establish:

| Native policy     | Muse 1.1.1-R2514.1                                | Muse 1.2.1-R2847.1                                                  |
| ----------------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| `onRequest`       | Known-safe `pwd` runs; unknown write asks         | Same                                                                |
| `promptUnmatched` | Behaves like onRequest in the probe               | Both tested commands ask                                            |
| `denyUnmatched`   | Still asks; adapter rejects non-default selection | Emits a request then policy denial; neither tested command executes |
| `allowAll`        | Still asks; adapter rejects non-default selection | Both tested commands execute without asking                         |

These commands exercise default known-safe and unresolved effects, not an
exhaustive user-rule matching matrix. Automatic once approval and rejection
work on both hosts. Outside-workspace writes remain denied until sandbox-off
is separately selected. Direct loopback HTTP is blocked under proxy-only and
restricted, and succeeds under enabled. Both hosts advertise the same launch
flags; Linux enforcement depends on the OS sandbox. CI uses Ubuntu 22.04 because
its supported Muse bwrap sandbox fails namespace creation under Ubuntu 24.04's
default AppArmor policy. macOS results do not assert parity on other platforms.

Safety changes require an idle session, including no native background turn.
An ongoing approval cannot be made permissive by a concurrent config update.
Cancellation and stale generations cannot grant; MSP `approvalAlreadyResolved`
and stale requirement races do not retry old decisions. A change closes the
retained host before deleting its settings overlay, then the next prompt starts
a host with the new posture. Load/resume restore validated preferences after
workspace ownership checks and reapply current root/opt-in guards. A fork resets
all mode, approval and sandbox preferences. Unsupported selections fail before
mutation or a model turn, with an actionable alternative.

## Test owners / CI profiles

| Profile / suite                      | Covers                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `npm run test:unit`                  | Deterministic fake-MSP/wire contracts; no Muse binary                    |
| `npm run test:muse-loopback`         | Real Muse + loopback: live, approval, multi-stage approval, ACP restart  |
| `npm run test:pack-smoke`            | `npm pack` → clean install → stdio initialize/new/prompt/stream/end_turn |
| `RUN_INTEGRATION_TESTS=true`         | Optional external-provider acceptance (separate from CI)                 |
| `src/tests/session-history.test.ts`  | Export replay completeness / schema reject                               |
| `src/tests/permissions.test.ts`      | MSP→ACP permission mapping, multi-stage reconciliation, fake-host gate   |
| `src/tests/fake-msp.test.ts`         | The fixture's own replay scripts (stage wire shapes and error codes)     |
| `src/tests/pending-watchdog.test.ts` | Stall bound and stalled-host prompt failure                              |
| `src/tests/muse-view-events.test.ts` | View-event classification + host compatibility metadata                  |
| `src/tests/muse-sdk-gap.test.ts`     | Recoverable and failed view/page fills                                   |
| `src/tests/acp-wire.test.ts`         | Spawned `dist/index.js` NDJSON wire                                      |

CI installs the public Linux Muse **1.1.1-R2514.1** artifact and verifies its
pinned SHA-256. Real-host tests run on Ubuntu 22.04: Muse 1.1.1's bundled
Bubblewrap fails to create its loopback namespace under Ubuntu 24.04's default
AppArmor policy (`Failed RTM_NEWADDR: Operation not permitted`). This is a host
sandbox limitation; ACP reports the failed tool result. CI keeps the sandbox
enabled and requires proof that an approved command actually writes its file.
The restart test verifies that provider input includes the prior
conversation and that the saved model/effort survive the ACP process restart.
Publishing resolves the release ref to an immutable commit, runs this same CI
workflow on that commit, and only publishes after all checks succeed. Manual
publishing follows the same checks.

Prompt images are advertised and sent as ordered MSP `image` parts with
`mediaType` and `base64Data`. PNG, JPEG, GIF, and WebP are accepted; malformed
base64 is rejected before a turn starts. Legacy exec stages private temporary
files and requires text or a resource link alongside images.

`session/close` is advertised on both backends. It revokes new prompt admission,
cancels active work, and waits for host and temporary-file cleanup. Closing does
not delete native Muse history. Binding a session and prompting it are serialized.

`session/resume` is advertised on both backends. It requires the original
workspace (symlink-equivalent paths are accepted and canonicalized), refreshes
MCP servers, and emits no history replay. Live mode/config are retained; after
close or restart, the SDK model and saved effort are restored and mode defaults
to `default`. Busy sessions and additional workspace directories are rejected.

SDK image-only prompts are supported and verified against Muse 1.1.1 with the
loopback provider. Legacy exec still requires accompanying text, a resource link or embedded text. New, load and resume all retain canonical workspace directories. Disposal
rejects further session admission and waits for pending bindings, turn cleanup
and command advertisement before returning.

## Runtime discovery and editor context

SDK session creation, load and retained-session resume use an available per-agent
catalog snapshot without starting or waiting for a catalog host. Before a first
turn, use `/models` to refresh choices without inference. Otherwise the next
execution host queries public `model/list` on its existing connection and sends
`config_option_update`; this optional query does not delay submission.

ACP model choices retain model, provider and optional profile identity. Values
with provider identity are opaque `muse-model:` choices; labels identify the
provider. The current configured/restored model remains available when absent
from a catalog. Unavailable, malformed or unsupported results fall back to the
current model. Legacy exec retains its compatibility menu. Explicit custom IDs
retain host validation at submission; ambiguous IDs and stale qualified choices
are rejected. A late catalog never changes the requested execution route.

Standalone `/models` refreshes cache results for 30 seconds, including failures,
in a bounded per-agent cache. Identity includes workspace, binary, environment,
settings and auth content hashes. Borrowed execution catalogs remain session-local
because the execution settings overlay may differ from base configuration.
A ready execution host is reused for `/models`; otherwise the explicit refresh
owns a temporary host and uses the existing startup deadline. Cancel, close and
disposal close owned refresh hosts. Borrowed queries have a five-second deadline
and never close the execution host. Results from closed/replaced sessions or
changed configuration are discarded.

Large Muse history directories can still make native initialization slow. The
adapter removes redundant automatic discovery startup; it does not change the
native data root or make old sessions disappear. See the [startup reproduction](muse-startup-latency.md).

ACP embedded text resources are encoded as a single ordered text part:

```text
Embedded text resource: {"resource":{"uri":"file:///unsaved.ts","mimeType":"text/typescript","text":"unsaved buffer\n"}}
```

JSON preserves the text, URI, optional MIME type, annotations and opaque metadata
without ambiguous field boundaries. No URI is fetched and an on-disk file is not
required. The aggregate serialized embedded context limit is 64 KiB of UTF-8 per
prompt, including attribution and metadata. Empty text is valid attributed context;
binary/blob resources, missing text/URI and oversized context are rejected before
turn submission. ACP's SDK validates/normalizes the wire schema before conversion.
SDK input retains text/resource/image interleaving. Legacy exec preserves text and
resource order in its prompt string; images remain separate ordered `--image` flags.

## Observed host support (m8)

Evidence uses `@muse-code/sdk@0.1.1`, Muse Code 1.1.1-R2514.1 on macOS, isolated
dummy credentials and a local loopback endpoint; no paid provider was called.

| Surface              | Evidence and current adapter behavior                                                                                                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initialize           | Observed server version 1.1.1, schema version 1, durable sessions, empty grantedCapabilities and experimentalApi false. These fields alone do not prove every declared method works.                                                   |
| Model discovery      | `initialize` followed by `model/list {}` returned `bundledCatalog` with configured `fake-model`; provider discovery need not run and nullable catalog metadata is valid. ACP consumes the returned snapshot.                           |
| Effort               | Seven requested tiers: main-provider captures show 1.1.1 omits effort; 1.2.1 maps none→minimal and ultra→max, passing the other five. Per-model restrictions remain unknown.                                                           |
| Embedded context     | ACP resource-only prompt traversed the real SDK/host; captured provider input decoded to the exact unsaved text, URI and MIME attribution.                                                                                             |
| Reasoning summaries  | Public item schema declares `reasoning.summary` and indexed summary deltas. Actual summary events are not yet verified or forwarded; private/encrypted reasoning is not accessed.                                                      |
| Usage/context        | Public schema declares usage/context data. End-to-end ACP reporting is unverified and remains unadvertised until m9.                                                                                                                   |
| Compaction, steering | Public schema declares session/compact and turn/steer. Accepted/terminal lifecycle and provider effects are not verified by m8; implementation remains in m9/m10.                                                                      |
| Subagents, fork      | Public schema declares worker lifecycle/control and session/fork. Worker routing and permission isolation remain unverified m11 work. m12 delivers native forks with independent restart continuity; see [branching](session-fork.md). |

Schema presence is a discovery lead, not delivery evidence. Later milestones must
verify their required host behavior before claiming support. Existing explicit
exec fallback remains user-selected; an ambiguous SDK turn is never replayed
through another backend.

## Session-owned hosts and steering

The SDK backend reuses one host for compatible turns of the same ACP session.
An idle host expires after 60 seconds, and rotates after 32 successful turns to
release its accumulated in-memory fold. Close/dispose, cancellation, host failure
or an unsafe unfinished interaction closes it. Host ownership includes the native
writer lease: close the old ACP session (or allow idle expiry) before another
client takes over that native session. No host is pooled across ACP sessions.

Compatibility includes canonical workspace, binary identity, environment,
settings/auth content, model/provider, mode, safety and MCP server configuration.
Compatible effort updates use the retained host; other supported changes replace it
before the next turn. Model changes require a new idle host and the explicit public setter. Private settings overlays remain available
until their owning host closes, including while idle, then are deleted. Read-only
flags are fixed at process creation. SDK permission/elicitation handlers are scoped
to each turn; late replies cannot answer a later turn. Legacy exec keeps its
existing per-turn lifecycle.

Steering is an opt-in adapter extension. Clients initialize with
`clientCapabilities._meta["muse/steering"] = 1`; the SDK adapter responds with
`_meta["muse/steering"] = {"version":1,"method":"_muse/steer"}`. Unnegotiated
clients and legacy exec retain the existing single-prompt-at-a-time behavior.

After a turn is acknowledged, negotiated clients receive a `session_info_update`
whose `_meta["muse/activeTurnId"]` is the exact native turn ID; a null value clears
it on cleanup. Submit `_muse/steer` with `sessionId`, `expectedTurnId` and `prompt`
(the same supported text/resource/image content as normal prompts). The response
`{"status":"accepted","turnId":"…"}` reports admission, **not completion**.
The original `session/prompt` still owns turn completion. There is no idle-session
fallback to a new prompt, and a stale ID or startup-before-ack request is rejected.

Corrections are serialized per session with the captured turn handle and ID.
At most 16 corrections may wait behind an in-flight acknowledgement; excess
requests are rejected so the queue cannot retain unbounded prompt input.
Replacement, close or cancellation invalidates queued work. A failed correction
is not retried as a new command or prompt; an acknowledgement timeout after ten
seconds closes the host and reports an unknown outcome. Already streamed output
cannot be changed. A turn finishing with an acknowledgement still pending closes
its host before any reuse, so the old request cannot interrupt a subsequent turn.
The host consumes corrections at a subsequent execution/model
boundary, and a turn already returning its final answer may finish without a
further provider call even if steering was admitted.

Evidence on Muse 1.1.1-R2514.1: loopback provider input contained two ordered
corrections during a tool turn, then a second compatible turn retained that history
without another execution-host spawn. No paid provider calls were required.

## Remote MCP (m16)

SDK sessions accept validated HTTP MCP URLs and headers, merged into private
canonical Muse `mcpServers` settings. `/mcp` reports inventory and sanitized
last-observed startup failures locally; current connectivity remains unknown
because the public SDK has no MCP status method. The built-in command reserves
the `mcp` skill name. Legacy exec retains stdio only. See
[MCP configuration, diagnostics and evidence](mcp-passthrough.md).

## Goal observation (m18)

SDK sessions retain observed public goal state after prompts, restore it from
history, and expose local `/goal` inspection without a provider call. Opted-in
clients receive session-info metadata; baseline clients can use the command.
Goal controls are unadvertised because public MSP support is unavailable.
Host-owned turns, retention bounds and foreground prompt controls remain distinct;
see the [goal contract and acceptance evidence](goal-extension.md). Exec is unchanged.

## Planning, reviews and permission presentation (m22)

SDK planning and review turns use verified public read-only host flags. Explicit
mode choices persist across adapter restart; ordinary text cannot transition a
plan into implementation. Git snapshots and MCP exclusions bound the supported
workflow. Review status and public approval-stage metadata are opt-in, with
ordinary ACP output and permission options as the baseline. See the
[workflow contract](workflows.md) for exact commands, limits and real-host evidence.

## Multi-stage approvals and stall bounds (w2/m1)

Muse splits a compound shell command into stages and requires a decision for each
stage that is not already known-safe. On 1.2.1-R2847.1 the host advances such an
approval by REFRESHING it — `approval/decide` answers `terminal: false` and an
`approval/updated` names the next `currentRequirementId` — and never re-issues
`approval/requested`. The pinned SDK routes only the request to `onApproval`
(`facade/session.js` documents the omission), so a router-driven client answers
the first stage and then waits forever. This is the w2/m1 defect.

Stage presentation (w2/m3) is part of ordinary ACP `toolCall.title`: for example,
`Stage 1 of 4: echo one`, then `Stage 3 of 4: echo two`. Arguments, position and
total come from the host's stage matching `currentRequirementId`; the total
includes known-safe stages. The adapter does not split or parse the shell command.
Arguments containing whitespace or special characters are quoted as display text.
Host argv can omit redirections, so the full command stays in `rawInput`.
Single-stage approvals, a sole decision among known-safe stages, and missing
stage evidence retain the original title. Unknown resolution kinds are preserved.
Clients negotiating `muse/approval` still get the same metadata and choices.

This resolves identical prompts for one compound command. Repeated Allow once
prompts for genuinely separate operations remain expected, as recorded in
[w2/003](../.pm/w2/done/003.md); that earlier triage is not reopened.

The adapter therefore decides approvals from the fold rather than from the
router, the way pending user input was already handled:

- The current requirement, offered choices and stage evidence come from
  `latestUpdate` when the host has published one, otherwise from `requested`.
  This covers BOTH host behaviors: a host that re-issues the request replaces the
  fold entry, and a host that refreshes updates it.
- Decisions are keyed by `(approvalId, sourceIndex)`, so each stage is asked
  exactly once and never twice, and independent approvals stay concurrent.
- `requirementId` is echoed from the view the host last published. MSP `-32053`
  (stale requirement) means "re-read the approval", not "the turn failed"; any
  other rejection fails the turn with its MSP code and no host detail.
- Denying any stage submits the host-offered deny or abort choice for that
  requirement. The host aborts the whole pending action, so no earlier stage runs.

`Session.onApproval` is no longer registered for decisions. Two guardrails bound
the class of defect rather than the instance:

- **Stall bound.** A pending approval or user input with no outstanding ACP
  request and no host progress for `MUSE_CODE_ACP_STALL_MS` (default 10 s) fails
  the prompt with the approval id, requirement position, stage evidence and last
  host frame, then asks the host to cancel. An open permission dialog, a slow
  model and a long-running tool are progress and never trip it.
- **Classification.** `src/muse-view-events.ts` names a consumer or a recorded
  reason for every view event the pinned SDK can fold, and a test fails when an
  installed SDK folds a method neither table lists.

Clients receive `_meta["muse/hostCompatibility"]` on `session_info_update` once
per host: pinned and served schema fingerprints, whether they agree, the detected
host version, the minimum supported version and the hosts exercised end to end.
A divergence stays advisory, matching the SDK's own rule.

Verified on 1.2.1-R2847.1 with the loopback provider: two-stage and three-stage
commands ask once per unresolved stage and write every file; denying the second
stage writes nothing and still returns `end_turn`. The complete 28-case loopback
suite also passes locally on the CI-pinned public 1.1.1-R2514.1 macOS artifact.
The launcher cache is not a durable pin; the direct artifact and checksum in CI
allow a separately retained binary.

## Standalone packaging (m24)

Native darwin-arm64 artifacts use Node's executable builder and retain the same
SDK/exec entrypoint, external Muse discovery and override. Required installation
smoke exercises a real loopback prompt with no Node or Bun on PATH. See
[standalone targets, build provenance and distribution scope](standalone.md).

## Session branching (m12)

The SDK backend maps ACP `session/fork` onto public Muse fork. Default history and
negotiated completed-turn boundaries preserve the source workspace, saved model
and effort, with separate MCP inventory and reset default safety mode. Real-host
acceptance verifies history isolation after ACP restart. See [semantics and limits](session-fork.md).

## File-change evidence (m13)

SDK turns can render bounded observed before/after text for recognized writes.
Working-tree snapshots preserve pre-existing user content; unknown preimages,
concurrent mismatches, binary/large files and failed tools retain text fallbacks.
Exec has no verified preimages and no longer labels post-write readback as creation.
The negotiated AIR v1 `agentFileChangeReport` contract reports recognized native
file-tool declarations with `declaredComplete: false`; it does not infer complete
shell/generated/child attribution or launch an audit model turn. See [bounds and wire examples](file-change-report.md).

## Session discovery (m19)

SDK listing uses public, lease-free pages with workspace-bound cursors. Metadata updates preserve deterministic first-prompt title fallback and negotiated fork provenance; full export replay remains intact. Native indexing is eventually consistent. See [discovery and history limits](session-discovery.md).

## Muse 1.2.1 verification (w2/m2)

The supported baseline remains 1.1.1-R2514.1. On 1.2.1-R2847.1, adapter 0.5.0
verifies SDK-created session continuity, staged approvals, and HTTP MCP
success and failure cases. ACP-provided MCP servers set `mode: "required"` in
the private settings overlay; omitting this field lets failed startup resolve a
successful turn on this host. User-configured servers retain their chosen mode.

The remaining host limitation is resuming **legacy-created** sessions whose
saved permission profile is `:auto-review`. Public `session/read` succeeds, but
`session/resume` rejects before loading, and `session/setApprovalMode` then
rejects because the session is not loaded. No public profile override exists.
The error now names that limitation and suggests a new ACP session or continuing
in Muse with reviewer support. Approval and sandbox defaults are unchanged.

Three live tests assert this exact actionable failure on 1.2.1-R2847.1,
1.3.0-R3057.1, 1.3.0-R3401.1 and 1.4.3-R5018.1, and still require successful legacy continuation on 1.1.1. The
affected builds are enumerated, so an unlisted host is expected to continue
successfully; 1.3.0-R3057.1 and R3401.1 were added after they reproduced the same rejection.
R3401.1 and 1.4.3-R5018.1 also refuse the lease-free `session/read` (`resume_refused_class_c`), so
ACP `session/load` itself fails with the same message there. On 1.4.3 `muse exec`
commits the built-in `:auto-review` profile by default, so new exec-backend sessions
are affected too. Their SDK-created session paths
always require successful continuation. Passing these tests does not imply that
the legacy host defect is fixed. See [compatibility](../README.md#requirements-and-compatibility)
and [MCP diagnostics](mcp-passthrough.md#diagnostics). These changes are included in 0.5.0.

## Observed session state (w2/006)

Clients opt in with `clientCapabilities._meta["muse/sessionState"]: 1`; SDK
initialization acknowledges `{ version: 1, reportingOnly: true }`. The adapter
publishes `session_info_update._meta["muse/sessionState"]` with only changed
observations:

```json
{
  "model": { "modelId": "host-selected-model", "providerId": "meta", "source": "policy" },
  "approvalMode": { "mode": "denyUnmatched", "source": "approvalReconfigure" }
}
```

These are host facts, not ACP configuration changes. They do not select a mode,
change the model, offer a choice, or grant permission. Missing fields stay absent;
a host-cleared family is `null`. Source/provider fields are included only when
published. The existing retained-host timer observes latest folded state every
100ms, including idle time, suppresses unchanged values, and waits during gap
recovery. Intermediate changes between samples can coalesce. Host closure stops
observation; a new host reports its own first observations.

For a selected host-offered `localPersistent` rule, the same extension initially
reports `{ "policyPersistence": { "approvalId": "...", "status": "unverified" } }`.
The pinned SDK drops post-resolution `approval/updated` persistence reports.
The adapter therefore reads the public durable view from an observed approval
cursor, at most one 100-event page per second while a rule remains unverified.
A host `policyPersistence` report changes the status to `succeeded` or `failed`;
raw rule text, paths and failure reasons are not forwarded. No persistence is
inferred from an accepted choice or successful tool execution. Missing events,
unknown statuses, unsupported reads and a one-second read timeout leave it
unverified. Failed reads disable further persistence polling for that host.
This is bounded reporting and never fails or replays the model turn.

No observation metadata or additional view reads are sent without negotiation.
The adapter retains `MuseClient` routing and its gap-fill/host-death handling.
Actual model/mode events and durable page reads are exercised on real hosts;
persistence failure handling is verified with a deterministic public-wire fixture,
not by inducing a real user's policy-write failure.

## Explicit client gateways and recommendations

SDK clients may negotiate `clientCapabilities._meta["muse/provider"] = 1` and
supply session new/load/resume metadata:

```json
{
  "_meta": {
    "muse/provider": {
      "providerId": "meta",
      "baseUrl": "http://127.0.0.1:8080",
      "apiKey": "gateway-token"
    }
  }
}
```

This configures Muse's public `endpoint_transport` and bearer credential in an
isolated session environment. Currently only the Meta-compatible transport is
accepted. Separate sessions have separate overlays and credential-sensitive catalog
cache identities. A rejected endpoint never falls back to the default gateway.
The preference store contains only an endpoint fingerprint, never the key; after
close or process restart, supply the same endpoint and credentials again. Idle
resume permits key rotation. Fork inherits an independent overlay; logout closes
bound custom-provider sessions and clears their in-memory credentials. URLs cannot
contain embedded credentials, query parameters or fragments.

An independent opt-in, `clientCapabilities._meta["muse/configRecommendations"] = 1`,
adds recommendations to model/effort config option metadata under that same key.
Recommendations reference displayed choices, identify catalog-default or retained
selection provenance, and always carry `applied: false`. They never overwrite a
selection or infer account tiers, quotas or model restrictions. Unavailable catalogs
retain the current choice; Muse 1.1.1 effort is explicitly marked unavailable.
Baseline ACP clients need neither extension.

## Availability consistency

See the [dated capability audit](capability-audit.md) for public routes, tested
versions, remaining owners and future support triggers. Native policy options
unverified on the current host are omitted from the menu and rejected if sent
directly. This does not hide the independently implemented adapter automatic
approval/rejection modes. Mode errors distinguish unknown values, backend mismatch
and unmet root/opt-in guards; configuration busy errors identify temporary state.

All session new/load/resume/fork requests reject nonempty `additionalDirectories`
before binding or changing an existing session. A separate session is an explicit
alternative, not authorization for another root in the current session.

## Observed progress

SDK sessions now forward complete todo snapshots, public reasoning summaries and
correlated tool output deltas. `/status` reports requested settings and observed
root usage/context without a model request. Optional `muse/usage` metadata carries
host cumulative replacements; standard ACP context updates require a known window
size. No private reasoning, derived quota, fabricated denominator or output bytes
are exposed. See [progress and recovery contract](progress.md).

## Failure and authentication observations

SDK errors preserve host categories and retryability with explicit recovery hints.
The adapter never replays an ambiguous turn. Negotiated `muse/authStatus`
distinguishes configuration from native rejection and successful-turn evidence;
identity remains unknown. See [the contract](failures.md).

## Workflow and background tasks

Public worker cards and background output survive foreground completion while
the host is retained. Negotiated `muse/asyncTasks` exposes only per-task verified
actions, including Muse 1.2.1 workflow cancellation. See [contract](async-tasks.md).

## Input and independent commands

Attributed embedded image/byte resources, local skills/logout/title commands,
compatible active-turn steering and public search titles are documented in
[the command contract](session-commands.md). Semantic document decoding and idle
steering that starts a new turn are not advertised.

See [stored output](stored-output.md) for negotiated byte-range reads on verified Muse 1.2.1, reference lifetime and baseline fallbacks.

SDK initialization and session preparation now have separate configurable budgets; turn acknowledgement and bounded reads have distinct deadlines. See [startup phases and recovery](failures.md#startup-phases-and-deadlines) for environment settings, cancellation and execution certainty.
