# w3 · m6 — Exec default-mode continuity and stall triage

**Worker:** worker1 **Goal:** Know whether Default-mode exec really stalls after a refused write and stop it hanging users if so, and pursue the only real fix for unloadable Default-mode exec sessions upstream while steering users to the SDK backend meanwhile. **Status:** todo

## Tasks (in order)

| id   | title                                                           | est | depends_on                         |
| ---- | --------------------------------------------------------------- | --- | ---------------------------------- |
| t001 | Capture the Default-mode exec stall                             | 1h  | —                                  |
| t002 | Answer reminder decisions in the loopback stub and rerun        | 45m | w3/m6/t001                         |
| t003 | Confirm a persisting stall with one real-provider turn          | 30m | w3/m6/t002                         |
| t004 | Report a confirmed stall upstream and fail stalled exec prompts | 1h  | w3/m6/t003                         |
| t005 | Request serve support for :auto-review sessions upstream        | 30m | —                                  |
| t006 | Adoption surface                                                | 30m | w3/m6/t002, w3/m6/t004, w3/m6/t005 |
| t007 | Simplify milestone changes                                      | 30m | w3/m6/t006                         |
| t008 | CI and behavior coverage                                        | 45m | w3/m6/t007                         |
| t009 | Close out milestone                                             | 15m | w3/m6/t008                         |

## Definition of done

- The Default-mode exec stall is attributed with evidence: either the loopback stub caused it (stub fixed, a Default-mode refused-write turn completes in a live test) or Muse does (confirmed with a real provider, reported upstream, and the exec backend fails a stalled prompt with a truthful error after a bounded deadline instead of hanging).
- An upstream request asks Muse to let `muse serve` load `:auto-review` sessions or to offer a public profile override on resume, posted with user approval and linked here.
- Docs tell users to keep the default SDK backend when sessions must be resumable, and state the Default-mode exec limitation with the upstream link.

## Source + Goal linkage

- **Source:** promoted from w3/004 (preserved below) and the 2026-10-09 resolution plan for the remaining w3 limitations (user request "how to resolve", options A–D).
- **Goal linkage:** Session continuity and truthful behavior across backends; no hanging prompts.
- **Expected outcome:** Exec-backend users either never hang after a refused tool call or get a clear error; everyone knows how to keep sessions resumable; Muse maintainers have a concrete request for the root cause.
- **Why now:** These are the last open limitations after 0.9.0; a real stall would hang every Default-mode exec prompt whose tool call is refused.
- **Options recorded:** (A) upstream request — t005; (B) steer users to the SDK backend — t006. (C) read-only history fallback through `muse export` when SDK load is refused — deferred: it gives only a read-only view, reconsider on user demand. (D) another Default-mode exec profile — rejected: `:unrestricted` skips approval (DO_NOT_DO), and `:ask-me` / `:read-only` were not loadable-and-usable in w3/m4/t002.
- **Conditional tasks:** t003 and t004 apply only if the stall persists after t002; otherwise close them by triage with t002 evidence. t003 spends real provider tokens and t004/t005 post upstream: each needs explicit user approval at execution time.
- **Adoption surface:** separate task t006.

## Preserved note

### 004 — Investigate default-mode exec stalling after a refused write

Why: If `muse exec` never finishes after its reviewer refuses a tool call, exec-backend prompts in Default mode would hang instead of ending.

Observed 2026-10-08 on Muse 1.4.4-R5419.1 during w3/m4/t002, loopback provider, no paid tokens: in Default mode (no mode flags) a scripted `bash` write was refused by the approval reviewer ("bash accepts only foreground read-only inspection commands …"), then `muse exec` produced no further events and did not exit within 180 s. The same happened with `--permission-profile :ask-me` and `:read-only` (60 s cap); `:unrestricted` wrote and exited. Not yet attributed: the loopback stub (reminder children, judge requests) may be the cause rather than Muse.

Acceptance: determine whether the stall reproduces with a real provider or a stub that mirrors Muse's follow-up requests; if it is real, report upstream with a minimal reproduction and make the exec backend fail the prompt with a truthful error instead of hanging; otherwise fix the loopback stub and record the evidence here.

## Validation evidence

Pending.
