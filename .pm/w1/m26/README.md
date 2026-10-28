# w1 · m26 — Adopt Muse 1.4.14: compaction, MCP and Linux fork fixes

**Worker:** worker1 **Goal:** The adapter pins `@muse-code/sdk` 1.4.14, is verified and CI-tested on Muse 1.4.14-R7309.1, and turns the three upstream fixes that host ships (#112, #120, #121) into user-visible improvements, while older hosts keep their current workarounds. **Status:** in progress

## Tasks (in order)

| id   | title                                                                  | est | depends_on                    |
| ---- | ---------------------------------------------------------------------- | --- | ----------------------------- |
| t001 | Bump the SDK to 1.4.14 and verify Muse 1.4.14 — **DONE**               | 2h  | —                             |
| t002 | Render `earlierHistory` items in compacted-session replay — **DONE**   | 1h  | w1/m26/t001                   |
| t003 | Version-aware handling of the fixed upstream issues — **DONE**         | 1h  | w1/m26/t001                   |
| t004 | Show the reviewer's escalation reason in permission prompts — **DONE** | 45m | w1/m26/t001                   |
| t005 | Adoption surface — **DONE**                                            | 45m | w1/m26/t001–t004              |
| t006 | Simplify milestone changes — **DONE**                                  | 30m | w1/m26/t005                   |
| t007 | CI and behavior coverage                                               | 1h  | w1/m26/t001–t004, w1/m26/t006 |
| t008 | Close out milestone                                                    | 15m | w1/m26/t007                   |

## Definition of done

- `@muse-code/sdk` is pinned to 1.4.14; Muse 1.4.14 hosts log no schema-fingerprint warning.
- GitHub CI runs the loopback suite on 1.4.14-R7309.1 (x86 Linux) with `MUSE_CODE_ACP_REQUIRE_HOST_FEATURES=all`, and the fork live tests run there instead of recording the #120 limitation.
- On Muse 1.4.14, a `/qa-find-bugs` run of R3-R4 and R5 on the packed build passes. Its stderr shows no "resumed session reports active turn" (#121) and the MCP tool still works after compact + restart (#112).
- On 1.4.12/1.4.13 the existing workarounds still hold, and the affected failures name the Muse version that fixes them.
- `.pm/UPSTREAM_DEPENDENCIES.md` moves #112, #120 and #121 to **Resolved** with the 1.4.14 evidence.

## Source + Goal linkage

- **Source:** 2026-10-28 review of the open rows in [UPSTREAM_DEPENDENCIES.md](../../UPSTREAM_DEPENDENCIES.md), which the user asked for ("if there are issues fixed, then figure out what to do next for us … put to w1"). Evidence (2026-10-28, pinned binaries checked against Meta's manifest SHA-256):
  - #121: an MSP reproduction through the adapter (shell tool turn, no-tool turn, `/compact`, 20 s, restart, load). The phantom active turn is logged on 1.4.13-R6996.1 and absent on 1.4.14-R7309.1 (two runs).
  - #120: `session/start` then `session/fork` in a `node:22-bookworm` aarch64 container. 1.4.13 fails with "file birth time is unavailable"; 1.4.14 forks.
  - #112: closed upstream 2026-10-28 as fixed in 1.4.14. `/qa-find-bugs` R5 passes on 1.4.14 with the packed 7e5936f build.
  - Loopback suite on 1.4.14: 70/72. The two failures are `async-tasks-live` workflow cancel, because 1.4.14 is not in `WORKFLOW_CANCEL_HOSTS`; with 1.4.14 added, 4/4 pass.
- **Goal linkage:** session continuity (compacted sessions survive restarts with their MCP tools), fork support on Linux, and verification on the current stable host.
- **Expected outcome:** users on Muse 1.4.14 can fork on Linux and keep MCP tools and a non-busy session after `/compact` + restart. Users on 1.4.12/1.4.13 learn that upgrading Muse fixes those failures.
- **Why now:** the launcher already auto-updates users to 1.4.14 and the SDK pin is one release behind.
- **Adoption surface:** separate task t005 (CHANGELOG, README verified hosts, `docs/sdk-migration.md`, `docs/session-fork.md`, `docs/failures.md`, the dependency index).

## Validation evidence

<pending>
