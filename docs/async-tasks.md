# Workflow and background task visibility

SDK clients receive stable tool cards for workflow, subagent and reminder-child
items. Public child IDs, attempt numbers, status and bounded result text retain
attribution. Child usage is separate from root usage; native child history is
not invented or opened through private storage.

A completed prompt does not complete a running shell or workflow. The retained
host keeps translating its public item revisions and accumulated output after
the foreground turn ends. Duplicate revisions and catch-up snapshots do not
repeat terminal updates. Host retention remains bounded (60 seconds idle / 32
successful turns). If the host closes while work is unresolved, cards explicitly
report an unknown outcome. ACP has no unknown tool status, so this uses `failed`
with explanatory text, rather than fabricating a native failure or completion.
Load reads latest public task facts; an unfinished historical item is shown as
live-state-unknown and has no live control handle.

## Holding the prompt for background work

Clients may negotiate `clientCapabilities._meta["muse/backgroundHold"] = 1` on the SDK
backend. Initialize then answers `_meta["muse/backgroundHold"] = {"version":1,"wakeSettleMs":3000}`,
and `session/prompt` resolves only once all of these hold:

- no workflow, working subagent, backgrounded tool call or user shell is in progress. That
  covers `task/background` and Muse 1.4.14's `bash` past its `yield_time_ms` (at most
  300000). A paused workflow does not count, since nothing offered here can resume it. A
  subagent whose child session reported (`controlStatus: "resultReady"`) does not count either;
- no host-owned turn is running;
- no approval or user input is pending.

Each turn Muse starts meanwhile, most often the one that reports finished work, becomes
part of the held prompt. Its messages, thoughts, tool calls and plans stream as ordinary
`session/update`s, and the cards of the earlier work keep updating. Its approvals and
questions are real ACP `session/request_permission` and elicitation round trips. The
prompt answers every host request the session raises while it is held, and `MUSE_CODE_ACP_STALL_MS`
bounds them as usual. A reporting turn may launch new work, which is held the same way.
The prompt resolves with the last turn's stop reason; a reporting turn that fails fails
the prompt. While a prompt is held the host is not released, so no idle timer, turn
rotation or unknown-outcome card applies. The client's own deadline remains the bound on
a hold that never settles. A second ordinary prompt during the hold is refused, as for
any prompt in flight.

Muse publishes nothing between a background item's terminal revision and the
`turn/started` of the turn that reports it: on Muse 1.4.14-R7309.1 the two were 32 to 43
ms apart, and `session/statusChanged` stays `idle` in between. So once the session is
quiescent after background work, the prompt waits `MUSE_CODE_ACP_WAKE_SETTLE_MS`
(default `3000`, `0`–`600000`) for such a turn before it resolves. A prompt that started
no background work resolves at once.

`session/cancel` during the hold calls `workflow/cancel` on running workflows and
`task/stop` on running tool calls where the host was verified to accept them (see below),
cancels the running host-owned turn, and resolves `cancelled` once the work has stopped.
The host closes after 5 seconds if it has not, as for a foreground cancel. Goal
controls and native commands such as `/compact` keep their own contract and are not held.
`background-hold-live.test.ts` verifies a held workflow and a backgrounded `bash` on
Muse 1.4.14-R7309.1 in required CI.

Without the capability a prompt resolves when its foreground turn ends, as described
above.

## Task cards and controls

Clients may negotiate `clientCapabilities._meta["muse/asyncTasks"] = 1`.
Task cards then include `_meta["muse/asyncTasks"]` with `kind`, an opaque `target`,
`observedStatus` and `actions`. Only act on advertised actions:

```json
{ "method": "_muse/task", "params": { "sessionId": "…", "target": "…", "action": "cancel" } }
```

On verified Muse 1.2.1, 1.3.0, 1.4.4, 1.4.6, 1.4.7, 1.4.8, 1.4.11, 1.4.12 and 1.4.13, running workflows advertise `cancel`. On Muse 1.4.6 a workflow child refuses to start when the session effort is `none` (`workflow_child_route_effort_unsupported`); choose a supported effort. The adapter calls
public `workflow/cancel` with the exact observed workflowRunId, through the SDK
connection; SDK 1.3.0 declares the method, and Muse's public conformance
[transcript](https://github.com/meta-models/muse-code-sdk/blob/fbce769ccb75ab971d00e01a00fe076de4c773fc/schema/msp/transcripts/workflow-cancel-round-trip/transcript.ndjson) documents the command and real-host execution verifies it. An
`accepted` response is admission only: the subsequent item terminal is the
outcome. Generation-bound targets cannot operate on replacement hosts or another
ACP session. No provider prompt, process signal or guessed child ID is used.

On Muse 1.4.6 or newer, verified against a real host, cards also offer:

- `pause` on a running, unpaused workflow (`workflow/pause`; the item then reports
  `paused`). A paused workflow offers no actions: Muse 1.4.6 refuses to cancel it
  (`missing_run`), and `workflow/resume` was accepted but never observed to unpause
  the run, so resume is not offered.
- `background` on a running foreground tool call (`task/background`): the prompt ends
  while the tool keeps running, and the card switches to `stop`.
- `stop` on a backgrounded tool call (`task/stop`); the item then ends cancelled.
  When a background task ends, Muse starts its own turn to report it; ordinary
  prompts wait for that host-owned turn.

`/tasks` lists the session's running tasks through `task/list` without a model
request. `task/stopAll` is not exposed (only observed over an empty set). Muse's
refusals are reported as `Muse rejected <method>: <reason>`.

Other hosts show observed workflow cards without `cancel`. Muse 1.1.1 has no
verified workflow lifecycle/control delivery; public shell and
reminder cards still work. A workflow tool result alone is not proof of an
observable controllable workflow. `workflow/childControl` rejected the observed
child target in the 1.2.1 probe, so it is not advertised. Direct native child
controls/history remain [w1/005](../.pm/UPSTREAM_DEPENDENCIES.md#child-sessions). The provider's `work_stop` and
`bash_input` tools do not constitute a direct MSP task-control API.

SDK types are not the complete host capability index. Export the selected host's
public schema when checking capability absence. Muse 1.2.1 additionally declares
rename, standing reasoning effort, view subscribe and output reads; each still
requires observable behavior checks before adapter advertisement.
