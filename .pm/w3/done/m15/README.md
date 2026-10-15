# w3 · m15 — Trustworthy quality gates

**Worker:** worker1 **Goal:** The deterministic suite passes repeatedly and in shuffled order, unit coverage runs and is enforced, and unhandled promises fail lint. **Status:** done

## Tasks (in order)

| id   | title                                                         | est | depends_on                                                      |
| ---- | ------------------------------------------------------------- | --- | --------------------------------------------------------------- |
| t001 | Make the resume-timeout startup test deterministic — **DONE** | 1h  | —                                                               |
| t002 | Enforce promise-safety lint rules — **DONE**                  | 45m | —                                                               |
| t003 | Restore enforced unit coverage — **DONE**                     | 1h  | —                                                               |
| t004 | Detect order-dependent tests in CI — **DONE**                 | 1h  | w3/m15/t001                                                     |
| t005 | Simplify milestone changes — **DONE**                         | 30m | w3/m15/t001, w3/m15/t002, w3/m15/t003, w3/m15/t004              |
| t006 | CI and behavior coverage — **DONE**                           | 45m | w3/m15/t001, w3/m15/t002, w3/m15/t003, w3/m15/t004, w3/m15/t005 |
| t007 | Close out milestone — **DONE**                                | 15m | w3/m15/t006                                                     |

## Definition of done

- `npm run test:unit` passes 20 consecutive local runs and shuffled runs with at least 5 recorded seeds; CI runs a shuffled pass that prints its seed.
- `npm run test:coverage` succeeds from a clean `npm ci`, excludes the live and paid-provider suites, fails when coverage drops below the recorded thresholds, and runs in CI.
- `npm run lint` enforces `@typescript-eslint/no-floating-promises` and `@typescript-eslint/no-misused-promises` with zero hits and no new `eslint-disable` comments.
- No production behavior changes beyond explicit promise-rejection handling and test-only clock/timeout injection.

## Source + Goal linkage

- **Source:** 2026-10-15 `/pm-brainstorm` "to improve code quality and ensure it's best muse code acp on the market", materialized by `/pm them all for w3`. Evidence at `cb40c70` is listed under Validation evidence.
- **Goal linkage:** Reliability: a flaky gate lets real regressions through on retry, a broken coverage script hides untested paths, and unhandled promises in a long-lived stdio adapter can crash or hang a session.
- **Expected outcome:** Contributors and agents can treat a red CI run as a real failure, and coverage regressions are caught before merge.
- **Why now:** Prerequisite for the behavior-preserving refactor in w3/m18, which needs a deterministic suite and per-branch coverage.
- **Adoption surface:** Omitted: no user, configuration or protocol surface changes. t003 updates the README testing command list for `test:coverage` as part of implementation.

## Validation evidence

### Before (baseline)

Baseline, 2026-10-15 at `cb40c70`, macOS arm64:

- `npm run test:unit`: 1 failure in 3 runs: `src/tests/startup.test.ts` › "preserves session/resume timeout across EOF and prevents submission" received a `Muse SDK initializing timed…` error instead of the expected `data.failure` object. The other runs passed 506/506.
- `npm run test:coverage`: fails immediately with `MISSING DEPENDENCY Cannot find dependency '@vitest/coverage-v8'`.
- ESLint with the two promise rules enabled: 4 errors: `src/index.ts:104` (floating), `src/index.ts:106` and `:107` (misused), `src/tests/loopback-provider.ts:223` (misused).

### After — 2026-10-15, macOS arm64 (28 cores), Node 22.17.1

- `npm run test:unit`: 20/20 consecutive runs passed, 506/506 each.
- Shuffled: seeds 1, 42, 1234, 20261015, 987654 and 7 all passed (`npm run test:unit:shuffle -- --sequence.seed=<n>`).
- `npm run test:coverage`: 86.29/78.22/87.5/88.05 (statements/branches/functions/lines) against thresholds 86/78/87/88; a raised lines threshold exits 1.
- `npm run check` with `no-floating-promises`, `no-misused-promises` and `await-thenable`: clean. `npm run build`, `npm run test:pack-smoke`: passed.
- Real host Muse 1.4.8-R6256.1 loopback suite: 65/68; the same 3 tests fail on clean `adae363` (1.4.8 host gaps, now recorded in w3/m17/t002).
- Root causes and fixes are recorded in t001.

### Correction — 2026-10-15, after shipping `4d7cf6c`

GitHub CI failed the coverage step: the build job has no Muse host, so 9 live-echo tests inside `test:unit` skip, and coverage there is 85.82/77.57/86.9/87.61, below the macOS-with-host floors above. Reproduced locally with `muse` off `PATH` (85.85/77.6/87.2/87.67). Thresholds are now the floors of the host-less CI baseline, 85/77/86/87; the `t003` "baseline" numbers above were measured with a host installed.
