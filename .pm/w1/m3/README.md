# w1 · m3 — Sessions, auth, skills, MCP, packaging + release

**Worker:** worker1 **Goal:** the adapter is a complete, installable product: past sessions list and load with full history, login works from the editor, Muse skills appear as slash commands, client MCP servers reach Muse where possible, and the package ships on npm with docs an editor user can follow. **Status:** todo

## Tasks (in order)

| id   | title                                                    | est | depends_on             |
| ---- | -------------------------------------------------------- | --- | ---------------------- |
| t001 | session/list from the Muse session store                 | 45m | —                      |
| t002 | session/load: history replay via muse export             | 60m | t001                   |
| t003 | Auth: login passthrough, META_API_KEY, logout            | 45m | —                      |
| t004 | Skills surfaced as ACP slash commands                    | 45m | —                      |
| t005 | MCP passthrough via settings overlay (or documented gap) | 60m | —                      |
| t006 | README, capability matrix, Zed config, npm release       | 45m | t002, t003, t004, t005 |
| t007 | Simplify pass over milestone changes                     | 30m | t006                   |
| t008 | Test coverage for shipped behavior                       | 45m | t007                   |
| t009 | Closeout                                                 | 15m | t008                   |

## Definition of done

From a real ACP client configured per the README: the sessions list shows this workspace's past Muse sessions with titles/timestamps; loading one replays its full history (messages + tool calls) as ACP updates and continues the conversation; an unauthenticated user can complete login through the adapter (browser flow via `--cli` passthrough) or `META_API_KEY`; `muse skills list` output appears as invocable slash commands; ACP-provided MCP servers either reach Muse (settings overlay) or the README documents precisely why not and the adapter rejects them cleanly; `npm install -g muse-code-acp` yields a working binary; the release pipeline (release-please) cuts versions from conventional commits.

## Source + Goal linkage

- **Source:** porting research (2026-08-25): `muse export --session` verified to emit full transcripts (messages, tool calls, approvals, lineage); session store at `~/.local/share/muse/sessions/`; auth surface (`muse login`, `muse auth set --api-key-stdin`, `META_API_KEY`); skills CLI verified; MCP is settings-file-only in 0.2.1 (impedance mismatch flagged).
- **Goal linkage:** turns the working engine (m1+m2) into the shippable first ACP adapter for Muse Code — list/load/auth/commands are what make it feel native in an editor rather than a demo.
- **Expected outcome:** installable npm package + README that gets a Zed/VS Code-ACP user from zero to a resumed Muse session; a public issue list tracking the Meta-gated gaps (interactive approvals, hooks).
- **Why now:** all tasks consume m2's translator (history replay reuses it verbatim); packaging last avoids shipping before the honest-degradation story is complete.
- **Render parity omitted:** bex-specific standing task; no REST/GraphQL/MCP/dashboard surface in this project (see m1 README).
