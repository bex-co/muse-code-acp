# ACP session MCP passthrough

ACP clients pass session MCP servers through `session/new`, `session/load` or
`session/resume`. The adapter merges them with Muse settings in a private
configuration overlay. User settings are never modified.

## Supported transports

The SDK backend supports stdio and Streamable HTTP on Muse 1.1.1-R2514.1 with
`@muse-code/sdk` 0.1.1. It advertises `mcpCapabilities.http: true`. The legacy
exec backend retains stdio support. SSE remains unsupported; an unsupported
transport or malformed session configuration is rejected before execution.

An ACP HTTP server has this shape:

```json
{
  "type": "http",
  "name": "remote-tools",
  "url": "https://example.com/mcp",
  "headers": [{ "name": "Authorization", "value": "Bearer YOUR_TOKEN" }]
}
```

The SDK overlay maps it to Muse's canonical settings:

```json
{
  "mcpServers": {
    "remote-tools": {
      "type": "http",
      "mode": "required",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

URLs must use HTTP or HTTPS and cannot embed usernames/passwords. Header names
and values must be valid HTTP fields. The adapter does not log values during
validation or include endpoints, arguments, environment variables or headers in
its status report. OAuth login remains Muse's own CLI workflow; the adapter does
not initiate browser authentication or refresh ACP-provided tokens.

Stdio entries use `type: "stdio"`, `command`, `args` and an `env` object in the
SDK overlay. Existing legacy `mcp_servers` entries are normalized, then merged
with canonical `mcpServers`; canonical entries win duplicate names and session
entries win over both. Legacy exec retains its older `mcp_servers`/`transport`
shape. Each session receives its own settings copy and credentials.

## Diagnostics

On the SDK backend, `/mcp` or `/mcp status` reports configured names and transports
without starting a model turn or probing remote endpoints. The built-in name
`mcp` takes precedence over a Muse skill with the same name; other skills remain
available. Unsupported `/mcp` arguments are rejected locally.

Configuration is distinct from connectivity. Muse's public SDK has no MCP status
method, so current connection state is reported as **unknown**, even after a
successful tool call. When a prompt fails with a recognized host MCP startup
error, the report includes the last observed category: authentication rejected,
invalid MCP response, unreachable server/process, or other MCP startup failure.
This historical observation is cleared on the next execution attempt or session
resume. Unreadable/malformed settings produce a separate configuration error.
Raw host errors, endpoints and credentials are never copied into this report.

ACP-provided servers explicitly use `mode: "required"` in the SDK overlay, so a
server that fails startup fails the prompt; no automatic prompt replay occurs.
This is verified on both 1.1.1-R2514.1 and 1.2.1-R2847.1. The latter silently
continues after failed startup when the mode is omitted. Servers inherited from
user settings retain their configured mode, including `optional`. Correct its settings and start a new prompt when ready. No success is
inferred from the existence of settings or an HTTP URL.

## Overlay lifecycle

Each execution host owns a mode-0700 temporary configuration directory with a
mode-0600 settings file. Other XDG entries, including Muse authentication, are
symlinked. The SDK retains the overlay while its compatible host is reused,
including idle time; it closes after 60 idle seconds or 32 successful turns.
Configuration changes replace the host before the next turn. Close, disposal,
cancellation and host failure release the overlay. Legacy exec removes its overlay
when the turn ends. See [host lifecycle](sdk-migration.md#session-owned-hosts-and-steering).

## Verification and limits

Real Muse loopback tests verify HTTP initialize/discovery, authorization headers,
a tool call returning content to the provider, and rejected authentication,
malformed responses and unreachable endpoints. Separate deterministic tests cover
merge precedence, credential isolation, invalid URLs/headers and local diagnostics.
Only dummy credentials and local fixtures are used; third-party OAuth services
are not covered by this evidence.

Extra workspace roots come only from ACP `additionalDirectories` (Muse 1.4.13+,
see `docs/sdk-migration.md`). Remote MCP support does not broaden Muse's filesystem
sandbox or permission scope.
