# w3 · m16 — Real-host CI on the newest verified Muse

**Worker:** worker1 **Goal:** CI exercises every version-gated live suite on Muse 1.4.7, and a capability skip on a leg that requires the capability fails instead of passing. **Status:** todo

## Tasks (in order)

| id   | title                                            | est  | depends_on                                         |
| ---- | ------------------------------------------------ | ---- | -------------------------------------------------- |
| t001 | Fail closed on required host capabilities        | 1h   | —                                                  |
| t002 | Add a Muse 1.4.7 loopback CI leg                 | 1.5h | w3/m16/t001                                        |
| t003 | Pass the full loopback suite on the 1.4.7 CI leg | 2h   | w3/m16/t002                                        |
| t004 | Adoption surface                                 | 30m  | w3/m16/t001, w3/m16/t002, w3/m16/t003              |
| t005 | Simplify milestone changes                       | 30m  | w3/m16/t004                                        |
| t006 | CI and behavior coverage                         | 45m  | w3/m16/t001, w3/m16/t002, w3/m16/t003, w3/m16/t005 |
| t007 | Close out milestone                              | 15m  | w3/m16/t006                                        |

## Definition of done

- The CI `muse-loopback` job runs on Muse 1.1.1-R2514.1 (supported baseline) and 1.4.7-R6101.1 (newest verified), each installed from a public artifact with a pinned SHA-256.
- On the 1.4.7 leg the version-gated suites (goal controls, native commands, workflows, async tasks and any others found in t001) run and pass, and the job declares the capabilities it requires, so none of them can skip silently.
- A run that requires a capability its host lacks fails with a message naming the capability (demonstrated and recorded).
- The 1.1.1 leg still passes; capabilities it legitimately lacks are reported as skips, not failures.

## Source + Goal linkage

- **Source:** 2026-10-15 `/pm-brainstorm` "to improve code quality and ensure it's best muse code acp on the market", materialized by `/pm them all for w3`. Evidence at `cb40c70`: `.github/workflows/ci.yml` installs only Muse 1.1.1-R2514.1 for `muse-loopback` and standalone. `src/tests/goal-controls-live.test.ts:13` and `src/tests/native-commands-live.test.ts:13` use `describe.skipIf(!available || !supports…(probeSdkHost().version))`. `MUSE_CODE_ACP_REQUIRE_MUSE=1` fails only when no host is available. The public 1.4.7-R6101.1 `muse-x86-linux` artifact URL returned HTTP 200 on 2026-10-15.
- **Goal linkage:** Truthful capabilities: every feature advertised only on Muse 1.4.6+ is checked against a real host on every push and before every release (`publish.yml` reuses `ci.yml`).
- **Expected outcome:** A regression in goal controls, `/recap`, `/skills`, `/feedback`, `/plugins`, `/hooks`, subscription usage or workflow/task controls fails CI before reaching npm.
- **Why now:** All of 0.10.0's host features are verified only on maintainer machines; CI and release CI currently pass with those suites skipped.
- **Adoption surface:** Separate task t004: README testing and support statements, the `docs/sdk-migration.md` test table and the release skill's CI description.
- **Constraints:** Public artifacts with pinned hashes only; the sandbox stays enabled (DO_NOT_DO: no `--disable-sandbox`); no paid providers. The supported baseline stays 1.1.1 unless the user decides otherwise.

## Validation evidence

Not yet run.
