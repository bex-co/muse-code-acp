# w3 · m5 — Release 0.9.0 and report host regressions upstream

**Worker:** worker1 **Goal:** The SDK 1.4.4 catch-up (and any completed m4 work) is published, and the Muse fork-boundary regression is reported to its maintainers. **Status:** done

## Tasks (in order)

| id   | title                                                   | est | depends_on             |
| ---- | ------------------------------------------------------- | --- | ---------------------- |
| t001 | Verify release readiness — **DONE**                     | 30m | —                      |
| t002 | Release commit and tag — **DONE**                       | 15m | w3/m5/t001             |
| t003 | Publish and verify npm — **DONE**                       | 15m | w3/m5/t002             |
| t004 | Report the fork-boundary regression upstream — **DONE** | 30m | —                      |
| t005 | Close out milestone — **DONE**                          | 15m | w3/m5/t003, w3/m5/t004 |

## Definition of done

- npm `latest` is the new version, built from its tag on `main` by the Publish and Release workflow.
- A public-safe upstream report of the fork-boundary regression exists, posted with user approval, and is linked from the board.

## Source + Goal linkage

- **Source:** SDK 1.4.4 bump `e842e9a` (unreleased on 2026-10-08) and w3/003, promoted here (preserved below).
- **Goal linkage:** Dependable installation (fixes reach users only when published) and truthful host support (upstream owns the fork regression).
- **Expected outcome:** npm users get SDK 1.4.4 and Muse 1.4.4 support; Muse maintainers can fix forking at earlier turns.
- **Why now:** Muse auto-updates users to 1.4.4, and the published 0.8.0 does not advertise workflow cancel there.
- **Ordering:** independent of m4; release whatever is complete on `main` when t001 runs. Version is 0.8.1 for the SDK bump alone; choose 0.9.0 if m4's mode changes land first.
- **Sizing:** release and upstream report are distinct outward-facing steps with approval gates.
- **Adoption surface / Simplify / CI:** omitted — the changelog is updated in t002, there are no code changes, and the publish workflow reruns CI on the tag.
- **Constraints:** publishing (t003) and the upstream post (t004) require explicit user approval at execution time.

## Preserved note

### 003 — Report the Muse 1.4.3 fork-boundary regression upstream

Why: Users cannot fork at an earlier completed turn on Muse 1.4.3, and only the host can fix it.

Evidence (w3/m2/t001): on `1.4.3-R5018.1`, public `session/fork` with `cutPoint.lastTurnId` naming any completed turn except the latest fails `forkBoundaryInvalid` / `InvalidCut`; the latest succeeds. The host's exported schema (`muse schema generate-ts`, `ForkCutPoint`) documents any completed turn as valid. Reproduce with the loopback provider and three turns (no paid tokens). Re-confirmed on 1.4.4-R5419.1 by the enumerated live test (2026-10-08).

Acceptance after enablement: when a fixed host ships, re-verify and remove its build from `FORK_CUT_LATEST_ONLY` in `src/tests/acp-real-host-helpers.ts`.

## Validation evidence

`v0.9.0` (`3a97f71`) published by Publish and Release run 37885796547; npm `latest` is 0.9.0. Release CI reran Build, Muse loopback integration (1.1.1) and Standalone macOS ARM64 on the tag. Upstream report: [meta-models/muse-code-sdk#97](https://github.com/meta-models/muse-code-sdk/issues/97).
