# MCP passthrough decision (muse 0.2.1)

ACP clients can pass per-session MCP servers (`session/new` → `mcpServers`).
Muse Code reads MCP servers **only** from the user settings file
(`~/.config/muse/settings.json`, `mcp_servers` block). This note records the
mechanisms probed for bridging the two, and why the adapter currently ships
**clean non-support** instead.

## Probed on muse 0.2.1 (2026-08-25)

1. **Workspace-scoped settings document** — `muse init --dry-run` scaffolds
   only `AGENTS.md` (project rules). There is no project-level settings file
   muse merges, so there is nowhere workspace-scoped to declare `mcp_servers`.
2. **`--agents <JSON>` ephemeral overlay** — a TUI/root option; `muse exec`
   rejects the combination (`invalid TUI options: unexpected argument
'--json'`). Same story as `--approval-mode`: not part of the headless
   surface in this build.
3. **`XDG_CONFIG_HOME` redirection** — technically possible (generate a config
   dir with `mcp_servers` injected) but rejected: it shadows the user's
   `settings.json` (model/provider defaults) and `auth.json` (credentials
   would need copying into an adapter-owned directory). Both violate this
   project's anti-goals (never write muse's settings; never touch secret
   material).

## Decision

- The adapter advertises **no** `mcpCapabilities` (absent = unsupported).
- Session-provided MCP servers are **ignored with a logged warning** rather
  than failing the session — clients often attach globally-configured servers
  to every agent, and bricking sessions over them is hostile.
- MCP servers the user configures in muse's own `settings.json` work
  unchanged — muse loads them itself; there is nothing for the adapter to do.

## Revisit when

- muse ships a per-run MCP flag, a workspace settings document, or exec-level
  `--agents`; or
- muse's headless surface gains any config overlay that does not shadow user
  settings or credentials.
