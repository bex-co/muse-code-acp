# SDK migration — compatibility and ACP support matrix

This adapter defaults to the Muse Code SDK path (`muse serve` via
`@muse-code/sdk`). Set `MUSE_CODE_ACP_BACKEND=exec` for the legacy
`muse exec --json` path. Unknown selectors fail at startup. SDK turn failures
never silently fall back to exec.

## Pins

| Component                  | Version              | Notes                                             |
| -------------------------- | -------------------- | ------------------------------------------------- |
| `@muse-code/sdk`           | **0.1.1** (exact)    | Public MuseClient / Session / Connection APIs     |
| `@agentclientprotocol/sdk` | **1.3.0** (exact)    | ACP protocol major `PROTOCOL_VERSION` (= 1)       |
| Muse host (`muse serve`)   | **≥ 1.1.1** required | Default backend; `muse serve --help` must succeed |
| Muse host (`muse exec`)    | **≥ 0.2.1**          | Legacy `MUSE_CODE_ACP_BACKEND=exec` only          |

Verified locally with Muse Code **1.1.1**. Older hosts without `serve`, or hosts
that exit with the experimental SDK tier disabled, fail **before** a model turn
with an actionable upgrade hint (or set `MUSE_CODE_ACP_BACKEND=exec`).

## Rollback

```sh
MUSE_CODE_ACP_BACKEND=exec muse-code-acp
```

## ACP surface (advertised)

| Capability                            | Advertised?                                    | Contract owner                                               |
| ------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| Protocol major 1                      | yes (always returned as our supported version) | `src/acp-agent.ts` initialize + `src/tests/acp-wire.test.ts` |
| Prompt: text + resource_link          | baseline (empty `promptCapabilities`)          | `src/prompt-content.ts`                                      |
| Prompt: audio / embedded resource     | **no**                                         | rejected with invalid params                                 |
| MCP stdio                             | yes (baseline; http/sse not advertised)        | `docs/mcp-passthrough.md`                                    |
| `session/load`, `session/list`        | yes                                            | session store + export helpers                               |
| Auth logout                           | yes                                            | `src/auth.ts`                                                |
| Terminal auth method                  | only if `clientCapabilities.auth.terminal`     | `src/auth.ts`                                                |
| Interactive permissions (SDK backend) | yes                                            | `src/muse-permissions.ts` + live approval suite              |
| Form elicitation (SDK user input)     | yes when client advertises `elicitation.form`  | `src/muse-user-input.ts`                                     |
| fs / terminal RPC                     | **no**                                         | omitted client caps never invoked                            |
| Session fork/delete/close             | **no**                                         | unadvertised                                                 |

## Public SDK API map

| ACP / adapter behavior | Public SDK / MSP API                                                     | Fallback                                                                    |
| ---------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Spawn MSP host         | `spawnMspConnection` + `MuseClient`                                      | —                                                                           |
| Handshake / durability | `initialize` + `readSessionDurability`                                   | fingerprint mismatch is advisory                                            |
| Start / resume session | `MuseClient.startSession` / `resumeSession`                              | missing session (`-32020`) → start; in-use/busy/wrong workspace fail closed |
| Approval mode          | `startSession({ approvalMode: "onRequest" })` + resume `setApprovalMode` | host default is `promptUnmatched`                                           |
| Set model              | `Connection.command("session/setModel")`                                 | facade has no setModel                                                      |
| Submit turn            | `Session.sendUserTurn`                                                   | —                                                                           |
| Stream items / deltas  | `Turn.items()` / `Turn.deltas()` (+ fold catch-up for pre-ack deltas)    | —                                                                           |
| Cancel                 | `Connection.command("turn/cancel")`                                      | close host if cancel fails                                                  |
| Approvals              | `Session.onApproval` → ACP `session/request_permission`                  | cancel/deny map to a host-offered deny choice; no fabricated grants         |
| User input             | fold `pendingUserInputs` + `userInput/answer`\|`cancel`                  | clients without form elicitation cancel and fail the turn                   |
| View gaps              | Session gap-fill (`view/page`) + `onGapError`                            | stalled/failed fill fails the prompt; no extra `turn/start`                 |

## Retained CLI / store helpers

These stay because public SDK session APIs do not yet provide the required
legacy surface. The **default turn path** uses only the SDK backend.

| Helper                        | Why retained                                                 |
| ----------------------------- | ------------------------------------------------------------ |
| Session store listing         | ACP `session/list` workspace filtering + titles/timestamps   |
| `muse export` history replay  | Complete chronological load when SDK history APIs are absent |
| `muse login` / logout helpers | Auth surfaces without an SDK credential API                  |
| `muse skills list`            | Slash-command advertisement                                  |
| MCP settings overlay          | Per-turn stdio MCP merge without mutating user settings      |

## Resource-link encoding

MSP `TurnInputPart` only declares `text` \| `image`. ACP `resource_link` blocks
are encoded as ordered text parts:

```
Resource: <name>
URI: <uri>
Title: <title>          # optional
Description: <description>  # optional
MIME: <mimeType>        # optional
```

No URI is fetched during conversion. The same text is used for the legacy
`muse exec` prompt string.

## Modes

SDK reasoning-effort choices are `low`, `medium`, and `high`, matching MSP.
Legacy settings aliases are normalized before advertisement (`none`/`minimal`
to `low`, `xhigh`/`ultra` to `high`); unsupported SDK selections are rejected.
An explicit ACP effort selection is saved in adapter-owned
`$XDG_DATA_HOME/muse-code-acp/sessions/` (or `~/.local/share/muse-code-acp/sessions/`).
Loading reads the authoritative model through MSP `session/read` and restores
that effort selection; sessions without one use the current settings default.
Mode resets to `default` on load; Muse session logs and global settings are not
modified by the adapter preference store.

Muse 1.1.1 initializes its execution provider from settings even when MSP
selects a different session model. SDK turns therefore put the selected model
and effort into the same private settings overlay used for MCP, in addition to
the MSP selection. The overlay is removed at turn end; user settings stay intact.

Form elicitation supports single selections, bounded multiple selections, and
free text up to 500 characters. Invalid responses fail the turn and cancel the
input request. Cancelling a turn never waits for a still-open client dialog.

| Mode              | SDK | Exec | Notes                                           |
| ----------------- | --- | ---- | ----------------------------------------------- |
| `default`         | yes | yes  | SDK: ACP permission gating (`onRequest`)        |
| `readOnly`        | yes | yes  | `--disable-write --disable-shell` on serve/exec |
| `bypassApprovals` | no  | yes  | dangerous; not advertised on SDK                |
| `yolo`            | no  | yes  | requires `MUSE_CODE_ACP_ALLOW_YOLO=1`           |

## Test owners / CI profiles

| Profile / suite                     | Covers                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------ |
| `npm run test:unit`                 | Deterministic fake-MSP/wire contracts; no Muse binary                    |
| `npm run test:muse-loopback`        | Real Muse + loopback: live, approval, ACP process restart                |
| `npm run test:pack-smoke`           | `npm pack` → clean install → stdio initialize/new/prompt/stream/end_turn |
| `RUN_INTEGRATION_TESTS=true`        | Optional external-provider acceptance (separate from CI)                 |
| `src/tests/session-history.test.ts` | Export replay completeness / schema reject                               |
| `src/tests/permissions.test.ts`     | MSP→ACP permission mapping + fake-host gate                              |
| `src/tests/muse-sdk-gap.test.ts`    | Recoverable and failed view/page fills                                   |
| `src/tests/acp-wire.test.ts`        | Spawned `dist/index.js` NDJSON wire                                      |

CI installs the public Linux Muse **1.1.1-R2514.1** artifact and verifies its
pinned SHA-256. Real-host tests run on Ubuntu 22.04: Muse 1.1.1's bundled
Bubblewrap fails to create its loopback namespace under Ubuntu 24.04's default
AppArmor policy (`Failed RTM_NEWADDR: Operation not permitted`). This is a host
sandbox limitation; ACP reports the failed tool result. CI keeps the sandbox
enabled and requires proof that an approved command actually writes its file.
The restart test verifies that provider input includes the prior
conversation and that the saved model/effort survive the ACP process restart.
Publishing resolves the release ref to an immutable commit, runs this same CI
workflow on that commit, and only publishes after all checks succeed. Manual
publishing follows the same checks.

Prompt images are advertised and sent as ordered MSP `image` parts with
`mediaType` and `base64Data`. PNG, JPEG, GIF, and WebP are accepted; malformed
base64 is rejected before a turn starts. Legacy exec stages private temporary
files and requires text or a resource link alongside images.
