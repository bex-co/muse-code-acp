# w3 · m2 — Muse 1.4.3 real-host compatibility

**Worker:** worker1 **Goal:** The real-host loopback suite passes on Muse 1.4.3, and fork and legacy-session behavior on 1.4.3 is verified or truthfully reported. **Status:** todo

## Tasks (in order)

| id   | title                                                          | est | depends_on                         |
| ---- | -------------------------------------------------------------- | --- | ---------------------------------- |
| t001 | Diagnose forkBoundaryInvalid on Muse 1.4.3                     | 1h  | —                                  |
| t002 | Fix or document the fork boundary on 1.4.3                     | 1h  | w3/m2/t001                         |
| t003 | Expect legacy :auto-review refusal on hosts from 1.3.0-R3401.1 | 30m | —                                  |
| t004 | Update workflows-live denial evidence for 1.4.3                | 30m | —                                  |
| t005 | Adoption surface                                               | 30m | w3/m2/t002, w3/m2/t003, w3/m2/t004 |
| t006 | Simplify milestone changes                                     | 30m | w3/m2/t005                         |
| t007 | CI and behavior coverage                                       | 45m | w3/m2/t006                         |
| t008 | Close out milestone                                            | 15m | w3/m2/t007                         |

## Definition of done

- `MUSE_CODE_ACP_REQUIRE_MUSE=1 npm run test:muse-loopback` has no persistent failures on Muse 1.4.3 (load-induced timeouts recorded separately).
- Forking at a completed turn works on 1.4.3 or fails with an accurate error documented as a host limitation.
- Docs record 1.4.3 status and the exec-session `:auto-review` resume limitation.

## Source + Goal linkage

- **Source:** 2026-10-06 triage of the 1.4.3 live failures on `main` (`3ea3213`, host `1.4.3-R5018.1`): 5 persistent failures — three legacy `:auto-review` resume expectations, `session-fork-live` (`forkBoundaryInvalid`), `workflows-live` (denial text absent).
- **Goal linkage:** Session continuity and truthful capabilities on the host users now run (the Muse launcher auto-updates).
- **Expected outcome:** Users on 1.4.3 can fork sessions (or get a truthful error), and CI evidence covers the current host.
- **Why now:** Blocks 0.8.0 (w3/m3); the fork failure may already affect users.
- **Adoption surface:** Separate task t005 for host-support docs.

## Validation evidence

Pending.
