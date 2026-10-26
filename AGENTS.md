# AGENTS.md

This file provides guidance to coding agents (Claude Code, Codex, etc.) when working with code in this repository.

## What this is

`@bex-co/muse-code-acp` is an unofficial adapter that exposes Meta's Muse Code CLI as an [ACP](https://agentclientprotocol.com) agent over stdio, so editors like Zed can drive it. Muse itself is installed separately and is never bundled. TypeScript, ESM, Node ≥22. Portions are transplanted from Zed's `claude-agent-acp` (Apache-2.0, see NOTICE).

## Commands

```bash
npm run build              # tsc → dist/
npm run check              # lint + prettier --check (CI runs both)
npm run lint:fix && npm run format
npm run test:unit          # deterministic suite (excludes *-live and paid-provider tests)
npm run test:coverage      # unit suite with enforced coverage floors (CI gate)
npm run test:unit:shuffle  # random order; replay with -- --sequence.seed=<seed>
npm run test:pack-smoke    # npm pack + clean install + ACP execution
```

Single test file / single test:

```bash
npx vitest run src/tests/muse-sdk.test.ts
npx vitest run src/tests/muse-sdk.test.ts -t "test name substring"
```

Run `npm run build` first for tests that spawn `dist/index.js` over real NDJSON (`acp-wire-helpers.ts` users such as `*-wire.test.ts`, `smoke.test.ts`, `acp-restart-live.test.ts`).

Real-host tests (`*-live.test.ts`) need an actual `muse` binary on PATH and `MUSE_CODE_EXECUTABLE` pointing at it; they use a local loopback provider (`src/tests/loopback-provider.ts`), not a paid API. Without a host they `skipIf` silently, so force them:

```bash
MUSE_CODE_ACP_REQUIRE_MUSE=1 npm run test:muse-loopback
MUSE_CODE_ACP_REQUIRE_HOST_FEATURES=all ...   # or e.g. goal-controls,session-commands — make capability-gated skips fail
```

CI runs loopback on Muse 1.1.1-R2514.1 (baseline, gated suites may skip) and 1.4.13-R6996.1 (all gated suites required). A new `*-live.test.ts` file must also be added to the explicit list in the `test:muse-loopback` script. Paid-provider tests: `npm run test:integration` (needs credentials).

Coverage thresholds in `vitest.config.ts` are floors measured without a Muse host — raise, never lower.

## Architecture

**Entry points.** `src/index.ts` is the bin: `--cli <args>` delegates straight to the Muse binary (e.g. `login`), otherwise it redirects all console output to stderr (stdout is the ACP channel) and calls `runAcp()`. `src/acp-agent.ts` holds `MuseAcpAgent`, which implements every ACP method and owns `sessions: Map<string, SessionState>`; session load/fork/resume logic lives in `session-lifecycle.ts`, and many ACP extensions (`muse/...` `_meta` keys and ext methods) live in their own modules (`stored-output.ts`, `async-tasks.ts`, `steering-protocol.ts`, `client-provider.ts`, `session-progress.ts`, `goal-state.ts`, …).

**Two backends**, selected by `MUSE_CODE_ACP_BACKEND` (`sdk` default, `exec` legacy rollback; anything else throws at startup). SDK failures must never silently fall back to exec.

- **SDK backend** — official `@muse-code/sdk` (pinned exactly) speaking MSP to `muse serve`.
  - `muse-sdk-host.ts` (`MuseSdkHost`): long-lived per-session host process, retained across turns (steering, task controls, goal state, session-state observation, host compatibility fingerprints).
  - `muse-sdk.ts`: turn execution (`spawnMuseSdkTurn`) and SDK reads; `sdk-prompt-turn.ts` is the ACP-facing turn driver.
  - `sdk-control-host.ts` (`withSdkControlHost`): short-lived `muse serve` for bounded reads/control ops outside a session, with deadlines from `sdk-operation.ts`.
  - `muse-sdk-events.ts` / `muse-view-events.ts`: translate SDK folded items into ACP `session/update`s.
  - `muse-permissions.ts`: maps real MSP approval requests to ACP `session/request_permission`; `pending-watchdog.ts` fails turns that stall on host requests (`MUSE_CODE_ACP_STALL_MS`).
  - `muse-host.ts`: version/feature detection (`probeSdkHost`, `supports*`, `atLeast`) — gate newer-host features here.
- **Exec backend** — spawns `muse exec --json` per turn (`muse-exec.ts`), parses versioned JSONL envelopes (`muse-events.ts`), translates via `translate.ts` (`TurnTranslator` + `tool-calls.ts`), driven by `exec-prompt-turn.ts`. Approvals resolve inside Muse; a headless approval wait stops the run after `MUSE_CODE_ACP_EXEC_APPROVAL_STALL_MS`.

**Shared concerns.** `muse-cli.ts` resolves the binary (`MUSE_CODE_EXECUTABLE` > PATH); `muse-run.ts` runs captured one-shot subcommands. Config/modes/safety: `config-options.ts`, `modes.ts`, `safety-settings.ts`, `session-configuration.ts`; per-session preferences persist via `session-preferences.ts`. `mcp-overlay.ts` builds the per-session env/config overlay (MCP servers, provider gateway). Slash commands: `slash-commands.ts`, `local-commands.ts`, `host-commands.ts`.

**Test fixtures.** Most unit tests run against deterministic fakes instead of Muse: `src/tests/fixtures/fake-msp.cjs` (MSP peer for the SDK backend, behavior via `FAKE_MSP_MODE`) and `fake-muse.cjs` (stands in for `muse exec --json`, via `FAKE_MUSE_MODE`). `src/tests/helpers.ts` builds agents and disposes them after each test.

## Hard constraints (from `.pm/DO_NOT_DO.md` — read it before proposing work)

- Don't drive the Muse TUI (no pty scraping). Use the official SDK / documented MSP; don't replace public SDK APIs with private protocol internals.
- Don't fake interactive permissions: only surface ACP permission round-trips when the host request actually gates the tool call; offer only host-provided choices; cancellation/dismissal/malformed/stale replies must never grant.
- Don't default to `--yolo` / sandbox-off. Those require `MUSE_CODE_ACP_ALLOW_YOLO=1` plus an explicit mode/option.
- Don't depend on undocumented Muse behavior without feature detection; don't invent missing MSP methods or replay an ambiguous turn via the other backend.
- Don't imply Meta affiliation; keep NOTICE attribution.

## Conventions

- Prettier: `printWidth` 100. ESLint enforces `curly: all`, `no-floating-promises`, `no-misused-promises`, `default-case`; unused args must be prefixed `_`.
- Imports use `.js` extensions (NodeNext ESM).
- Conventional commit subjects (`feat:`, `fix(scope):`, `chore(pm):`, …); PR titles are validated against the same types.
- User-facing changes go under `## Unreleased` in `CHANGELOG.md`; feature design notes live in `docs/*.md` (e.g. `docs/sdk-migration.md` is the SDK backend reference).
- Work is tracked on the `.pm/` board (workstreams `w*/`, milestones, tasks). Repository skills in `.agents/skills/` (symlinked into `.claude/skills/`): `pm`, `pm-brainstorm`, `loopx`, `ship` (push directly to `main`), `release` (npm publish only via GitHub Actions — never run `npm publish` locally).
