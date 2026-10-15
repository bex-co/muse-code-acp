# w3 · m16 — Real-host CI on the newest verified Muse

**Worker:** worker1 **Goal:** CI exercises every version-gated live suite on Muse 1.4.7, and a capability skip on a leg that requires the capability fails instead of passing. **Status:** done

## Tasks (in order)

| id   | title                                                       | est  | depends_on                                         |
| ---- | ----------------------------------------------------------- | ---- | -------------------------------------------------- |
| t001 | Fail closed on required host capabilities — **DONE**        | 1h   | —                                                  |
| t002 | Add a Muse 1.4.7 loopback CI leg — **DONE**                 | 1.5h | w3/m16/t001                                        |
| t003 | Pass the full loopback suite on the 1.4.7 CI leg — **DONE** | 2h   | w3/m16/t002                                        |
| t004 | Adoption surface — **DONE**                                 | 30m  | w3/m16/t001, w3/m16/t002, w3/m16/t003              |
| t005 | Simplify milestone changes — **DONE**                       | 30m  | w3/m16/t004                                        |
| t006 | CI and behavior coverage — **DONE**                         | 45m  | w3/m16/t001, w3/m16/t002, w3/m16/t003, w3/m16/t005 |
| t007 | Close out milestone — **DONE**                              | 15m  | w3/m16/t006                                        |

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

2026-10-15. GitHub CI runs [38720193800](https://github.com/bex-co/muse-code-acp/actions/runs/38720193800) and [38720625206](https://github.com/bex-co/muse-code-acp/actions/runs/38720625206) on `4022109` (temporary branch, same content as the shipped commit's code): every job green both times.

| Leg                                             | Host check                                             | Result                                          |
| ----------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------- |
| Muse 1.4.7-R6101.1, `REQUIRE_HOST_FEATURES=all` | manifest SHA-256 OK, `Muse Code 1.4.7 (1.4.7-R6101.1)` | 21/21 files, 68/68 tests, 0 skipped (both runs) |
| Muse 1.1.1-R2514.1 baseline                     | manifest SHA-256 OK                                    | 63 passed, 5 capability skips                   |

- Required-capability failure shown on a real Muse 1.1.1 host: `Muse host 1.1.1 lacks required capability "goal-controls"` (t001).
- Found and fixed along the way: the long-standing `session-discovery-live` flake depended on unprompted sessions, which Muse discards on host exit and shares only partially across processes (t003).
- Local: full loopback suite on Muse 1.4.7 (macOS arm64) with all capabilities required, 68/68; `npm run check`, `build`, `test:coverage` (509/509) and a shuffled run passed.
- Not changed: the standalone job still smoke-tests Muse 1.1.1 only (out of scope).
