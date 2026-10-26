# w3 · m20 — Release readiness from the Bex dogfood

**Worker:** worker1 **Goal:** The 0.11.0 release candidate works end to end in a real editor (Bex) on the newest stable Muse, including after `/compact` and an editor restart. **Status:** done

## Tasks (in order)

| id   | title                                                                   | est  | depends_on       |
| ---- | ----------------------------------------------------------------------- | ---- | ---------------- |
| t001 | Continue sessions Muse reports as running after compaction — **DONE**   | 1.5h | —                |
| t002 | Name blocking reminder cards and drop background reminders — **DONE**   | 1h   | —                |
| t003 | Keep message boundaries in history replay — **DONE**                    | 1h   | —                |
| t004 | Prewarm the session host and publish the model catalog early — **DONE** | 2.5h | —                |
| t005 | Advertise each command name once — **DONE**                             | 15m  | —                |
| t006 | Verify Muse 1.4.13 and move CI to it — **DONE**                         | 1h   | —                |
| t007 | Adoption surface — **DONE**                                             | 30m  | w3/m20/t001–t006 |
| t008 | Simplify milestone changes — **DONE**                                   | 30m  | w3/m20/t007      |
| t009 | CI and behavior coverage — **DONE**                                     | 45m  | w3/m20/t008      |
| t010 | Re-test the packed build in Bex — **DONE**                              | 1h   | w3/m20/t009      |
| t011 | Close out milestone — **DONE**                                          | 15m  | w3/m20/t010      |

## Definition of done

- In Bex 1.20 on Muse 1.4.13 with the packed build: a session that used tools, was compacted and was reopened after an editor restart accepts a new prompt; replayed history keeps message boundaries; no raw `reminderChild` cards; the model picker lists Muse's catalog before the first prompt; the first prompt does not wait for `session/start`.
- Unit, coverage, loopback (1.4.13) and GitHub CI pass.

## Source + Goal linkage

- **Source:** 2026-10-25 Bex dogfood of the packed 0.11.0 RC (user: "fix those issues, ship, and try again, until a state that this acp works very well and ready for release"). Evidence: wire logs under `/tmp/muse-acp-rc/logs` (local), SDK reproductions in the t001/t002/t004 notes. Absorbs inbox w3/015.
- **Goal linkage:** usable editor integration and session continuity — the release gate for 0.11.0.
- **Why now:** blocks the 0.11.0 release; `/compact` (w3/m9) would otherwise strand sessions.
- **Adoption surface:** separate task t007.
