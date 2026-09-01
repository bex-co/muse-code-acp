# muse-code-acp

An [ACP](https://agentclientprotocol.com)-compatible coding agent powered by
[Muse Code](https://dev.meta.ai/docs/muse-code/), Meta's terminal coding agent.
Use Muse Code from any ACP client: Zed, VS Code (via
[`vscode-acp`](https://github.com/formulahendry/vscode-acp)), and others.

> **Unofficial adapter.** Muse Code and Muse Spark are products of Meta
> Platforms, Inc. This project is a community adapter and is not affiliated
> with, endorsed by, or supported by Meta.

## Quickstart

1. Install [Muse Code](https://dev.meta.ai/docs/muse-code/) (`muse`, >= 0.2.1)
   and make sure it is on `PATH` (or set `MUSE_CODE_EXECUTABLE`).
2. Authenticate: `muse login` (browser), or export `META_API_KEY`.
3. Install the adapter: `npm install -g @bex-co/muse-code-acp`.
4. Point your editor at it.

### Zed

```json
{
  "agent_servers": {
    "Muse Code": {
      "command": "muse-code-acp"
    }
  }
}
```

(Check Zed's [external agents docs](https://zed.dev/docs/ai/external-agents)
for the current settings shape.)

## How it works

Muse Code exposes Muse Session Protocol rather than ACP. This adapter uses its
headless `muse exec --json` surface: one process per prompt turn streaming JSONL
events, with conversation continuity through `--session-id` and Muse's
replay-exact session log. The adapter translates that stream into ACP session
updates:

| Muse                          | ACP                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `run.output.delta`            | `agent_message_chunk`                                                        |
| tool `side_effect_intent`     | `tool_call` (pending, policy verdict in `_meta`)                             |
| `tool.result`                 | `tool_call_update` (`rawInput` command, normalized output, diffs, locations) |
| `run.terminal.*` + exit code  | stop reason / error                                                          |
| session store + `muse export` | `session/list` + `session/load` history replay                               |
| `muse skills list`            | ACP slash commands (prompt passthrough)                                      |

## Capabilities

| Surface                                                       | Status                                             |
| ------------------------------------------------------------- | -------------------------------------------------- |
| Prompt turns with streamed text                               | ✅                                                 |
| Resource links                                                | ✅ (rendered as deterministic prompt context)      |
| PNG, JPEG, GIF, and WebP prompt images                        | ✅ (private turn-scoped files)                     |
| Audio and embedded resource blocks                            | ❌ (rejected with an actionable ACP error)         |
| Tool calls with results, diffs, locations                     | ✅ (title upgraded at result time)                 |
| Cancellation (`session/cancel` → SIGINT, safe resume)         | ✅                                                 |
| Session close (cancel, release adapter state, retain history) | ✅                                                 |
| Multi-turn sessions, `session/list`, `session/load`           | ✅                                                 |
| Session modes: default / read-only / bypass-approvals / yolo  | ✅ (see below)                                     |
| Model + reasoning-effort config options                       | ✅                                                 |
| Skills as slash commands                                      | ✅                                                 |
| Auth: browser login, `META_API_KEY`, logout                   | ✅                                                 |
| Interactive per-tool-call permission prompts                  | ❌ (muse limitation)                               |
| Thinking/reasoning stream                                     | ❌ (muse encrypts reasoning)                       |
| Client-provided stdio MCP servers                             | ✅ (see `docs/mcp-passthrough.md`)                 |
| Additional workspace directories                              | ❌ (muse supports one workspace root)              |
| Delegated workers                                             | ❌ (advertised in namespaced ACP metadata)         |
| Token usage                                                   | ❌ (muse does not expose it)                       |
| Editor-side file edits (fs proxying)                          | ❌ (muse edits in its own sandbox; diffs reported) |

### Honest limitations (muse 0.2.1)

- **No interactive approvals.** Muse's headless mode resolves tool approvals
  internally (policy engine + LLM judge). The adapter reports each decision
  (`_meta.musePolicyDecision` on tool calls) but cannot pause a tool call for
  your confirmation. Modes map onto muse's spawn-time safety flags instead:
  - `default` — approval policy + judge + OS sandbox, report-only
  - `readOnly` — `--disable-write --disable-shell`
  - `bypassApprovals` — `--disable-approval` (sandbox stays on)
  - `yolo` — muse's `--yolo`; hidden unless `MUSE_CODE_ACP_ALLOW_YOLO=1`,
    never available as root
    If muse nevertheless enters an approval wait, the adapter stops the child
    and fails the prompt clearly instead of leaving the ACP request blocked.
- **Mode/config changes apply from the next prompt** (flags are per-spawn).
- **Session close preserves Muse history.** It cancels active work and releases
  adapter resources. The native Muse session remains available to
  `session/list` and `session/load` until Muse removes it.
- **Exit code 0 means the turn completed,** not that your tests pass.
- **Per-turn spawn latency**: each prompt starts a fresh `muse exec`.
- **Images need accompanying text or a resource link.** Muse rejects an
  image-only headless prompt, so the adapter reports that requirement before
  starting the process.
- ACP-client-provided stdio MCP servers are merged with Muse's user-configured
  servers in a private per-turn settings overlay. The user's settings file is
  never modified, and the overlay is removed after the turn. HTTP, SSE, and
  ACP MCP transports are not advertised.
- **No additional workspace roots.** Muse's headless CLI exposes one workspace
  root, so the adapter does not advertise ACP `additionalDirectories`.

## Environment

| Variable                   | Effect                                              |
| -------------------------- | --------------------------------------------------- |
| `MUSE_CODE_EXECUTABLE`     | Path to the `muse` binary (else `PATH` lookup)      |
| `META_API_KEY`             | Headless auth (muse precedence: env > stored login) |
| `MUSE_AGENT_LOGS`          | Directory for adapter log files                     |
| `MUSE_CODE_ACP_ALLOW_YOLO` | `1` offers the yolo mode                            |

## Troubleshooting

- Adapter fails at startup with "Could not find the `muse` CLI" — install
  muse or set `MUSE_CODE_EXECUTABLE`.
- Auth errors mid-turn surface as ACP auth-required; run
  `muse-code-acp --cli login` in a terminal (it execs `muse login`).
- Set `MUSE_AGENT_LOGS=/tmp/muse-acp-logs` to capture spawn argv, skipped
  JSONL lines, and muse's stderr preamble.

## Development

```sh
npm run build         # tsc
npm run test:run      # vitest (offline; live echo-provider tests auto-skip without muse)
npm run check         # eslint + prettier
RUN_INTEGRATION_TESTS=true npm run test:integration   # one real-model turn
```

The work board lives in `.pm/` (workstream w1, milestones m1–m3).

## Roadmap (gated on Meta)

- Interactive approvals via blocking `PermissionRequest` hooks or an
  app-server mode, when muse ships one.
- Native delegated workers and token-usage receipts when muse exposes them.

## License

Apache-2.0. Portions derived from
[claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp)
(Zed Industries) — see `NOTICE`.
