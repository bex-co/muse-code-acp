# w3 · m3 — Release 0.8.0

**Worker:** worker1 **Goal:** 0.8.0 is published to npm with the `max` effort fix, profiled catalog selection and Muse 1.4.3 compatibility, and contributors are informed. **Status:** done

## Tasks (in order)

| id   | title                                    | est | depends_on             |
| ---- | ---------------------------------------- | --- | ---------------------- |
| t001 | Verify release readiness — **DONE**      | 30m | w3/m1/t007, w3/m2/t008 |
| t002 | Release commit and tag v0.8.0 — **DONE** | 15m | w3/m3/t001             |
| t003 | Publish 0.8.0 and verify npm — **DONE**  | 15m | w3/m3/t002             |
| t004 | GitHub housekeeping for 0.8.0 — **DONE** | 15m | w3/m3/t003             |
| t005 | Close out milestone — **DONE**           | 15m | w3/m3/t004             |

## Definition of done

- `npm view @bex-co/muse-code-acp version` is 0.8.0, built from tag `v0.8.0` on `main` by the Publish and Release workflow.
- #9, #10 and #12 are closed with user-approved comments; #11 and #13 note the release.

## Source + Goal linkage

- **Source:** 2026-10-06 release-readiness triage: `main` has `3ea3213` (fixes #11, #13) unreleased; PR #10 and the 1.4.3 failures were judged release blockers.
- **Goal linkage:** Dependable installation: fixes reach users only through a published release.
- **Expected outcome:** npm users get the fixes; contributors see their work acknowledged.
- **Why now:** #11 and #13 are closed on GitHub but unreleased.
- **Sizing:** Release, publish and contributor follow-up are distinct gated steps with outward-facing approvals.
- **Adoption surface:** Omitted — the changelog is updated in t002 and docs in m1/m2.
- **Simplify / CI:** Simplify omitted (no code changes); CI is verified in t001 and re-run by the publish workflow.
- **Constraints:** Publishing (t003) and GitHub comments (t004) require explicit user approval at execution time.

## Validation evidence

`v0.8.0` (`170a1c3`) published by Publish and Release run 37747781923; npm `latest` is 0.8.0. Release CI reran Build, Muse loopback integration and Standalone macOS ARM64 on the tag. Contributor PRs and issues closed or answered with user-approved comments.
