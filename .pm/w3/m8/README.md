# w3 · m8 — Native goal controls

**Worker:** worker1 **Goal:** `/goal` sets, edits, pauses, resumes and clears the native Muse goal instead of reporting persistent controls as unavailable. **Status:** todo

## Tasks (in order)

| id   | title                                             | est | depends_on             |
| ---- | ------------------------------------------------- | --- | ---------------------- |
| t001 | Verify native goal controls on the installed host | 1h  | w3/m7/t006             |
| t002 | Implement native goal controls                    | 2h  | w3/m8/t001             |
| t003 | Adoption surface                                  | 30m | w3/m8/t001, w3/m8/t002 |
| t004 | Simplify milestone changes                        | 30m | w3/m8/t003             |
| t005 | CI and behavior coverage                          | 45m | w3/m8/t004             |
| t006 | Close out milestone                               | 15m | w3/m8/t005             |

## Definition of done

- `/goal set|edit|pause|resume|clear` call the public methods and the observed goal (via `session/goalChanged`) reflects each change; hosts without the methods keep today's explicit unavailability.
- Unverified operations remain unadvertised with a recorded reason.

## Source + Goal linkage

- **Source:** 2026-10-12 Muse feature research (user request "research recent muse wonder and add them to the offering"; `/pm all for w3`). SDK 1.3.0/1.4.4/1.4.6 method registries compared against adapter call sites: the SDK facade covers only turns, approvals and user input, and the adapter calls `session/read`, `view/page`, `model/list`, `session/setModel`, `session/setApprovalMode`, `session/list`, `session/fork`, `workflow/cancel`, `item/readOutput`, `turn/cancel`, `turn/steer`, `approval/decide` and `userInput/answer|cancel` only.
- **Goal linkage:** Truthful capabilities and usable editor integration: offer verified public Muse features through ACP instead of leaving them unreachable.
- **Expected outcome:** Users can manage Muse's persistent goal from their ACP client.
- **Methods:** goal/set, goal/edit, goal/pause, goal/resume, goal/clear (since SDK 1.3.0).
- **Why now:** Goal controls have been public since SDK 1.3.0 and the adapter still tells users they are unavailable.
- **Adoption surface:** separate closing task t003.
- **Constraints:** public SDK/MSP only, feature-detected and live-verified on the installed host before advertisement (DO_NOT_DO); no fabricated controls; safe defaults unchanged.

## Validation evidence

Pending.
