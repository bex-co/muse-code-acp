# w3 · m7 — Catch up to SDK and Muse 1.4.6

**Worker:** worker1 **Goal:** The adapter pins `@muse-code/sdk` 1.4.6 and is verified on Muse 1.4.6, with every new folded item classified and rendered. **Status:** done

## Tasks (in order)

| id   | title                                                   | est | depends_on             |
| ---- | ------------------------------------------------------- | --- | ---------------------- |
| t001 | Bump the SDK to 1.4.6 and classify new items — **DONE** | 1h  | —                      |
| t002 | Verify Muse 1.4.6 and update host lists — **DONE**      | 1h  | w3/m7/t001             |
| t003 | Adoption surface — **DONE**                             | 30m | w3/m7/t001, w3/m7/t002 |
| t004 | Simplify milestone changes — **DONE**                   | 30m | w3/m7/t003             |
| t005 | CI and behavior coverage — **DONE**                     | 45m | w3/m7/t004             |
| t006 | Close out milestone — **DONE**                          | 15m | w3/m7/t005             |

## Definition of done

- `@muse-code/sdk` 1.4.6 is pinned; `webSearch` items render; classification tests pass.
- The real-host suite passes on Muse 1.4.6; host lists and verified hosts are updated with evidence.

## Source + Goal linkage

- **Source:** 2026-10-12 Muse feature research (user request "research recent muse wonder and add them to the offering"; `/pm all for w3`). SDK 1.3.0/1.4.4/1.4.6 method registries compared against adapter call sites: the SDK facade covers only turns, approvals and user input, and the adapter calls `session/read`, `view/page`, `model/list`, `session/setModel`, `session/setApprovalMode`, `session/list`, `session/fork`, `workflow/cancel`, `item/readOutput`, `turn/cancel`, `turn/steer`, `approval/decide` and `userInput/answer|cancel` only.
- **Goal linkage:** Truthful capabilities and usable editor integration: offer verified public Muse features through ACP instead of leaving them unreachable.
- **Expected outcome:** users on Muse 1.4.6 get a verified adapter; later feature milestones build on 1.4.6.
- **Why now:** SDK 1.4.6 and Muse 1.4.6 were released 2026-10-11/12; the bump is a prerequisite for the feature milestones m8–m13.
- **Adoption surface:** separate closing task t003.
- **Constraints:** public SDK/MSP only, feature-detected and live-verified on the installed host before advertisement (DO_NOT_DO); no fabricated controls; safe defaults unchanged.

## Validation evidence

Muse `1.4.6-R6000.1`, `@muse-code/sdk` 1.4.6, macOS arm64, 2026-10-12.

- `npm run check`: clean. `npm run test:unit`: 500/500.
- `MUSE_CODE_ACP_REQUIRE_MUSE=1` loopback suite, `--no-file-parallelism`: 19 files, 65/65.
- New host facts: `muse serve` runs the automated reviewer (w3/008); exec-created `:auto-review` sessions load; workflow cancel works; earlier fork boundaries still fail (#97); workflow children refuse effort `none`.
