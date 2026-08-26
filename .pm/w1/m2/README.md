# w1 · m2 — Real turn translation: tool calls, modes, cancellation, continuity

**Worker:** worker1 **Goal:** a real Muse Spark turn renders faithfully in an ACP client — tool calls with results and diffs, honest permission-mode mapping, robust error/stop-reason handling, and multi-turn session continuity via `--session-id`. **Status:** todo (t001–t003 done)

## Tasks (in order)

| id   | title                                                          | est | depends_on             |
| ---- | -------------------------------------------------------------- | --- | ---------------------- |
| t001 | Tool-call translation: intents, results, tool kinds — **DONE** | 60m | —                      |
| t002 | Edit/diff surfacing in tool_call updates — **DONE**            | 45m | t001                   |
| t003 | Turn lifecycle + error taxonomy: failures, stop reasons        | 45m | t001                   |
| t004 | Permission-mode mapping (report-only default, bypass)          | 45m | —                      |
| t005 | Model + reasoning-effort as ACP session config options         | 45m | —                      |
| t006 | Multi-turn continuity + resume-safety via --session-id         | 30m | t003                   |
| t007 | Simplify pass over milestone changes                           | 30m | t002, t004, t005, t006 |
| t008 | Test coverage for shipped behavior                             | 60m | t007                   |
| t009 | Closeout                                                       | 15m | t008                   |

## Definition of done

Against the real `meta` provider (one gated integration run) and against recorded real-provider fixtures (CI): a prompt that runs a shell command and edits a file produces ACP `tool_call` → `tool_call_update` sequences with correct tool kinds, statuses, output content, and a diff for the edit; `task.lifecycle.failed` / exit-code-1 turns surface as errors, not silent `end_turn`; a second `session/prompt` on the same ACP session continues the same Muse session (verified via session state carrying over); `session/set_mode` switches between the default (report-only, muse policy+judge) and bypass (`--disable-approval`) modes and the mode is visibly applied on the next spawn; model + reasoning-effort config options round-trip. Cancellation mid-tool-run leaves the session resumable (next prompt succeeds, no duplicate side effects).

## Source + Goal linkage

- **Source:** porting research event-mapping table (2026-08-25): `side_effect_intent`/`tool.result`/`task.lifecycle.output` observed live on muse 0.2.1 with `correlation_facts.tool_name` + `call_id` correlation; permission finding that headless approvals resolve via policy + LLM judge with no interactive pause.
- **Goal linkage:** this is the milestone that makes the adapter genuinely usable in an editor — tool visibility and honest permissions are the product.
- **Expected outcome:** a developer can run a real coding task from an ACP client and watch tool calls, outputs, and diffs stream in; degradations (no interactive approval, no thinking stream) are explicit, not silent.
- **Why now:** depends only on m1's runner/translator seam; blocks m3's session-history replay (which reuses the same translation for `session/load`).
- **Render parity omitted:** bex-specific standing task; no REST/GraphQL/MCP/dashboard surface in this project (see m1 README).
