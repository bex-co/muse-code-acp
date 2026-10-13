# w3 · m11 — Recap and native session rename

**Worker:** worker1 **Goal:** `/recap` requests a native session recap, and `/rename` also sets Muse's own session name. **Status:** todo

## Tasks (in order)

| id   | title                                                        | est | depends_on               |
| ---- | ------------------------------------------------------------ | --- | ------------------------ |
| t001 | Verify recap and native session rename on the installed host | 1h  | w3/m7/t006               |
| t002 | Implement recap and native session rename                    | 2h  | w3/m11/t001              |
| t003 | Adoption surface                                             | 30m | w3/m11/t001, w3/m11/t002 |
| t004 | Simplify milestone changes                                   | 30m | w3/m11/t003              |
| t005 | CI and behavior coverage                                     | 45m | w3/m11/t004              |
| t006 | Close out milestone                                          | 15m | w3/m11/t005              |

## Definition of done

- `/recap` returns the host's recap (or its refusal) without an adapter-generated summary; `/rename` calls `session/rename` where available and the adapter title stays consistent with host name changes, with the ignore decision for `session/nameChanged` revisited.
- Unverified operations remain unadvertised with a recorded reason.

## Source + Goal linkage

- **Source:** 2026-10-12 Muse feature research (user request "research recent muse wonder and add them to the offering"; `/pm all for w3`). SDK 1.3.0/1.4.4/1.4.6 method registries compared against adapter call sites: the SDK facade covers only turns, approvals and user input, and the adapter calls `session/read`, `view/page`, `model/list`, `session/setModel`, `session/setApprovalMode`, `session/list`, `session/fork`, `workflow/cancel`, `item/readOutput`, `turn/cancel`, `turn/steer`, `approval/decide` and `userInput/answer|cancel` only.
- **Goal linkage:** Truthful capabilities and usable editor integration: offer verified public Muse features through ACP instead of leaving them unreachable.
- **Expected outcome:** Users get native recaps and session names that match other Muse clients.
- **Methods:** recap/request, recap/cancel, recap/completed (1.4.6); session/rename (1.3.0); session/nameChanged (folded, currently ignored).
- **Why now:** Recap is new in 1.4.6; native rename keeps titles consistent across Muse clients.
- **Adoption surface:** separate closing task t003.
- **Constraints:** public SDK/MSP only, feature-detected and live-verified on the installed host before advertisement (DO_NOT_DO); no fabricated controls; safe defaults unchanged.

## Validation evidence

Pending.
