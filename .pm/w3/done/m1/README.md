# w3 · m1 — Profiled catalog model selection and catalog-aware default

**Worker:** worker1 **Goal:** Users on Muse 1.3+ catalogs see and can select every catalog model, without duplicate entries, and get a default model the host actually offers. **Status:** done

## Tasks (in order)

| id   | title                                                           | est | depends_on                         |
| ---- | --------------------------------------------------------------- | --- | ---------------------------------- |
| t001 | Adopt PR #10 profiled catalog routing — **DONE**                | 45m | —                                  |
| t002 | Collapse duplicate entries for unprofiled selections — **DONE** | 1h  | w3/m1/t001                         |
| t003 | Catalog-aware default model — **DONE**                          | 1h  | w3/m1/t001                         |
| t004 | Adoption surface — **DONE**                                     | 30m | w3/m1/t001, w3/m1/t002, w3/m1/t003 |
| t005 | Simplify milestone changes — **DONE**                           | 30m | w3/m1/t004                         |
| t006 | CI and behavior coverage — **DONE**                             | 45m | w3/m1/t005                         |
| t007 | Close out milestone — **DONE**                                  | 15m | w3/m1/t006                         |

## Definition of done

- With a catalog whose rows all carry a `profileId` (the Muse 1.3/1.4 Meta shape), the SDK model menu lists every catalog model once and selecting a profiled model routes `session/setModel` with that profile; deterministic tests cover it.
- A current selection without a profile that matches exactly one catalog row is shown as that row; no `(meta)` / `(meta / tbh)` duplicate pair appears, including for sessions saved by earlier versions.
- When settings name no model, the default comes from the discovered catalog (the non-contributor variant of the catalog default when listed); without a catalog, the static `muse-spark-1.2` fallback and the exec `KNOWN_MODELS` list stay consistent.
- PR #10 author credit is preserved in history and the changelog.

## Source + Goal linkage

- **Source:** [PR #10](https://github.com/bex-co/muse-code-acp/pull/10) by jean-losi (head commits `90eacf0`, `0b5c7b4`) and its 2026-10-06 triage. Live on Muse 1.4.3 with a Meta account, `model/list` returned four rows all with `profileId: "tbh"`; `main` (`3ea3213`) showed only the settings model and rejected the profiled `muse-spark-1.2` with "Named model profile routing is unverified". The PR build listed all four and a profiled `muse-spark-1.2` turn was recorded by Muse as `model_id: muse-spark-1.2`, `profile_id: tbh`. A rebase onto `3ea3213` (only `CHANGELOG.md` conflicted) exists locally as branch `pr10-rebased` (`105ce49`, `569400f`); reproduce from the PR head if that branch is gone.
- **Goal linkage:** Truthful capabilities and usable editor integration: the model menu must reflect what the host offers.
- **Expected outcome:** Muse 1.3+ users pick any catalog model from their ACP client.
- **Why now:** Every Muse 1.3+ Meta account is affected; this blocks 0.8.0 (w3/m3).
- **Adoption surface:** Separate task t004 — `docs/capability-audit.md:61` still says named profile routing is unverified, and `docs/sdk-migration.md` / README model sections describe the old filter.

## Validation evidence

Muse host `1.4.3-R5018.1`, `@muse-code/sdk` 1.3.0, macOS arm64, 2026-10-06.

- `npm run check`: clean. `npm run build`: clean.
- `npm run test:unit`: 76 files, 491/491 passed.
- `MUSE_CODE_ACP_REQUIRE_MUSE=1 npm run test:muse-loopback`: 12 failed in parallel; serial rerun of the failing files (`--no-file-parallelism`) left 5, identical to `main` before this milestone: `muse-sdk-live` resume, `acp-restart-live` load and resume (legacy `:auto-review` host list), `session-fork-live` (`forkBoundaryInvalid`), `workflows-live` (denial text). All five are w3/m2 scope; the others were load-induced timeouts.
- Real-host menu and routing on 1.4.3 were confirmed during PR #10 triage (four profiled catalog rows listed; a profiled `muse-spark-1.2` turn recorded by Muse as `model_id: muse-spark-1.2`, `profile_id: tbh`). No paid-provider turn was run in this milestone.
- Limitation: profile routing on Muse 1.1.1 / 1.2.1 is untested; a rejection surfaces as the explicit setModel error.
