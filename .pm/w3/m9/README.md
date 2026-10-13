# w3 · m9 — Native session compaction

**Worker:** worker1 **Goal:** A `/compact` command compacts the session through public `session/compact` where the host completes it, and reports refusals truthfully. **Status:** todo

## Tasks (in order)

| id   | title                                                  | est | depends_on             |
| ---- | ------------------------------------------------------ | --- | ---------------------- |
| t001 | Verify native session compaction on the installed host | 1h  | w3/m7/t006             |
| t002 | Implement native session compaction                    | 2h  | w3/m9/t001             |
| t003 | Adoption surface                                       | 30m | w3/m9/t001, w3/m9/t002 |
| t004 | Simplify milestone changes                             | 30m | w3/m9/t003             |
| t005 | CI and behavior coverage                               | 45m | w3/m9/t004             |
| t006 | Close out milestone                                    | 15m | w3/m9/t005             |

## Definition of done

- On hosts where compaction completes, `/compact` compacts without a model turn from the adapter and reports the outcome; on refusing hosts it is not advertised or fails with the host reason; history and continuation stay correct afterwards.
- Unverified operations remain unadvertised with a recorded reason.

## Source + Goal linkage

- **Source:** 2026-10-12 Muse feature research (user request "research recent muse wonder and add them to the offering"; `/pm all for w3`). SDK 1.3.0/1.4.4/1.4.6 method registries compared against adapter call sites: the SDK facade covers only turns, approvals and user input, and the adapter calls `session/read`, `view/page`, `model/list`, `session/setModel`, `session/setApprovalMode`, `session/list`, `session/fork`, `workflow/cancel`, `item/readOutput`, `turn/cancel`, `turn/steer`, `approval/decide` and `userInput/answer|cancel` only.
- **Goal linkage:** Truthful capabilities and usable editor integration: offer verified public Muse features through ACP instead of leaving them unreachable.
- **Expected outcome:** Users can shrink long sessions natively.
- **Methods:** session/compact (since SDK 1.3.0).
- **Why now:** Long sessions hit context limits; the method is public and may now work on 1.4.x.
- **Adoption surface:** separate closing task t003.
- **Constraints:** public SDK/MSP only, feature-detected and live-verified on the installed host before advertisement (DO_NOT_DO); no fabricated controls; safe defaults unchanged.

## Validation evidence

Pending.
