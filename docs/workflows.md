# Planning and review workflows

The SDK backend offers an adapter-defined `plan` mode and Git review commands.
These use ordinary Muse turns with public `muse serve --disable-write
--disable-shell` enforcement. They are not a native Muse collaboration or review
API. Muse 1.1.1-R2514.1 and SDK 0.1.1 were verified against a local provider.
The exec backend retains its existing modes and skill passthrough.

## Planning

Select ACP mode `plan`, or send `/plan <objective>`. `/plan` without an objective
confirms the mode locally without starting a model turn. Attached task content
starts a planning turn even when the command itself has no inline objective. Subsequent prompts
carry a planning instruction and keep workspace file writes and shell execution
disabled. Prompt text and steering cannot remove those host flags.

Implementation requires an explicit client `session/set_mode` selection of
`default` (or another offered mode). Transitions involving planning are rejected
while a foreground or host-owned turn is running. The next turn uses a host with
the selected flags; changing mode itself never starts implementation or grants a
pending permission. Default mode retains ACP approval gating and the OS sandbox.

Explicit SDK mode selections, including read-only, persist in adapter-owned
preferences and restore on load/resume. They coexist with reasoning-effort
preferences without rewriting native Muse logs. Other Muse clients do not read
these adapter-only preferences.

Planning and review currently require no session or globally configured MCP
servers. Workspace read-only flags do not establish restrictions on external MCP
effects. The adapter checks the isolated host configuration again before use and
fails explicitly if MCP settings changed. These workflows do not claim to prevent
Muse's own goal, memory or session bookkeeping; they constrain workspace writes
and shell execution. Native goal lifetime remains governed by the existing host
retention and [goal contract](goal-extension.md).

## Command input and editor context

A command may lead any top-level text block; preceding editor resources or task
text no longer hide it. Other text, resource links, embedded text and supported
images stay in their original order. Resource bodies, quotes and code fences are
not parsed as commands. Repeated identical operations combine into one turn.
Mixed operations containing `/plan` are handled only as a planning request;
other conflicting commands receive guidance without executing either operation.

`/review [focus]` accepts review instructions; branch and commit variants accept
`[ref] [focus]`. Missing commit references use HEAD. Missing branch references use
the configured upstream; if it cannot be resolved, provide `/review-branch <ref>`.
References beginning with `-` remain invalid. Review context supplements the Git
snapshot rather than replacing it. Existing MCP exclusions and permission gates
still apply. Unknown slash names and skills are passed through as prompts; a
successful prompt does not establish that a native control operation happened.

## Reviews

| Command                | Snapshot submitted to Muse                                              |
| ---------------------- | ----------------------------------------------------------------------- |
| `/review`              | Staged diff, unstaged diff and untracked text files, labeled separately |
| `/review-branch <ref>` | HEAD changes since its merge base with the resolved reference           |
| `/review-commit <ref>` | The resolved commit's Git show output                                   |

References are passed as arguments and resolved to commits, never interpolated
into shell commands. External diff/text-conversion programs are disabled. Reads
have deadlines and the serialized snapshot must fit within 256 KiB. Untracked
binary files, symlinks, invalid targets and oversized snapshots fail explicitly.
Tracked binary files receive Git's binary-change summary; their contents are not
decoded for semantic review. Concurrent worktree edits can change what a later
review sees; each prompt contains the captured data rather than a live diff.

Review uses a read-only host for that turn and does not change the selected
session mode. The next ordinary prompt restores that mode's host configuration.
Findings arrive as normal assistant output, with no fabricated native review
result. The adapter neither edits files nor commits review changes.

Clients may opt in with `clientCapabilities._meta["muse/review"] = 1`;
initialize responds `_meta["muse/review"] = {"version":1}`. Session-info updates
contain `_meta["muse/review"] = {reviewId, target, status}`, with a unique review
ID, target `workingTree`, `branch` or `commit`, and status `started`, `completed`,
`cancelled` or `failed`. Closing/disposal ends observation; no late update is sent
to a removed session. Baseline clients receive ordinary ACP prompt results.
Invalid snapshot preparation fails before review execution starts.

## Permission presentation

`clientCapabilities._meta["muse/approval"] = 1` negotiates observation metadata;
initialize responds `_meta["muse/approval"] = {"version":1}`. Permission requests
then include `_meta["muse/approval"]` with observed `judgeEscalated`,
`reviewerReason` (Muse 1.4.14+), `protectedWrite`, subject kind and stage position/count, requirement ID and
resolution kind when supplied. Unknown kind strings are preserved. Missing
provider-specific reviewer information remains absent.

Observed durable final decisions arrive through session-info
`_meta["muse/approval"]` with approval/turn IDs, decision, resolver and stage
evidence. Request and final stage fields use the same projection. This metadata
never settles an approval. Only the live host-offered choice ID and current
requirement can authorize work; dismissal, stale choices and cancellation retain
the existing fail-closed behavior. Baseline permission options and their real
scope metadata are unchanged. There is no invented reviewer queue or Codex-only
permission choice.

## Validation

`workflows-live.test.ts` proves write and shell denial in planning even when a
client selects an offered allow choice, restoration, explicit
transition into implementation, denied review writes, exact review inputs and unchanged worktree
state. `muse-sdk-approval-live.test.ts` verifies negotiated metadata alongside
actual allow/deny gating. Both run in required loopback CI without paid requests.
Wire, binding, permission and review tests cover active-turn transitions, MCP
rejection, cancellation during initial status delivery, final decisions, reference
validation and bounded file reads, including growth after stat. All command names
are reserved ahead of discovered skills in SDK sessions.

Muse 1.1.1-R2514.1 may reject durable approval settlement while a planning tool
is being denied (`MSP -32603`, retained acknowledgement records unflushed). The
adapter reports a failed prompt and closes that host; it does not replay the
turn or assume approval succeeded. Planning acceptance checks both successful
denial turns and this fail-closed result, verifies that neither write nor shell
markers exist, then requires successful implementation only after an explicit
mode change. Normal implementation and review acceptance still require success.
