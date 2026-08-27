# ACP session MCP passthrough

ACP clients can pass per-session MCP servers (`session/new` or `session/load`
via `mcpServers`). Muse Code 0.2.1 reads MCP servers only from the global
`$XDG_CONFIG_HOME/muse/settings.json` `mcp_servers` block and has no per-run
MCP flag, so the adapter bridges the two with a private configuration overlay.

## Supported transport

The adapter supports ACP stdio MCP servers. This is the transport Bex Security
uses for its security workbench and the transport all ACP agents are required
to support. HTTP, SSE, and ACP transports are not advertised.

Each ACP stdio server is converted to Muse's native shape:

```json
{
  "mcp_servers": {
    "security-tools": {
      "transport": "stdio",
      "command": "/absolute/path/to/server",
      "args": ["--stdio"],
      "env": { "SCAN_ROOT": "/workspace" }
    }
  }
}
```

## Overlay lifecycle

For each prompt that has session MCP servers, the adapter:

1. creates a mode-0700 temporary XDG configuration directory;
2. symlinks the user's existing XDG entries, including Muse authentication;
3. writes a mode-0600 `muse/settings.json` containing the user's settings plus
   the session MCP servers;
4. starts `muse exec` with the temporary directory as `XDG_CONFIG_HOME`; and
5. removes the temporary directory when the turn completes, fails, or is
   cancelled.

The user's `settings.json` is never modified. Existing user-configured MCP
servers are preserved, while a session server replaces a user server with the
same name for that turn only. Each concurrent ACP session gets its own overlay.

The temporary settings copy can contain credentials already present in the
user's settings or in an MCP server environment. It is readable only by the
current user and exists only for the duration of the turn.

## Additional directories

The adapter does not advertise ACP `additionalDirectories`. Muse Code 0.2.1's
headless CLI accepts one `--workspace` root and has no equivalent way to add
independent filesystem roots without changing the session working directory.
Clients should place the workbench MCP server and any scan target paths in the
stdio server's command, arguments, or environment instead.
