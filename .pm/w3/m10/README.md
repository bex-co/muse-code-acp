# w3 · m10 — Background task and workflow controls

**Worker:** worker1 **Goal:** Task and workflow cards offer verified stop, background, pause and resume actions, and running tasks can be listed. **Status:** todo

## Tasks (in order)

| id   | title                                                              | est | depends_on               |
| ---- | ------------------------------------------------------------------ | --- | ------------------------ |
| t001 | Verify background task and workflow controls on the installed host | 1h  | w3/m7/t006               |
| t002 | Implement background task and workflow controls                    | 2h  | w3/m10/t001              |
| t003 | Adoption surface                                                   | 30m | w3/m10/t001, w3/m10/t002 |
| t004 | Simplify milestone changes                                         | 30m | w3/m10/t003              |
| t005 | CI and behavior coverage                                           | 45m | w3/m10/t004              |
| t006 | Close out milestone                                                | 15m | w3/m10/t005              |

## Definition of done

- Each action is advertised only on hosts where it was verified against a real observed task/workflow, routes through `_muse/task` with the existing target validation, and the item terminal (not the command acceptance) is reported as the outcome; task listing is available where `task/list` exists.
- Unverified operations remain unadvertised with a recorded reason.

## Source + Goal linkage

- **Source:** 2026-10-12 Muse feature research (user request "research recent muse wonder and add them to the offering"; `/pm all for w3`). SDK 1.3.0/1.4.4/1.4.6 method registries compared against adapter call sites: the SDK facade covers only turns, approvals and user input, and the adapter calls `session/read`, `view/page`, `model/list`, `session/setModel`, `session/setApprovalMode`, `session/list`, `session/fork`, `workflow/cancel`, `item/readOutput`, `turn/cancel`, `turn/steer`, `approval/decide` and `userInput/answer|cancel` only.
- **Goal linkage:** Truthful capabilities and usable editor integration: offer verified public Muse features through ACP instead of leaving them unreachable.
- **Expected outcome:** Users can stop or background long tasks and pause/resume workflows from their client.
- **Methods:** task/background, task/stop, task/stopAll (1.3.0), task/list (1.4.6), workflow/pause (1.4.4), workflow/resume (1.4.6).
- **Why now:** Long-running work currently can only be cancelled as a whole turn or workflow.
- **Adoption surface:** separate closing task t003.
- **Constraints:** public SDK/MSP only, feature-detected and live-verified on the installed host before advertisement (DO_NOT_DO); no fabricated controls; safe defaults unchanged.

## Validation evidence

Pending.
