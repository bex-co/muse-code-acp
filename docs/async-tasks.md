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

Clients may negotiate `clientCapabilities._meta["muse/asyncTasks"] = 1`.
Task cards then include `_meta["muse/asyncTasks"]` with `kind`, an opaque `target`,
`observedStatus` and `actions`. Only act on advertised actions:

```json
{ "method": "_muse/task", "params": { "sessionId": "…", "target": "…", "action": "cancel" } }
```

On verified Muse 1.2.1, 1.3.0 and 1.4.4, running workflows advertise `cancel`. The adapter calls
public `workflow/cancel` with the exact observed workflowRunId, through the SDK
connection; SDK 1.3.0 declares the method, and Muse's public conformance
[transcript](https://github.com/meta-models/muse-code-sdk/blob/fbce769ccb75ab971d00e01a00fe076de4c773fc/schema/msp/transcripts/workflow-cancel-round-trip/transcript.ndjson) documents the command and real-host execution verifies it. An
`accepted` response is admission only: the subsequent item terminal is the
outcome. Generation-bound targets cannot operate on replacement hosts or another
ACP session. No provider prompt, process signal or guessed child ID is used.

Other hosts show observed workflow cards without `cancel`. Muse 1.1.1 has no
verified workflow lifecycle/control delivery; public shell and
reminder cards still work. A workflow tool result alone is not proof of an
observable controllable workflow. `workflow/childControl` rejected the observed
child target in the 1.2.1 probe, so it is not advertised. Direct native child
controls/history remain [w1/005](../.pm/w1/005.md). The provider's `work_stop` and
`bash_input` tools do not constitute a direct MSP task-control API.

SDK types are not the complete host capability index. Export the selected host's
public schema when checking capability absence. Muse 1.2.1 additionally declares
rename, standing reasoning effort, view subscribe and output reads; each still
requires observable behavior checks before adapter advertisement.
