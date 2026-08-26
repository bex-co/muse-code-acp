# w1 · m1 — Walking skeleton: scaffold + ACP shell + echo-provider turn

**Worker:** worker1 **Goal:** a buildable `muse-code-acp` package whose ACP server completes a full prompt turn (streamed text + end_turn + cancel) against `muse exec --provider echo --json`, proving the process-per-turn architecture end to end before any real-model work. **Status:** todo (t001–t002 done)

## Tasks (in order)

| id   | title                                                              | est | depends_on |
| ---- | ------------------------------------------------------------------ | --- | ---------- |
| t001 | Scaffold repo: package, tooling, CI transplant — **DONE**          | 45m | —          |
| t002 | Transplant vendor-neutral shell (utils, index, logging) — **DONE** | 45m | t001       |
| t003 | ACP wiring: runAcp, ClientConnection seam, initialize + new        | 60m | t002       |
| t004 | Muse exec runner: spawn, JSONL parser, exit-code mapping           | 60m | t001       |
| t005 | Minimal prompt loop: text streaming, end_turn, cancel              | 60m | t003, t004 |
| t006 | Simplify pass over milestone changes                               | 30m | t005       |
| t007 | Test coverage for shipped behavior                                 | 45m | t006       |
| t008 | Closeout                                                           | 15m | t007       |

## Definition of done

`npm run build`, `npm run check`, and `npm run test:run` pass. A test harness (ACP client over stdio) can `initialize`, `session/new`, send `session/prompt`, and receive streamed `agent_message_chunk` updates followed by an `end_turn` stop reason, all backed by a spawned `muse exec --provider echo --json --no-session-log` child. `session/cancel` mid-turn kills the child (SIGINT) and resolves the prompt with a `cancelled` stop reason. No real-model calls anywhere in the suite.

## Source + Goal linkage

- **Source:** claude-agent-acp → muse-code-acp porting research (this repo's conversation, 2026-08-25): architecture recommendation "new repo, transplant the ACP shell, wrap `muse exec --json` per turn", verified against the installed `muse` 0.2.1 binary and its echo provider.
- **Goal linkage:** ships the first ACP adapter for Muse Code; this milestone de-risks the core architectural bet (process-per-turn JSONL translation) with zero API cost.
- **Expected outcome:** a runnable `muse-code-acp` binary an ACP client can speak to for text-only turns; recorded echo fixtures and a reusable event-envelope parser for m2.
- **Why now:** everything else (tool calls, permissions, sessions) layers on the runner + shell; building the skeleton first keeps m2/m3 tasks small and independently testable.
- **Render parity omitted:** that standing task is bex-specific (REST/GraphQL/MCP/dashboard surfaces); this project has none — its user surface is the ACP protocol itself, covered by the test-coverage task.
