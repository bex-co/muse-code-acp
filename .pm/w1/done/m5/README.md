# w1 · m5 — Interactive approvals and resilient SDK turns

**Worker:** worker1 **Goal:** ACP clients can genuinely gate Muse tool execution, answer supported user-input requests, cancel at every turn phase, and recover from stream gaps without duplicated side effects. **Status:** done

## Tasks (in order)

| id   | title                                                           | est | depends_on |            |
| ---- | --------------------------------------------------------------- | --- | ---------- | ---------- |
| t001 | Bridge real MSP approvals through ACP permission requests       | 60m | w1/m4/t009 | — **DONE** |
| t002 | Isolate permission lifetimes and concurrent request correlation | 45m | t001       | — **DONE** |
| t003 | Translate supported user input through ACP elicitation          | 60m | t002       | — **DONE** |
| t004 | Cover cancellation and turn settlement races                    | 45m | t003       | — **DONE** |
| t005 | Recover SDK view gaps without replaying execution               | 60m | t004       | — **DONE** |
| t006 | Handle backend failures and dispose stale session state         | 45m | t005       | — **DONE** |
| t007 | Prove approval decisions control real Muse tool effects         | 60m | t006       | — **DONE** |
| t008 | Simplify                                                        | 30m | t007       | — **DONE** |
| t009 | CI + test coverage                                              | 45m | t007, t008 | — **DONE** |
| t010 | Closeout                                                        | 15m | t009       | — **DONE** |

## Definition of done

- SDK approval requests traverse ACP and return a host-offered decision that genuinely gates tool execution; deny, cancellation, and invalid/stale responses cannot execute the protected operation.
- Permission correlation and scope are isolated by session, turn, request, and tool identity. Any durable scope is offered only when supported by the host and verified across its documented lifetime.
- Supported structured user input is delivered through the negotiated ACP elicitation surface, with validated responses and a bounded, non-granting fallback for unsupported clients or schemas.
- Cancellation during handshake, submit acknowledgement, streaming, tool execution, and pending interaction settles the ACP prompt once as cancelled; final updates precede that response and a subsequent turn succeeds.
- Recoverable view gaps use SDK replay/folding to restore ordered visible state without resubmitting a turn or duplicating text/tools. A stalled or failed fill produces an explicit error and usable recovery path.
- Crashes, EOF, protocol errors, launch/auth failures, client disconnects, and delayed foreign events leave no stale active turn, unresolved interaction, owned host, or MCP overlay.
- A real Muse host plus a loopback provider proves allow/deny/cancel effects on disposable files or commands. No required execution-gating test is skipped or replaced by a fake host.

## Source + Goal linkage

- **Source:** User request (2026-09-11) to migrate muse-code-acp to the [official Muse Code SDK](https://github.com/meta-models/muse-code-sdk) and add critical ACP execution tests inspired by `.tmp/codex-acp`; builds on the existing opt-in SDK implementation.
- **Goal linkage:** Completes the most consequential execution semantics missing from the initial SDK path so it can safely replace the default exec backend.
- **Expected outcome:** An ACP permission decision controls whether a real Muse tool runs; cancellation and recoverable delivery gaps leave the conversation usable for its next turn.
- **Why now:** m4 establishes public SDK lifecycle ownership and a real ACP wire harness. The current implementation explicitly fails approvals, user input, and view/gap; these must become tested behavior before default cutover.
- **Cross-surface parity omitted:** This milestone changes the adapter, protocol boundary, tests, and documentation. It does not change a user-facing UI alongside a backend/API. ACP/backend contract assertions remain implementation work.

## Reference patterns and scope

- `src/muse-sdk.ts` currently rejects approval/requested, userInput/requested, and view/gap. Extend that existing path and its fixtures rather than adding a second integration.
- Reference: `.tmp/codex-acp/src/__tests__/CodexACPAgent/approval-events.test.ts`, `elicitation-events.test.ts`, `session-close.test.ts`, `auth-error-events.test.ts`, and `process-exit-error.test.ts`; companion lifecycle tests live at `.tmp/codex-acp/src/__tests__/PermissionLifecycleContext.test.ts`.
- Use the public SDK Session approval handler and gap-fill facilities. Where user-input/cancel verbs lack facade helpers, use only exported typed Connection APIs identified in m4's support matrix.
- Normative cancellation reference: [ACP v1 prompt turns](https://agentclientprotocol.com/protocol/v1/prompt-turn). Updates may arrive while cancellation completes, but the turn's updates must be delivered before its cancelled prompt response.
- Adapt event-driven barriers and explicit decision/effect assertions from the reference. Do not copy its automatic retry policy, optional AIR error/steering schemas, or broad snapshots as a substitute for behavior checks.
- Per-turn host ownership continues. Cross-turn permission persistence must follow the actual host policy; do not promise an allow-always option merely because an editor supports that label.
