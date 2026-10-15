# w3 · m19 — Standard ACP session state and stop reasons

**Worker:** worker1 **Goal:** Clients that negotiate ACP 1.8 session state and error stop reasons receive accurate, host-backed state; other clients see unchanged behavior. **Status:** todo

## Tasks (in order)

| id   | title                                                      | est | depends_on                            |
| ---- | ---------------------------------------------------------- | --- | ------------------------------------- |
| t001 | Implement backed standard session state and stop reasons   | 3h  | w3/m17/t003, w3/m18/t003, w3/m18/t004 |
| t002 | Cover negotiated and fallback paths on fake and real hosts | 2h  | w3/m19/t001                           |
| t003 | Adoption surface                                           | 30m | w3/m19/t001, w3/m19/t002              |
| t004 | Simplify milestone changes                                 | 30m | w3/m19/t003                           |
| t005 | CI and behavior coverage                                   | 45m | w3/m19/t001, w3/m19/t002, w3/m19/t004 |
| t006 | Close out milestone                                        | 15m | w3/m19/t005                           |

## Definition of done

- For a client that negotiates the standard capabilities, a real-host turn produces running → requires-action (while a permission or user-input request is actually pending) → running → idle, and a failed turn ends with the standard error stop reason carrying the existing failure data. Verified in wire tests and on the installed Muse host.
- Clients that do not negotiate see unchanged notifications; existing wire tests pass unmodified.
- Only types w3/m17/t003 classifies as backed are implemented; others stay unadvertised with reasons in `docs/capability-audit.md`. `CompactionUpdate` stays deferred to w3/m9.
- Unstable schema types are implemented only behind explicit client negotiation and documented as such. If w3/m17/t003 finds nothing backed, this milestone is reshaped or dropped with that evidence instead of being implemented.

## Source + Goal linkage

- **Source:** 2026-10-15 `/pm-brainstorm` "to improve code quality and ensure it's best muse code acp on the market", materialized by `/pm them all for w3`. ACP SDK 1.8.0 adds `StateUpdate` (`Idle`/`Running`/`RequiresAction`), `ErrorStopReason`, `Notice`, `SubagentUpdate`, `CompactionUpdate` and `SessionCancelCapabilities` (full diff in w3/m17).
- **Goal linkage:** Usable editor integration through standard ACP rather than Muse-specific `muse/*` extensions and progress text.
- **Expected outcome:** Any ACP 1.8 editor can show busy, waiting-for-user and error state for Muse sessions without Muse-specific code.
- **Why now:** The standard types become available with w3/m17, and the w3/m18 refactor gives the turn lifecycle a single place to emit them.
- **Adoption surface:** Separate task t003: README capability table, `docs/progress.md`, `docs/failures.md`, `docs/capability-audit.md`. No editor UI behavior is promised.
- **Constraints:** No fabricated state: requires-action only reflects real pending host requests, and approvals the Muse reviewer resolves (`resolvedBy: "llmJudge"`, see dropped note 008 in the w3 index) do not produce it unless the host escalates. Permission cancellation, dismissal and stale-decision semantics are unchanged (DO_NOT_DO).

## Validation evidence

Not yet run.
