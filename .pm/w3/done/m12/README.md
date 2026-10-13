# w3 · m12 — Skill activation, skill import and feedback

**Worker:** worker1 **Goal:** `/skills` can enable, disable and import skills, and `/feedback` submits feedback to Muse. **Status:** done

## Tasks (in order)

| id   | title                                                                               | est | depends_on               |
| ---- | ----------------------------------------------------------------------------------- | --- | ------------------------ |
| t001 | Verify skill activation, skill import and feedback on the installed host — **DONE** | 1h  | w3/m7/t006               |
| t002 | Implement skill activation, skill import and feedback — **DONE**                    | 2h  | w3/m12/t001              |
| t003 | Adoption surface — **DONE**                                                         | 30m | w3/m12/t001, w3/m12/t002 |
| t004 | Simplify milestone changes — **DONE**                                               | 30m | w3/m12/t003              |
| t005 | CI and behavior coverage — **DONE**                                                 | 45m | w3/m12/t004              |
| t006 | Close out milestone — **DONE**                                                      | 15m | w3/m12/t005              |

## Definition of done

- `/skills enable|disable|import` call the public methods and the listed state reflects the change; `/feedback <classification> <note>` submits with no files or session record unless explicitly requested and reports the host outcome (uploaded/recorded/disabled…).
- Unverified operations remain unadvertised with a recorded reason.

## Source + Goal linkage

- **Source:** 2026-10-12 Muse feature research (user request "research recent muse wonder and add them to the offering"; `/pm all for w3`). SDK 1.3.0/1.4.4/1.4.6 method registries compared against adapter call sites: the SDK facade covers only turns, approvals and user input, and the adapter calls `session/read`, `view/page`, `model/list`, `session/setModel`, `session/setApprovalMode`, `session/list`, `session/fork`, `workflow/cancel`, `item/readOutput`, `turn/cancel`, `turn/steer`, `approval/decide` and `userInput/answer|cancel` only.
- **Goal linkage:** Truthful capabilities and usable editor integration: offer verified public Muse features through ACP instead of leaving them unreachable.
- **Expected outcome:** Users manage skills and send feedback without leaving their client.
- **Methods:** skill/setActivation (1.4.4), skill/import (1.4.6), feedback/submit (1.4.4).
- **Why now:** Both are public since 1.4.4/1.4.6 and have natural slash-command surfaces.
- **Adoption surface:** separate closing task t003.
- **Constraints:** public SDK/MSP only, feature-detected and live-verified on the installed host before advertisement (DO_NOT_DO); no fabricated controls; safe defaults unchanged.

## Validation evidence

Muse `1.4.7-R6101.1`, `@muse-code/sdk` 1.4.7, macOS arm64, 2026-10-12.

- `npm run check`: clean. `npm run test:unit`: 503/504 (discovery-deadline load flake, passes in isolation).
- Loopback suite `--no-file-parallelism`: 21 files, 68/68.
- No feedback left the machine during testing (dead proxy); upload success is reported verbatim but was not exercised.
