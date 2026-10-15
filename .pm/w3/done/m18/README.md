# w3 · m18 — Split acp-agent.ts without changing behavior

**Worker:** worker1 **Goal:** `src/acp-agent.ts` is the ACP entry surface and delegates to focused command, turn and session-lifecycle modules, with identical test results. **Status:** done

## Tasks (in order)

| id   | title                                                            | est  | depends_on                                                                   |
| ---- | ---------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------- |
| t001 | Characterize the prompt() branches — **DONE**                    | 1.5h | w3/m15/t001, w3/m15/t003                                                     |
| t002 | Extract command routing from prompt() — **DONE**                 | 2h   | w3/m18/t001                                                                  |
| t003 | Extract the SDK and exec turn runners — **DONE**                 | 2h   | w3/m18/t002                                                                  |
| t004 | Extract session lifecycle handling — **DONE**                    | 2h   | w3/m18/t001                                                                  |
| t008 | Extract capability, status and configuration handling — **DONE** | 2h   | w3/m18/t003, w3/m18/t004                                                     |
| t005 | Simplify milestone changes — **DONE**                            | 30m  | w3/m18/t002, w3/m18/t003, w3/m18/t004, w3/m18/t008                           |
| t006 | CI and behavior coverage — **DONE**                              | 45m  | w3/m18/t001, w3/m18/t002, w3/m18/t003, w3/m18/t004, w3/m18/t008, w3/m18/t005 |
| t007 | Close out milestone — **DONE**                                   | 15m  | w3/m18/t006                                                                  |

## Definition of done

- `src/acp-agent.ts` is about 1000 lines or fewer and `prompt()` about 150 lines or fewer, measured and recorded.
- Unit and loopback pass counts are equal to or higher than the recorded pre-refactor baseline, no assertion is weakened, and unit coverage stays at or above the w3/m15 thresholds with the extracted modules covered.
- Package exports and wire behavior are unchanged: wire tests and `npm run test:pack-smoke` pass unmodified.
- Docs that point at moved code (`docs/capability-audit.md`, `docs/sdk-migration.md`, `docs/ADR003-codex-acp-parity.md`) point at the new modules.

## Source + Goal linkage

- **Source:** 2026-10-15 `/pm-brainstorm` "to improve code quality and ensure it's best muse code acp on the market", materialized by `/pm them all for w3`. At `cb40c70`, `src/acp-agent.ts` has 2310 of the 10,681 lines in `src/*.ts` and 62 methods; `prompt()` spans lines 1570–2128 (about 560 lines). The next-largest module, `src/muse-sdk.ts`, has 964 lines.
- **Goal linkage:** Reliability: recent fixes concentrated in turn and lifecycle code (the 0.10.0 host-closed-mid-write fix, the 0.9.1 exec stall fix); smaller units reduce regression risk for every host feature.
- **Expected outcome:** Contributors and agents change one command or turn path without editing a 560-line method, and host-feature milestones touch focused modules.
- **Why now:** w3/m19 and every future Muse 1.4.x feature would otherwise grow `prompt()`; w3/m15 supplies the deterministic suite and coverage this refactor relies on.
- **Adoption surface:** Omitted: no user, configuration or protocol surface changes. Code-path references in docs are updated by the extraction tasks.
- **Constraints:** Behavior-preserving only. A bug found during extraction is recorded and fixed in a separate commit with its own test.

## Validation evidence

2026-10-15. Before → after: `src/acp-agent.ts` 2310 → 1026 lines; `prompt()` 558 → 124 lines. New modules: `agent-types.ts`, `agent-capabilities.ts`, `local-commands.ts`, `sdk-prompt-turn.ts`, `exec-prompt-turn.ts`, `session-lifecycle.ts`, `session-status.ts`, `session-configuration.ts`, `catalog-publication.ts`; none imports `acp-agent.ts`.

| Check                                          | Before (t001)                                  | After                                                                                     |
| ---------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Unit tests                                     | 510 (516 with the t001 characterization tests) | 516/516, also shuffled                                                                    |
| Coverage (stmts/branches/funcs/lines)          | 86.58/78.57/87.94/88.36                        | 86.63/78.56/88.13/88.47                                                                   |
| Muse 1.4.8 loopback, all capabilities required | 68/68                                          | 68/68                                                                                     |
| GitHub CI                                      | —                                              | [run 38728650087](https://github.com/bex-co/muse-code-acp/actions/runs/38728650087) green |

No test assertion was weakened; existing tests pass unmodified. t008 was added during the milestone because t002–t004 left the file at 1477 lines.
