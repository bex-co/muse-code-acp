# w3 · m8 — Native goal controls

**Worker:** worker1 **Goal:** `/goal` sets, edits, pauses, resumes and clears the native Muse goal instead of reporting persistent controls as unavailable. **Status:** done

## Tasks (in order)

| id   | title                                                        | est | depends_on             |
| ---- | ------------------------------------------------------------ | --- | ---------------------- |
| t001 | Verify native goal controls on the installed host — **DONE** | 1h  | w3/m7/t006             |
| t002 | Implement native goal controls — **DONE**                    | 2h  | w3/m8/t001             |
| t003 | Adoption surface — **DONE**                                  | 30m | w3/m8/t001, w3/m8/t002 |
| t004 | Simplify milestone changes — **DONE**                        | 30m | w3/m8/t003             |
| t005 | CI and behavior coverage — **DONE**                          | 45m | w3/m8/t004             |
| t006 | Close out milestone — **DONE**                               | 15m | w3/m8/t005             |

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

Muse `1.4.6-R6000.1`, `@muse-code/sdk` 1.4.6, macOS arm64, 2026-10-12.

- `npm run check`: clean. `npm run test:unit`: 502/502.
- `MUSE_CODE_ACP_REQUIRE_MUSE=1` loopback suite, `--no-file-parallelism`: 20 files, 66/66 (includes `goal-controls-live`).
- Hosts older than 1.4.6 keep the controls unadvertised and answer with a no-change notice; GitHub CI (Muse 1.1.1) skips the live control test.
