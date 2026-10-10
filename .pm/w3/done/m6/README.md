# w3 · m6 — Exec default-mode continuity and stall triage

**Worker:** worker1 **Goal:** Know whether Default-mode exec really stalls after a refused write and stop it hanging users if so, and pursue the only real fix for unloadable Default-mode exec sessions upstream while steering users to the SDK backend meanwhile. **Status:** done

## Tasks (in order)

| id   | title                                                                      | est | depends_on                         |
| ---- | -------------------------------------------------------------------------- | --- | ---------------------------------- |
| t001 | Capture the Default-mode exec stall — **DONE**                             | 1h  | —                                  |
| t002 | Answer reminder decisions in the loopback stub and rerun — **DONE**        | 45m | w3/m6/t001                         |
| t003 | Confirm a persisting stall with one real-provider turn — **DONE**          | 30m | w3/m6/t002                         |
| t004 | Report a confirmed stall upstream and fail stalled exec prompts — **DONE** | 1h  | w3/m6/t003                         |
| t005 | Request serve support for :auto-review sessions upstream — **DONE**        | 30m | —                                  |
| t006 | Adoption surface — **DONE**                                                | 30m | w3/m6/t002, w3/m6/t004, w3/m6/t005 |
| t007 | Simplify milestone changes — **DONE**                                      | 30m | w3/m6/t006                         |
| t008 | CI and behavior coverage — **DONE**                                        | 45m | w3/m6/t007                         |
| t009 | Close out milestone — **DONE**                                             | 15m | w3/m6/t008                         |

## Definition of done

- The Default-mode exec stall is attributed with evidence: either the loopback stub caused it (stub fixed, a Default-mode refused-write turn completes in a live test) or Muse does (confirmed with a real provider, reported upstream, and the exec backend fails a stalled prompt with a truthful error after a bounded deadline instead of hanging).
- An upstream request asks Muse to let `muse serve` load `:auto-review` sessions or to offer a public profile override on resume, posted with user approval and linked here.
- Docs tell users to keep the default SDK backend when sessions must be resumable, and state the Default-mode exec limitation with the upstream link.

## Source + Goal linkage

- **Source:** promoted from w3/004 (preserved below) and the 2026-10-09 resolution plan for the remaining w3 limitations (user request "how to resolve", options A–D).
- **Goal linkage:** Session continuity and truthful behavior across backends; no hanging prompts.
- **Expected outcome:** Exec-backend users either never hang after a refused tool call or get a clear error; everyone knows how to keep sessions resumable; Muse maintainers have a concrete request for the root cause.
- **Why now:** These are the last open limitations after 0.9.0; a confirmed stall could hang Default-mode exec prompts after a refused tool call. The existing loopback observation does not establish how often real-provider turns are affected.
- **Options recorded:** (A) upstream request — t005; (B) steer users to the SDK backend — t006. (C) read-only history fallback through `muse export` when SDK load is refused — deferred: it gives only a read-only view, reconsider on user demand. (D) another Default-mode exec profile — rejected: `:unrestricted` skips approval (DO_NOT_DO), and `:ask-me` / `:read-only` were not loadable-and-usable in w3/m4/t002.
- **Conditional tasks:** t003 applies only if the stall persists after t002. t004 applies only if t003 confirms the same refused-write stall with a real provider. If t002 resolves the stall, close both by triage with its live refused-write evidence. If the real-provider refused-write turn completes while the stub still stalls, return to harness attribution and repair before closing t004 or the milestone. A turn without an observed refusal is inconclusive. t003 spends real provider tokens and t004/t005 post upstream: each needs explicit user approval at execution time; read-only issue searches and local drafts can proceed independently.
- **Adoption surface:** separate task t006.

## Preserved note

### 004 — Investigate default-mode exec stalling after a refused write

Why: If `muse exec` never finishes after its reviewer refuses a tool call, exec-backend prompts in Default mode would hang instead of ending.

Observed 2026-10-08 on Muse 1.4.4-R5419.1 during w3/m4/t002, loopback provider, no paid tokens: in Default mode (no mode flags) a scripted `bash` write was refused by the approval reviewer ("bash accepts only foreground read-only inspection commands …"), then `muse exec` produced no further events and did not exit within 180 s. The same happened with `--permission-profile :ask-me` and `:read-only` (60 s cap); `:unrestricted` wrote and exited. Not yet attributed: the loopback stub (reminder children, judge requests) may be the cause rather than Muse.

Acceptance: determine whether the stall reproduces with a real provider or a stub that mirrors Muse's follow-up requests; if it is real, report upstream with a minimal reproduction and make the exec backend fail the prompt with a truthful error instead of hanging; otherwise fix the loopback stub and record the evidence here.

## Validation evidence

### Triage — 2026-10-09

Reviewed repository commit `1d0258485018c7f24c39a4171c7eba5d9586329e` with Muse Code `1.4.4-R5419.1` installed and `@muse-code/sdk@1.4.4` pinned. All nine tasks remain `todo`; none has its full acceptance evidence. IDs, dependencies, task count and archive placement agree, and there are no dependency cycles or external dependents on this milestone.

| Tasks     | Finding and next action                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| t001      | First actionable task. [w3/m4/t002](../done/m4/done/t002.md) records the 180 s refusal/stall, but not timestamped provider replies or the last durable session record. Capture those before attributing the stall.                                                                                                                                                                                                          |
| t002      | `src/tests/loopback-provider.ts` still sends plain text for reminder-only requests; `src/tests/loopback-provider.test.ts` explicitly expects no reminder function call. Update that expectation while preserving the assertion that reminders do not consume the scripted bash call. `exec-profile-live.test.ts` covers Read-only continuity, not Default-mode refusal/completion.                                          |
| t003–t004 | Conditional and unresolved. The existing `PendingWorkWatchdog` is used by `src/muse-sdk.ts` for pending SDK approvals/user input. `spawnMuseExec` ends its event stream when the child closes, and the exec prompt awaits that stream and child exit without a refusal deadline. Existing watchdog tests do not satisfy t004.                                                                                               |
| t005      | Independent of the stall investigation. Open upstream [#80](https://github.com/meta-models/muse-code-sdk/issues/80) already requests a serve reviewer; [#43](https://github.com/meta-models/muse-code-sdk/issues/43) covers profiles more broadly. Neither searched report provides the saved-session refusal reproduction. A supplemental comment for #80 is drafted in [t005](t005.md); posting remains pending approval. |
| t006      | README and `docs/sdk-migration.md` already describe `:auto-review` load/resume refusal and the Read-only/Plan exception. Still missing: explicit advice to keep the default SDK backend for resumability, the upstream link, and the attributed stall outcome.                                                                                                                                                              |
| t007–t009 | Remain open until implementation, adoption docs, final checks and the definition of done are verified. CI pins Muse `1.1.1-R2514.1`; green baseline CI alone cannot verify this `1.4.4-R5419.1` scenario.                                                                                                                                                                                                                   |

- **Related host report:** [#63](https://github.com/meta-models/muse-code-sdk/issues/63) concerns reminder-report denial under SDK `denyUnmatched` and is closed; maintainers [report a host fix in 1.4.2](https://github.com/meta-models/muse-code-sdk/issues/63#issuecomment-6003422348). It is a diagnostic lead, not proof that the Default-mode exec stall on 1.4.4 is fixed or has the same cause.
- **Read-only upstream check:** `gh issue list --repo meta-models/muse-code-sdk --state all` with searches `reviewer`, `reminder`, `"auto-review"` and `"resume_refused_class_c"`, plus issue/comment inspection. No report matching the last search was returned. No upstream content was posted.
- **Focused existing behavior checks:** `npx vitest run src/tests/loopback-provider.test.ts src/tests/exec-profile.test.ts src/tests/muse-sdk-host.test.ts src/tests/pending-watchdog.test.ts` — **4 files, 22 tests passed**. These deterministic checks establish the current contracts; they do not reproduce or attribute the live exec stall.
- **Remaining acceptance evidence:** t001/t002 live capture and rerun, any conditional real-provider confirmation, approved upstream posting, and final milestone CI remain pending. No paid-provider turn or new live stall reproduction was run during triage.

### Run — 2026-10-09 (loopx)

- t001/t002 done: the w3/004 stall was a loopback artifact (the stub injected its scripted `bash` into the approval reviewer and never submitted an assessment). With a schema-valid reviewer, `approve` completes; `escalate` hangs headless `muse exec` after `task.lifecycle.proposed`.
- t004 prepared, not closed (the conditional rule requires t003 first): `spawnMuseExec` stops a run whose proposed tool gets no follow-up event within `MUSE_CODE_ACP_EXEC_APPROVAL_STALL_MS` (default 120 s) and the prompt fails with an actionable error; deterministic tests `src/tests/exec-approval-stall.test.ts` (2/2) and live `escalate` case (fails within 5 s instead of hanging, 2/2 runs). Upstream issue drafted in t004.
- Open questions for the user: approve one tiny real-provider turn for t003 that provokes a reviewer escalation (throwaway repo, harmless command such as a force-push with no remote); approve posting the t004 issue (after t003) and the t005 #80 comment.

### Final validation — 2026-10-09

Muse host `1.4.4-R5419.1`, `@muse-code/sdk` 1.4.4, macOS arm64.

- `npm run check`, `npm run build`: clean.
- `npm run test:unit`: 497/500 under load; the three failures (resume-timeout, exec-profile probe at 5.3 s, steering) each passed 3/3 in isolation. The exec-profile probe test now has an explicit 30 s timeout.
- `MUSE_CODE_ACP_REQUIRE_MUSE=1` loopback suite, `--no-file-parallelism`: 19 files, 64/65; the one failure (`stored-output-live`) passed 2/2 in isolation. The new Default-mode approve/escalate live cases passed.
- Real provider: two approved turns (t003), neither escalated.
- Upstream: [#99](https://github.com/meta-models/muse-code-sdk/issues/99) (escalation hang, evidence scope stated) and a [#80 comment](https://github.com/meta-models/muse-code-sdk/issues/80#issuecomment-6094816450) (serve reviewer / profile override).
- Remaining limitation: Default-mode exec sessions keep `:auto-review` and stay unloadable through serve until upstream #80 lands.
