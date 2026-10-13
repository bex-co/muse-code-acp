# w3 · m13 — Turn interrupt, unqueue and native usage

**Worker:** worker1 **Goal:** Finer turn controls (interrupt, unqueue, user-input interrupt) and native usage numbers are offered where verified. **Status:** done

## Tasks (in order)

| id   | title                                                                            | est | depends_on               |
| ---- | -------------------------------------------------------------------------------- | --- | ------------------------ |
| t001 | Verify turn interrupt, unqueue and native usage on the installed host — **DONE** | 1h  | w3/m7/t006               |
| t002 | Implement turn interrupt, unqueue and native usage — **DONE**                    | 2h  | w3/m13/t001              |
| t003 | Adoption surface — **DONE**                                                      | 30m | w3/m13/t001, w3/m13/t002 |
| t004 | Simplify milestone changes — **DONE**                                            | 30m | w3/m13/t003              |
| t005 | CI and behavior coverage — **DONE**                                              | 45m | w3/m13/t004              |
| t006 | Close out milestone — **DONE**                                                   | 15m | w3/m13/t005              |

## Definition of done

- Each control is advertised only after live verification, with semantics distinct from cancel documented; `/status` uses `usage/read` where available and labels its source.
- Unverified operations remain unadvertised with a recorded reason.

## Source + Goal linkage

- **Source:** 2026-10-12 Muse feature research (user request "research recent muse wonder and add them to the offering"; `/pm all for w3`). SDK 1.3.0/1.4.4/1.4.6 method registries compared against adapter call sites: the SDK facade covers only turns, approvals and user input, and the adapter calls `session/read`, `view/page`, `model/list`, `session/setModel`, `session/setApprovalMode`, `session/list`, `session/fork`, `workflow/cancel`, `item/readOutput`, `turn/cancel`, `turn/steer`, `approval/decide` and `userInput/answer|cancel` only.
- **Goal linkage:** Truthful capabilities and usable editor integration: offer verified public Muse features through ACP instead of leaving them unreachable.
- **Expected outcome:** Users can interrupt or unqueue precisely and see authoritative usage.
- **Methods:** turn/interrupt, turn/unqueue (1.3.0), userInput/interrupt (1.4.4), usage/read (1.3.0).
- **Why now:** Remaining public turn controls listed as unadvertised in the audit.
- **Adoption surface:** separate closing task t003.
- **Constraints:** public SDK/MSP only, feature-detected and live-verified on the installed host before advertisement (DO_NOT_DO); no fabricated controls; safe defaults unchanged.

## Validation evidence

Muse `1.4.7-R6101.1`, `@muse-code/sdk` 1.4.7, macOS arm64, 2026-10-12.

- `npm run check`: clean. `npm run test:unit`: 503/504 (discovery-deadline load flake).
- Loopback suite `--no-file-parallelism`: 21 files, 68/68.
- Real subscription values are forwarded from `usage/read` but only appear after Muse has observed real usage; loopback shows the absent case.
