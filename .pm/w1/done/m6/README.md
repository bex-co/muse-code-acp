# w1 · m6 — Session continuity and SDK default cutover

**Worker:** worker1 **Goal:** SDK execution becomes the default with preserved session history, truthful auth/config/MCP behavior, and required process-level integration tests. **Status:** done

## Tasks (in order)

| id   | title                                                              | est | depends_on |            |
| ---- | ------------------------------------------------------------------ | --- | ---------- | ---------- |
| t001 | Preserve durable session identity and SDK load semantics           | 60m | w1/m5/t010 | — **DONE** |
| t002 | Test complete history replay and pagination boundaries             | 60m | t001       | — **DONE** |
| t003 | Verify model, effort, and mode behavior through the SDK            | 45m | t002       | — **DONE** |
| t004 | Preserve authentication and advertised command behavior            | 45m | t003       | — **DONE** |
| t005 | Verify MCP configuration and overlay lifecycle under SDK execution | 45m | t004       | — **DONE** |
| t006 | Exercise real ACP process restart and legacy session continuity    | 60m | t005       | — **DONE** |
| t007 | Make protocol and real-host integration suites required CI checks  | 45m | t006       | — **DONE** |
| t008 | Switch the default backend to SDK and document compatibility       | 45m | t007       | — **DONE** |
| t009 | Simplify                                                           | 30m | t008       | — **DONE** |
| t010 | CI + test coverage                                                 | 45m | t008, t009 | — **DONE** |
| t011 | Closeout                                                           | 15m | t010       | — **DONE** |

## Definition of done

- Default startup selects sdk and the documented minimum compatible host. Explicit MUSE_CODE_ACP_BACKEND=exec still provides the named legacy path; unknown selectors fail clearly and SDK failures never silently rerun a turn through exec.
- Session list/load preserves workspace filtering, complete chronological history, stable IDs, and configuration semantics; UUIDv7 SDK sessions and existing UUIDv4 CLI sessions remain usable.
- A spawned ACP process can complete multiple turns, restart using the same isolated data directory, list/load history, and continue with the prior context through a real Muse host and loopback provider.
- Auth-required/logout/reauthentication, advertised commands, model/effort changes, default/readOnly behavior, and the private stdio MCP overlay have passing SDK compatibility tests.
- Documented read-only CLI/store/export helpers may remain where public SDK session APIs do not provide required legacy history. The default turn path uses the SDK and documentation names every remaining fallback.
- Normal CI runs deterministic ACP wire/SDK contracts with no external credentials. A required integration job provisions a verified Muse binary and runs real-host loopback restart and approval tests without silently skipping required scenarios.
- A locally packed adapter installs and initializes over stdio from a clean temporary directory, and the README/capability matrix accurately describes defaults, host requirements, mode differences, and migration/rollback.
- All preceding milestones and this milestone's implementation, simplify, and CI tasks meet their acceptance criteria before closeout; optional external-provider tests are reported separately.

## Source + Goal linkage

- **Source:** User request (2026-09-11) to migrate muse-code-acp to the [official Muse Code SDK](https://github.com/meta-models/muse-code-sdk) and add critical ACP execution tests inspired by `.tmp/codex-acp`; builds on the existing opt-in SDK implementation.
- **Goal linkage:** Finishes the requested migration as a usable default product rather than an opt-in execution experiment.
- **Expected outcome:** With no backend override, an installed adapter uses the SDK; an ACP client can create, cancel, restart, load, and continue a conversation, including legacy CLI-created sessions.
- **Why now:** m4 and m5 prove protocol and interaction semantics. Durable-session compatibility and reproducible CI evidence are the final gates before changing the default for existing users.
- **Cross-surface parity omitted:** This milestone changes the adapter, protocol boundary, tests, and documentation. It does not change a user-facing UI alongside a backend/API. ACP/backend contract assertions remain implementation work.

## Reference patterns and scope

- Reference session coverage: `.tmp/codex-acp/src/__tests__/CodexACPAgent/thread-history.test.ts`, `load-session.test.ts`, `list-sessions.test.ts`, and `session-config-options.test.ts`.
- Reference integration patterns: `.tmp/codex-acp/src/__tests__/CodexACPAgent/e2e/spawned-agent-fixture.ts` and `acp-e2e-session-persistence.test.ts`. The reference persistence case is currently skipped; reproduce the behavior with a deterministic provider and an executed test.
- Existing compatibility code lives in src/session-store.ts, src/session-export.ts, src/auth.ts, src/config-options.ts, src/modes.ts, src/skills.ts, and src/mcp-overlay.ts. Retain useful verified behavior instead of duplicating it in an SDK-specific fork.
- Prefer declared SDK session/history operations; do not assume the high-level facade exposes list/history/config helpers it does not have. The m4 support matrix determines permitted typed commands and bounded fallbacks.
- The minimal cutover retains one Muse serve host per turn and an explicit exec compatibility option. Host pooling, removal of every CLI helper, optional client filesystem/terminal delegation, remote MCP transports, and Codex/AIR extensions are deferred.
- Full protocol claims are scoped to the selected ACP major, mandatory methods/content, and actually advertised optional features. Unsupported capabilities stay absent; a terminal-looking tool update does not claim client terminal RPC support.

## Validation evidence (t010)

- Host: Muse Code 1.1.1; SDK `@muse-code/sdk` 0.1.1; ACP SDK 1.3.0
- `npm run build` + `npm run check` passed
- `npm run test:unit` — 147 deterministic tests passed (live suites excluded)
- `npm run test:pack-smoke` — packed install initialized over stdio
- `muse-sdk-approval-live` + `acp-restart-live` — 6 real-host tests passed
- Default backend is `sdk`; rollback via `MUSE_CODE_ACP_BACKEND=exec`
