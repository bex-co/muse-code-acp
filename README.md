# muse-code-acp

Use [Muse Code](https://dev.meta.ai/docs/muse-code/) through an
[Agent Client Protocol (ACP)](https://agentclientprotocol.com) client, such as
Zed or VS Code with an ACP extension. Available features depend on the client.

> **Unofficial adapter.** Muse Code and Muse Spark are products of Meta
> Platforms, Inc. This community project is not affiliated with, endorsed by,
> or supported by Meta.

## Requirements and compatibility

- **Node.js 22+** for the npm installation.
- **Muse Code 1.1.1-R2514.1**, installed separately, with `muse serve`.
  This is the verified host for adapter **0.5.x**; the latest Muse installer
  may install a different version. Select the verified binary with
  `MUSE_CODE_EXECUTABLE`.
- Muse authentication through browser login or `META_API_KEY`.

**The supported baseline remains Muse 1.1.1-R2514.1.** Adapter **0.5.0** also
verifies SDK-created session load/resume, multi-stage allow/deny,
and HTTP MCP tool calls and startup failures on **1.2.1-R2847.1**. ACP-provided
MCP servers explicitly use required startup mode; authentication, malformed
responses and unreachable endpoints fail the prompt.

One host limitation remains on 1.2.1, 1.3.0, 1.4.3 and 1.4.4: legacy `muse exec` sessions saved with
`:auto-review` cannot be resumed in `muse serve`, whose automated reviewer is
unavailable. From 1.3.0-R3401.1 the host also refuses to read them, so ACP
`session/load` fails with the same message instead of replaying history. From 1.4.3
`muse exec` saves new sessions with `:auto-review` by default, so new sessions from
the opt-in exec backend are affected too. This affects the legacy-continuation portion of three live tests;
SDK-created session continuation passes. The adapter reports an actionable error
and does not replay the prompt or change the saved permission profile. Start a
new ACP session or continue the old one in Muse with reviewer support.

The launcher updates and removes superseded binaries, so pointing
`MUSE_CODE_EXECUTABLE` at an old launcher cache is not a durable pin. CI's public
1.1.1 artifacts remain downloadable; the exact macOS ARM64 and Linux download
URLs and SHA-256 checks are in [CI](.github/workflows/ci.yml). Keep the verified
binary at a separate path. These fixes are included in **0.5.0**.

The npm adapter and its pinned `@muse-code/sdk@1.4.4` dependency do not include
the Muse executable. Native execution, model access, persistence and sandboxing
remain owned by Muse.

## Quickstart

Install Node.js and the verified Muse host above, then replace the example path:

```sh
export MUSE_CODE_EXECUTABLE="/absolute/path/to/muse-1.1.1"
"$MUSE_CODE_EXECUTABLE" --version
"$MUSE_CODE_EXECUTABLE" serve --help
"$MUSE_CODE_EXECUTABLE" login
npm install -g @bex-co/muse-code-acp
muse-code-acp --version
```

For headless use, provide `META_API_KEY` to the adapter process instead of browser
login. The adapter speaks ACP over stdio; launch it through your editor rather
than expecting an interactive chat UI in the terminal.

### Zed

Add a [custom external agent](https://zed.dev/docs/ai/external-agents#custom-agents)
to Zed settings, replacing the Muse path:

```json
{
  "agent_servers": {
    "Muse Code": {
      "type": "custom",
      "command": "muse-code-acp",
      "args": [],
      "env": {
        "MUSE_CODE_EXECUTABLE": "/absolute/path/to/muse-1.1.1"
      }
    }
  }
}
```

Select Muse Code in the Agent Panel. If Zed cannot find `muse-code-acp`, use its
absolute executable path as `command`. Node must also be available to the editor.
Set the host path in the editor configuration even if you exported it in a shell;
GUI applications may not inherit that shell's environment.

Other ACP clients use the same command and environment. Browser login inside a
client requires terminal-auth support; otherwise authenticate beforehand.

## Capabilities

The default SDK backend supports the following on the verified host:

| Surface            | Behavior                                                                                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt execution   | Streamed text, tool calls/results, cancellation and multi-turn continuity                                                                                                                 |
| Prompt context     | PNG/JPEG/GIF/WebP images, resource links and embedded text; audio and binary resources unsupported                                                                                        |
| Session navigation | Paginated list, full history load, resume without replay, close, and native fork                                                                                                          |
| Permissions        | Interactive host-offered choices through ACP; cancellation and stale replies fail closed                                                                                                  |
| Modes              | Default, read-only and guarded plan mode; implementation requires an explicit mode change                                                                                                 |
| Model settings     | Provider- and profile-qualified catalogs on execution; `/models` refresh before a turn; catalog default when settings name no model; verified idle model switching and host effort limits |
| MCP                | Client-provided stdio and HTTP servers; local configuration/last-failure diagnostics, not live connection status                                                                          |
| File changes       | Bounded observed diffs; optional negotiated reports explicitly mark partial coverage                                                                                                      |
| Workflows          | Skills as slash commands, planning and Git reviews                                                                                                                                        |
| Goals              | Goal status; `/goal <task>` executes once with an explicit persistence limitation                                                                                                         |
| Mid-turn steering  | Available only when explicitly negotiated by the client                                                                                                                                   |

Delegated workers and token usage are explicitly reported as unavailable.
Reasoning summaries, editor-side filesystem proxying, multiple authorized
workspace roots and native session deletion are not implemented. Closing a
session retains its native history. This adapter does not implement every ACP
feature or every feature of Muse's terminal UI.

Slash commands can appear in any top-level text block alongside editor context.
Planning and review preserve attachments. `/plan` alone enables plan mode without
starting work; add a task to start planning. `/review` accepts focus instructions.
`/goal <task>` runs the task once and explicitly reports that no persistent goal
was created. Goal pause/resume/clear/edit controls remain unavailable. Local status
queries do not send attachments to a model; an additional explicit task is handled
after the status response. `/mcp <question>` combines local diagnostics with a
normal task in the current mode, without claiming native MCP control.

## How it works

The official [Muse SDK](https://github.com/meta-models/muse-code-sdk) communicates
with `muse serve` over MSP. The adapter starts or resumes native sessions,
translates message/tool items into ACP updates, routes permission requests to the
client, and cancels using `turn/cancel`.

Mode selection is available through both ACP config options and the legacy
session-mode interface. Changing either keeps both representations synchronized;
`/plan` also updates the mode selector. SDK sessions offer Default, Read-only and
Plan. These are not Codex's “Approve for me” or “Full access” presets: native
automatic approval has not been verified on the supported Muse host. In isolated
tests, `allowAll` was accepted but a shell write still required a decision.
Remaining approval requests are forwarded to the client, not automatically granted.

A shell command can need more than one approval: Muse splits a compound command
into stages and asks about each one that is not already known-safe. The adapter
decides every stage from the host's latest published requirement, so one tool
call produces one permission request per unresolved stage and runs only after the
last decision. Denying any stage cancels the whole command. Only choices the host
offered are ever submitted. Each multi-stage prompt shows the current stage's
host-published arguments and position, such as `Stage 3 of 4: echo two`, even
without a Muse extension. The total includes known-safe stages, not just dialogs.
The full command remains available in the request; the adapter does not parse
shell text to invent a stage. Single-stage prompts keep their existing titles.

If the host stops making progress on a request the adapter owes it an answer to,
the turn fails after `MUSE_CODE_ACP_STALL_MS` with the approval, requirement and
stage evidence, rather than waiting indefinitely. Clients also receive a
`muse/hostCompatibility` entry on `session_info_update` once per host, carrying
the pinned and served schema fingerprints and the detected host version; a
mismatch is advisory and never blocks a session.

Clients can opt into `muse/sessionState` to receive observed host model and
approval-mode changes, plus verified or explicitly unverified persistent-rule
outcomes. These reports do not change ACP configuration or permission policy.
See [observed session state](docs/sdk-migration.md#observed-session-state-w2006).

Each SDK session can retain its host across compatible turns. Idle hosts expire
after 60 seconds; session close also releases them. Close a session before moving
its native conversation to another client.

Session listing uses public `session/list` with bounded pagination. Full history
replay still uses validated `muse export`; read-only store helpers remain for
compatibility lookups and title fallback. Auth and skills use CLI helpers.
Session indexes are eventually consistent, so a new session may not appear
immediately in a refreshed list.

### Approval and sandbox controls

SDK `bypassApprovals` automatically selects only host-offered once approvals at
all stages, with no ACP dialogs or persistent grants. `rejectApprovals` rejects
pending prompts using offered once-denial choices; known-safe tools can still run.
Both work on Muse 1.1.1 and 1.2.1. Select them using either `session/set_mode` or
`session/set_config_option` with `configId: "mode"`.

Separate SDK config options select `nativeApprovalPolicy`, `sandbox`,
`sandboxNetwork`, `workspaceWrite` and `shell`. Defaults remain prompted
`onRequest`, sandbox enabled, proxy-only network, writes and shell enabled.
Non-default native policies require Muse 1.2.1+; automatic once decisions work
on 1.1.1 without those policies. Disabling the sandbox additionally requires
`MUSE_CODE_ACP_ALLOW_YOLO=1`. No SDK option implicitly trusts workspace rules.

Changes require an idle session and replace its retained host. Load/resume
restore validated preferences; fork resets safety settings and modes. See the
[policy matrix and platform limits](docs/sdk-migration.md#approval-and-sandbox-settings).

### Legacy exec backend (rollback)

```sh
MUSE_CODE_ACP_BACKEND=exec muse-code-acp
```

The legacy backend runs `muse exec --json` per turn. It supports the echo provider,
uses store-based session listing and accepts stdio MCP servers only. Approvals
resolve inside Muse rather than through interactive ACP permissions. Default and
read-only and bypass-approvals modes are available; advertising yolo requires `MUSE_CODE_ACP_ALLOW_YOLO=1`.

SDK failures never silently switch to exec. The legacy backend was introduced
for Muse 0.2.1; this release's integration baseline remains 1.1.1-R2514.1.

## Environment

| Variable                    | Meaning                                                                |
| --------------------------- | ---------------------------------------------------------------------- |
| `MUSE_CODE_EXECUTABLE`      | Path to the external Muse binary; takes precedence over PATH discovery |
| `MUSE_CODE_ACP_BACKEND`     | `sdk` (default) or `exec`; unknown values fail at startup              |
| `META_API_KEY`              | Provider credential; takes priority over stored auth                   |
| `MUSE_CODE_ACP_ALLOW_YOLO`  | Opt in to exec yolo or separately selected SDK sandbox-off             |
| `MUSE_AGENT_LOGS`           | Directory for adapter spawn/stderr logs                                |
| `MUSE_CODE_ACP_STALL_MS`    | Stall bound for pending host requests, default `10000` (SDK backend)   |
| `MUSE_CODE_ACP_GATEWAY_URL` | Explicit model gateway endpoint; requires `MUSE_CODE_ACP_GATEWAY_KEY`  |
| `MUSE_CODE_ACP_GATEWAY_KEY` | Bearer credential for that gateway; never persisted                    |

`muse-code-acp --cli login` and `muse-code-acp --cli logout` delegate to the
selected Muse executable. Logout does not unset an exported `META_API_KEY`.

## Detailed documentation

- [Observed usage, plans, summaries and tool output](docs/progress.md)
- [Capability evidence and current ownership](docs/capability-audit.md)
- [SDK support, model discovery, editor context and steering](https://github.com/bex-co/muse-code-acp/blob/main/docs/sdk-migration.md)
- [Session discovery and metadata](https://github.com/bex-co/muse-code-acp/blob/main/docs/session-discovery.md)
- [Native session branching](https://github.com/bex-co/muse-code-acp/blob/main/docs/session-fork.md)
- [File-change evidence and negotiated reports](https://github.com/bex-co/muse-code-acp/blob/main/docs/file-change-report.md)
- [MCP passthrough and diagnostics](https://github.com/bex-co/muse-code-acp/blob/main/docs/mcp-passthrough.md)
- [Planning and Git reviews](https://github.com/bex-co/muse-code-acp/blob/main/docs/workflows.md)
- [Goal observation](https://github.com/bex-co/muse-code-acp/blob/main/docs/goal-extension.md)
- [Standalone Apple Silicon macOS builds](https://github.com/bex-co/muse-code-acp/blob/main/docs/standalone.md): source build and CI verification only; prebuilt binaries are not published. These builds include Node and still require external Muse.

See [failure and authentication observations](docs/failures.md) for structured SDK
errors, credential configuration and session-scoped recovery state.

See [workflow and background tasks](docs/async-tasks.md) for retained progress
and negotiated targeted workflow cancellation.

See [embedded input and local session commands](docs/session-commands.md) for
byte handling, persistent titles, logout and compatible active-turn steering.

## Development and verification

From a repository checkout:

```sh
npm ci
npm run check                 # eslint + prettier
npm run build                 # TypeScript compilation
npm run test:unit             # deterministic contracts; no Muse host required
npm run test:pack-smoke       # clean tarball install and ACP execution
```

For real-host tests, put the verified Muse binary on PATH as `muse` and also set
`MUSE_CODE_EXECUTABLE` to it. Build first, then run:

```sh
MUSE_CODE_ACP_REQUIRE_MUSE=1 npm run test:muse-loopback
```

These tests use a local loopback provider and are required in CI. The required
flag prevents a missing host from silently skipping acceptance. `npm run test:run`
builds and runs the full local Vitest suite; paid-provider tests are opt-in via
`npm run test:integration` and require credentials.

The work board lives in `.pm/`. Repository skills for
[release](https://github.com/bex-co/muse-code-acp/blob/main/.agents/skills/release/SKILL.md),
[PM](https://github.com/bex-co/muse-code-acp/blob/main/.agents/skills/pm/SKILL.md) and
[workstream execution](https://github.com/bex-co/muse-code-acp/blob/main/.agents/skills/loopx/SKILL.md)
live in `.agents/skills/`. npm publishing runs through GitHub Actions after CI
validates the exact release commit.

## License

Apache-2.0. Portions derived from
[claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp)
(Zed Industries) — see [NOTICE](https://github.com/bex-co/muse-code-acp/blob/main/NOTICE).

Stored full tool output on Muse 1.2.1 is available to negotiated clients through [bounded public output reads](docs/stored-output.md), including after session load.

For slow SDK startup, configure the [startup and submission deadlines](docs/failures.md#startup-phases-and-deadlines). Failure responses distinguish operations that submitted no model turn from submissions with an unknown outcome.
