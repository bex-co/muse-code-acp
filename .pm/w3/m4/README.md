# w3 · m4 — Exec backend fidelity on Muse 1.4.x

**Worker:** worker1 **Goal:** The opt-in exec backend offers only effort values `muse exec` accepts, and new exec sessions stay loadable through the default SDK backend, without changing approval or sandbox safety the user did not choose. **Status:** todo

## Tasks (in order)

| id   | title                                                  | est | depends_on             |
| ---- | ------------------------------------------------------ | --- | ---------------------- |
| t001 | Offer only exec-accepted efforts for the meta provider | 45m | —                      |
| t002 | Measure exec permission profiles per ACP mode          | 1h  | —                      |
| t003 | Apply the chosen exec permission profiles              | 1h  | w3/m4/t002             |
| t004 | Adoption surface                                       | 30m | w3/m4/t001, w3/m4/t003 |
| t005 | Simplify milestone changes                             | 30m | w3/m4/t004             |
| t006 | CI and behavior coverage                               | 45m | w3/m4/t005             |
| t007 | Close out milestone                                    | 15m | w3/m4/t006             |

## Definition of done

- Under `MUSE_CODE_ACP_BACKEND=exec` with the meta provider, the effort menu omits `none` (or maps it truthfully), settings `none` falls back with the #11 log line, and the echo provider keeps its behavior; tests cover both providers.
- A session created through the exec backend in each ACP mode on Muse 1.4.4 can be loaded and continued through the SDK backend, or the mode keeps today's behavior with a documented reason; approval and sandbox behavior per mode matches the user-approved mapping from t002/t003.
- No mode defaults to bypassing approval or sandbox (DO_NOT_DO).

## Source + Goal linkage

- **Source:** promoted from w3/001 and w3/002 (2026-10-08), both re-verified on Muse 1.4.4-R5419.1. See the original notes preserved below.
- **Goal linkage:** Truthful capabilities and session continuity across the two backends.
- **Expected outcome:** Exec-backend users get no unusable effort choice, and their sessions survive switching to the default backend.
- **Why now:** Muse 1.4.3+ made new exec sessions unloadable by default; the `none` rejection is a visible failure.
- **Decision gate:** t003 changes exec approval semantics and needs an explicit user decision on the profile per mode, informed by t002. Loop work must stop at t003 until that decision is recorded here.
- **Adoption surface:** Separate task t004 (README exec section, `docs/sdk-migration.md`, mode descriptions).

## Preserved notes

### 001 — Exec backend offers `none`, which `muse exec` 1.4.x rejects for the meta provider

Why: An exec-backend user who picks `none` gets a failed turn instead of a usable effort choice.

Observed on Muse 1.4.2 and again on 1.4.4-R5419.1: `muse exec --reasoning-effort none` exits with "--reasoning-effort none is not supported with --provider meta; choose minimal|low|medium|high|xhigh|max|ultra". `muse exec --help` still lists `none`, so help text cannot detect it. The SDK path maps `none` to `minimal` on 1.2.1+.

### 002 — Keep new exec-backend sessions resumable through the SDK backend

Why: Sessions created through the exec backend on Muse 1.3.0-R3401.1+ get `:auto-review` and cannot be loaded through the default SDK backend.

Triage on 1.4.3 (re-confirmed by the enumerated live tests on 1.4.4): `muse exec` commits the built-in `:auto-review` profile by default; `muse serve` refuses it (`resume_refused_class_c`). A `muse exec --permission-profile :ask-me` session read fine through serve, and `:unrestricted` committed correctly. Candidate: pass `--permission-profile` from `src/muse-exec.ts` (args near line 54) or the mode → flags mapping (`src/modes.ts`), feature-detected via `muse exec --help`. Existing `:auto-review` sessions stay unreadable through serve; routing them to the exec backend is a larger, separate change.

## Validation evidence

Pending.
