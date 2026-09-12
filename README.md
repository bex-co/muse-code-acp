# muse-code-acp

An [ACP](https://agentclientprotocol.com)-compatible coding agent powered by
[Muse Code](https://dev.meta.ai/docs/muse-code/), Meta's terminal coding agent.
Use Muse Code from any ACP client: Zed, VS Code (via
[`vscode-acp`](https://github.com/formulahendry/vscode-acp)), and others.

> **Unofficial adapter.** Muse Code and Muse Spark are products of Meta
> Platforms, Inc. This project is a community adapter and is not affiliated
> with, endorsed by, or supported by Meta.

## Quickstart

1. Install [Muse Code](https://dev.meta.ai/docs/muse-code/) (`muse`, ≥ **1.1.1**
   with `muse serve`) and make sure it is on `PATH` (or set `MUSE_CODE_EXECUTABLE`).
   ```sh
   curl -fsSL https://dev.meta.ai/install.sh | sh
   ```
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

The **default backend** uses the official
[`@muse-code/sdk`](https://github.com/meta-models/muse-code-sdk) (pinned to 0.1.1)
and `muse serve` — one MSP host per prompt turn. The adapter starts or resumes
the session, translates message/tool items into ACP updates, routes approvals
through ACP permissions, and cancels with `turn/cancel`.

| Muse / MSP                    | ACP                                                         |
| ----------------------------- | ----------------------------------------------------------- |
| agent message (+ deltas)      | `agent_message_chunk`                                       |
| tool call items               | `tool_call` / `tool_call_update`                            |
| `approval/requested`          | `session/request_permission` (SDK)                          |
| turn terminal + cancel        | stop reason / error                                         |
| session store + `muse export` | `session/list` + `session/load` history replay (CLI helper) |
| `muse skills list`            | ACP slash commands (prompt passthrough)                     |

Session listing/history export, auth, and skills still use documented CLI helpers
where the public SDK has no equivalent. See [`docs/sdk-migration.md`](docs/sdk-migration.md).

### Legacy exec backend (rollback)

```sh
MUSE_CODE_ACP_BACKEND=exec muse-code-acp
```

Unknown backend values fail at startup. SDK turn failures never silently fall
back to `exec`. The echo provider is supported on `exec` only.

Requires Muse ≥ 0.2.1 for `exec`; the default SDK path requires ≥ 1.1.1 with
`muse serve`.

## Capabilities

| Surface                                             | Status                                             |
| --------------------------------------------------- | -------------------------------------------------- |
| Prompt turns with streamed text                     | ✅                                                 |
| Tool calls with results, diffs, locations           | ✅ (title upgraded at result time)                 |
| Cancellation (`session/cancel`)                     | ✅                                                 |
| Multi-turn sessions, `session/list`, `session/load` | ✅                                                 |
| Session modes: default / read-only                  | ✅ (SDK default)                                   |
| Session modes: bypass-approvals / yolo              | ✅ (`exec` only; gated)                            |
| Model + reasoning-effort config options             | ✅                                                 |
| Skills as slash commands                            | ✅                                                 |
| Auth: browser login, `META_API_KEY`, logout         | ✅                                                 |
| Interactive per-tool-call permission prompts        | ✅ (SDK backend)                                   |
| Thinking/reasoning stream                           | ❌ (muse encrypts reasoning)                       |
| Client-provided stdio MCP servers                   | ✅ (see `docs/mcp-passthrough.md`)                 |
| Additional workspace directories                    | ❌ (muse supports one workspace root)              |
| Delegated workers                                   | ❌ (advertised in namespaced ACP metadata)         |
| Token usage                                         | ❌ (not forwarded by the adapter)                  |
| Editor-side file edits (fs proxying)                | ❌ (muse edits in its own sandbox; diffs reported) |

### Exec backend notes

- Approvals resolve inside Muse (policy + judge) unless you use the SDK backend.
- Modes map onto `muse exec` spawn-time safety flags (`readOnly`, `bypassApprovals`, `yolo`).

## Environment

| Variable                   | Meaning                                               |
| -------------------------- | ----------------------------------------------------- |
| `MUSE_CODE_EXECUTABLE`     | Path to the `muse` binary                             |
| `MUSE_CODE_ACP_BACKEND`    | `sdk` (default) or `exec`                             |
| `META_API_KEY`             | Provider credential (takes priority over stored auth) |
| `MUSE_CODE_ACP_ALLOW_YOLO` | Set to `1` to advertise yolo mode (`exec` only)       |
| `MUSE_AGENT_LOGS`          | Directory for spawn/stderr logs                       |

## Tests

```sh
npm run test:unit              # deterministic contracts (no Muse host required)
npm run test:muse-loopback     # real muse serve + loopback provider (required in CI)
npm run test:pack-smoke        # clean tarball install → ACP prompt + streamed response
npm run test:run               # full local vitest run after build
```

Optional paid-provider acceptance remains `RUN_INTEGRATION_TESTS=true npm run test:integration`.

## Development

```sh
npm run build         # tsc
npm run check         # eslint + prettier
```

The work board lives in `.pm/` (workstream w1).

## Roadmap

- Host pooling and further CLI-helper reductions after the SDK default cutover.
- Map MSP worker and token-usage events into ACP.

## License

Apache-2.0. Portions derived from
[claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp)
(Zed Industries) — see `NOTICE`.

Prompt images (PNG, JPEG, GIF, WebP) are supported: the SDK receives inline image
parts; legacy exec uses private per-turn files removed during cleanup. Exec
requires accompanying text or a resource link. Audio and embedded resources
remain unsupported.

`session/close` cancels active work, waits for per-turn cleanup, and releases
adapter session state. Native Muse history is retained for later loading.

`session/resume` rebinds an existing or retained session without replaying its
transcript. It refreshes MCP servers, preserves live settings, and restores saved
SDK model/effort after close or restart. The original workspace is required.
