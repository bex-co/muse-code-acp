# ADR003 follow-up research

Date: 2026-09-12. Scope: SDK safety modes, goal controls, MCP diagnostics and
dependencies preventing independent parity work. This is research and PM handoff,
not production implementation. Existing concurrent workflow edits were not changed.

## Ownership update (2026-09-14)

The user moved the approval/sandbox corrective work to [w2/m4](../.pm/w2/done/m4/README.md). The original w1/m25 plan and evidence are [preserved](../.pm/w2/done/m4/sources.md); its tasks were superseded, not completed. [Fresh feasibility research](../.pm/w2/evidence/capability-feasibility.md) records newer host results and the w2/m5–m6 settings/capability follow-ups. Historical findings below retain their original date and scope.

## Sources and evidence

- Installed Muse Code: `1.1.1-R2514.1`; SDK: `@muse-code/sdk@0.1.1`.
- Public source: [Meta Muse Code SDK](https://github.com/meta-models/muse-code-sdk).
  The repository documents a mirrored developer-preview SDK and upstream-owned
  fixes; public declarations/fixtures do not guarantee installed-host behavior.
- Locally inspected public mirror commit:
  `fbce769ccb75ab971d00e01a00fe076de4c773fc` under `.tmp/muse-code-sdk`.
- [Pinned public MSP declarations](https://github.com/meta-models/muse-code-sdk/blob/fbce769ccb75ab971d00e01a00fe076de4c773fc/schema/msp/msp.d.ts).
- Fresh local `muse serve --help`, `muse mcp --help`, and an isolated approval-mode
  probe described below. Online official repository inspection supplemented local
  evidence; the documentation-site URL could not be opened by the browser tool.

Subsequent execution probes are recorded in [m25 enforcement evidence](../.pm/w2/done/m4/sources.md). They confirmed selection acknowledgements but did not establish the expected policy distinctions for the tested shell action. m25 remains open; the initial proposal below is research, not a claim of delivered enforcement.

## 1. SDK approval and sandbox configuration is actionable

The public `ApprovalMode` enum contains `onRequest`, `promptUnmatched`,
`denyUnmatched`, and `allowAll`. `session/setApprovalMode` returns an effective
mode and apply outcome; its documented next-action semantics do not decide a
previously pending approval retroactively. These are host policies, not arbitrary
client-supplied rules.

Fresh probe: start an isolated loopback fixture with dummy configuration, launch
`muse serve --disable-write --disable-shell`, initialize, create a durable session
with `onRequest`, then call `session/setApprovalMode` sequentially with
`denyUnmatched`, `promptUnmatched`, `allowAll`, and `onRequest`. Every response
returned `status: accepted`, `applyOutcome: completed`, and the requested
`effectiveMode.mode`, with source `approvalReconfigure`. No turn was submitted;
the loopback provider received **zero requests**. The scratch host and fixture
were cleaned up. This verifies policy selection, not side-effect enforcement.

`muse serve --help` explicitly exposes `--disable-sandbox`, `--sandbox-network`,
`--disable-write`, `--disable-shell`, and `--trust-workspace`. It states sandbox
posture is fixed for the host lifetime, whereas approval mode is selected over
MSP. Earlier reasoning that absence of a serve `--yolo` flag prevents all SDK
safety-mode configuration was too strong.

Implementation route:

1. Keep current `onRequest` and sandbox defaults. Add explicit policy selection
   backed by the verified enum; do not equate a name with tested enforcement.
2. Replace the hard-coded `onRequest` values at session start/resume in
   `src/muse-sdk-host.ts`; thread requested/effective policy through session
   configuration and host compatibility. Observe `session/approvalModeChanged`
   or returned effective state rather than guessing success.
3. Keep approval policy and sandbox posture separate. Selecting `allowAll` does
   not disable sandboxing; disabling sandboxing does not grant approvals or
   imply workspace trust. Any broader preset must be explicitly selected and
   accurately described. No default weakening or automatic trust loading.
4. Rotate the session host for spawn-time sandbox changes. Preserve overlays,
   writer leases, cancellation and pending-decision generation guards. Do not
   change posture under an existing action or revive a stale grant.
5. Prove actual allowed/denied tool execution with isolated local fixtures,
   including transition/resume behavior and safe defaults. Pin the supported
   host and keep unsupported configurations unadvertised.

Owner: new w1/m25. A successful zero-turn configuration probe is not the delivery
definition of done; actual policy enforcement remains to be tested.

## 2. Goal controls have an upstream lead, not a verified API

The public mirror contains hand-authored `goal-set-round-trip`, `goal-pause-idle`,
`goal-resume-wake`, `goal-clear-idle`, replay and busy-edit transcript fixtures.
For example, the
[goal-set fixture](https://github.com/meta-models/muse-code-sdk/blob/fbce769ccb75ab971d00e01a00fe076de4c773fc/schema/msp/transcripts/goal-set-round-trip/transcript.ndjson)
uses `goal/set` with `sessionId`, `commandId` and `objective`. Its manifest labels
the fixture hand-authored. The installed/public method enum does not expose those
goal-control methods. These artifacts therefore cannot justify a raw undocumented
request or an advertised ACP action.

Keep m18 observation and read-only `/goal` intact. Revisit when a published
schema/SDK explicitly includes the control contract and a compatible host can be
tested. Check method admission, goal-change state, autonomous wake behavior,
idempotency, busy-turn targeting, pause/clear settlement and cancellation. Separate
goal activity from foreground prompt completion. Do not use an ordinary prompt or
native model tool as a deterministic substitute for pause/clear.

Owner: w1/002, a bounded upstream-support reassessment. Promote implementation
only after the required public contract exists; no automatic polling or external
issue/message submission is part of this handoff.

## 3. MCP diagnostics need host-owned observations

The installed method/notification enum contains no MCP inventory/status method.
`muse mcp --help` advertises OAuth login/logout, not a status or list operation.
The delivered m16 behavior in `src/mcp-status.ts` correctly distinguishes configured
inventory from unknown current connectivity and sanitized last-observed failures.

A separate adapter-owned `initialize`/`tools/list` connection could test an
endpoint, but would be a separate connection, with potentially different auth,
transport/session lifetime and tool discovery. It would not prove Muse's resident
connection is healthy. Do not relabel that diagnostic as host connection status or
silently trigger OAuth/network activity during `/mcp` inspection.

Revisit on a public Muse connection-state/inventory API or documented lifecycle
notifications. Request or subscribe on the session-owned host; associate snapshots
with server/configuration/host generation and observed time; distinguish
configured, connecting, ready, failed and unknown only as evidence permits. Clear
stale state on configuration/auth changes, replacement and disconnect. Tools and
resource counts require host-owned list data, not local guesses.

Owner: w1/003, a bounded host-status reassessment with a reproducible trigger.
The archived m16 milestone remains complete for its delivered subset.

## 4. Remove ordering dependencies that do not express required behavior

The inspected tasks establish the following narrower prerequisites:

| Task                                  | Previous prerequisite | Revised prerequisite  | Reason                                                                            |
| ------------------------------------- | --------------------- | --------------------- | --------------------------------------------------------------------------------- |
| m9/t003 todo mapping                  | m9/t002 compaction    | m9/t001 notifications | Todo snapshots do not invoke compaction; closing checks still require compaction. |
| m12/t001 fork                         | m11 closeout          | m10 closeout          | Root-session fork needs session ownership, not delegated worker launch.           |
| m13/t001 change evidence              | m12 closeout          | m10 closeout          | Preimages and turn attribution do not require branching.                          |
| m14/t001 errors/auth                  | m9 closeout           | m10 closeout          | Existing host/turn lifecycle already supplies error and retry boundaries.         |
| m15/t001 background support probe     | m11 closeout          | m10 closeout          | Root-process contract discovery can proceed without child sessions.               |
| m17/t001 rich-output probe            | m9 closeout           | m10 closeout          | Public output references can be investigated against existing item translation.   |
| m19/t001 public listing/history probe | m12 closeout          | m10 closeout          | Root listing and history completeness do not require a fork implementation.       |

Retain actual integration dependencies: m15/t002 requires m11 closeout because its
acceptance explicitly includes interleaved root/child namespaces; m19/t002 requires
m12 closeout because its acceptance includes source/fork listing. m9 Simplify and
CI continue to require t002 as well as the independent event tasks. No blocker,
acceptance criterion or required feature is removed, and no task is marked done.

This is a dependency correction, not permission to claim all milestones
actionable or complete. Host-feature probes may uncover their own blockers.

## Current execution ownership after cleanup

The user subsequently requested w1 contain only future SDK/host enablement. [The exact cleanup ledger](../.pm/ownership-2026-09-14.md) supersedes the historical w1 execution assignments above. Current work is scheduled in w2/m4–m10 and w2/011; future watches are w1/002–012. No historical blocked feature was marked delivered by moving its independent parts.

## Status as of 2026-10-26 (0.11.0)

The findings above keep their original dates. Their current outcomes, reconciled in
[ADR003](ADR003-codex-acp-parity.md#status-as-of-2026-10-26-0110):

- Section 1: approval policies and independent sandbox controls shipped in
  [w2/m4](../.pm/w2/done/m4/README.md). Native permission profiles on `muse serve`
  remain upstream ([muse-code-sdk#43](https://github.com/meta-models/muse-code-sdk/issues/43)).
- Section 2: a public `goal/*` contract appeared, and `/goal set|edit|pause|resume|clear`
  shipped for Muse 1.4.6+ in [w3/m8](../.pm/w3/done/m8/README.md). The
  [w1/002](../.pm/w1/done/002.md) trigger is met; closing the watch is
  [w3/014](../.pm/w3/done/014.md).
- Section 3: still upstream-blocked. Muse 1.4.12's experimental `mcpServer/list`
  reports configuration and auth facts only, not live connection state
  ([upstream dependencies](../.pm/UPSTREAM_DEPENDENCIES.md#blocked-without-a-public-issue),
  [w1/003](../.pm/UPSTREAM_DEPENDENCIES.md#mcp-status)).
