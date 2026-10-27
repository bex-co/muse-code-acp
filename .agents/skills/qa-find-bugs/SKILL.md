---
name: qa-find-bugs
description: QA the current muse-code-acp tree the way Bex desktop uses it — pack a release candidate, run a Bex-faithful headless ACP pass (loopback and real provider) and a short GUI pass in the installed Bex.app, then report bugs with evidence and file new ones on the .pm board. Use for an explicit qa-find-bugs invocation or a request to QA/dogfood the adapter in Bex; not for unit tests or fixing bugs.
---

# QA the adapter in Bex and find bugs

Usage: `$qa-find-bugs [--no-gui] [--loopback-only] [--only L1,R3-R4] [--budget N] [--muse PATH] [--caps negotiated]` (also `/qa-find-bugs`). Parse options from `$ARGUMENTS`.

This finds bugs; it does not fix them. Every bug it reports needs evidence a reader can check: a wire-log excerpt, a stderr line or a screenshot. Read `.pm/DO_NOT_DO.md` and `.pm/UPSTREAM_DEPENDENCIES.md` first, so known upstream behavior is tagged rather than refiled.

Scripts live in `scripts/` next to this file; scenarios and expectations are in [scenarios.md](scenarios.md). All artifacts go to `QA_DIR` (default `/tmp/muse-acp-qa-<YYYYMMDD-HHMMSS>`); export it for `ui.sh`.

## Ground rules

- **Real-provider turns are pre-approved** within `--budget` (default 80, env `QA_TURN_BUDGET`), on `QA_REAL_MODEL` (default `muse-spark-1.3`) at low effort. `headless.mjs` refuses to run a real scenario on any other model and stops real scenarios when the budget is spent. Use the user's own Muse login; never add credentials.
- **The GUI pass takes the screen.** Tell the user before starting it. Never send input unless Bex is frontmost: `ui.sh` aborts otherwise, so do not work around that guard. Type only through `ui.sh paste`, because a Chinese/Japanese IME garbles synthesized keystrokes. Clicks need `cliclick`, since Bex (GPUI) ignores accessibility clicks.
- **Leave no trace:**
  - the QA agent entry is removed from Bex settings;
  - test files in `$HOME` are deleted;
  - the clipboard is restored;
  - Bex is quit only if it was not running before.

  Cleanup runs even when a step fails.

- **Bex desktop:** the installed `/Applications/Bex.app` is the client under test. `../bex3/bex-desktop` is a reference (its ACP client lives in `crates/agent_servers` and `crates/acp_thread`) for deciding whether a symptom is the adapter's or Bex's. Do not build it.
- The Muse launcher (`~/.local/bin/muse`) updates itself. Record `muse --version` at the start, and pass `--muse` to pin a downloaded build when comparing runs.

## 1. Preflight

1. `git status` and `git rev-parse --short HEAD`. A dirty tree is fine (it is what gets packed), but record it.
2. `muse --version`; confirm `/Applications/Bex.app` and, for the GUI pass, `command -v cliclick`.
3. Record `ui.sh running` (was Bex already open?) and save the result for cleanup.
4. Create `QA_DIR` and `export QA_DIR`.

## 2. Pack the release candidate

`scripts/pack-rc.sh "$QA_DIR"` builds, packs with `npm pack`, installs the tarball cleanly, and writes `rc/run.sh` (the wire-logging launcher) and `rc/rc.json`. This tests what npm users would install, not `dist/`.

## 3. Headless pass

```bash
node scripts/headless.mjs --qa-dir "$QA_DIR" [--loopback-only] [--only …] [--budget …] [--muse …]
node scripts/analyze.mjs --qa-dir "$QA_DIR"
```

`headless.mjs` speaks to the packed agent with Bex's exact `initialize` and Bex's habit of restoring an option right after `session/new`. It runs L1–L9 on the local loopback provider, then R1–R7 on the real provider, writing `results.json` and one wire log per agent process under `logs/`. `analyze.mjs` checks every log against the protocol and UX invariants and writes `findings.json`. Scenario status is `pass`, `fail`, `error`, `skipped` (budget) or `inconclusive` (the host settled what the scenario meant to exercise, e.g. no permission was asked). A targeted rerun (`--only`) writes `results.rerun-N.json` and its own `logs/<id>.N/`, so the full run's evidence is kept; `analyze.mjs` reads all of them. Run `--caps negotiated` as a second headless pass when the change touches negotiated `muse/*` extensions or `session.compaction`.

## 4. GUI pass (skip with `--no-gui`)

1. `node scripts/bex-agent.mjs install "$QA_DIR/rc/run.sh" "$QA_DIR/logs/gui" "$(command -v muse)"`, which adds a "Muse Code (QA)" agent and backs up settings first.
2. Open a fresh scratch project: `mkdir -p "$QA_DIR/work/gui" && git -C "$QA_DIR/work/gui" init -q`, then `open -a /Applications/Bex.app "$QA_DIR/work/gui"`, then `ui.sh pin`. If the "Unrecognized Project" dialog appears, `ui.sh code 36` trusts it (it is the scratch folder). Pick the agent with `ui.sh palette "agent: toggle new thread menu"`, then arrow keys (`ui.sh code 125`) and Return. The menu lists external agents alphabetically.
3. Run G1–G5 from [scenarios.md](scenarios.md). After every step, take `ui.sh shot <name>` and **read the screenshot**. Judge it the way a user would:
   - Is the text readable?
   - Does each card say what happened?
   - Are there raw internal names, merged messages, spinners that never stop, or error banners?

   For permission prompts, click the option by its on-screen position. Watch `logs/gui/out.ndjson` for `stopReason` instead of sleeping blindly.

4. Run `analyze.mjs` again so `logs/gui` is included.

## 5. Triage

For each finding in `findings.json` without a `known` tag, and each visual problem from the GUI pass:

1. **Reproduce it once** (e.g. `headless.mjs --only <id>`). Mark one-off failures `flaky`, with the evidence of both runs; do not file them as bugs.
2. **Classify it:**
   - _adapter_: point to the likely file (`src/muse-sdk-events.ts` for rendering, `src/session-export.ts` for replay, `src/muse-sdk-host.ts` / `src/sdk-prompt-turn.ts` for host lifecycle, `src/acp-agent.ts` for protocol);
   - _upstream Muse_: confirm with a direct SDK/MSP probe when cheap;
   - _Bex client_: check the reference sources;
   - _known_;
   - _harness_ (a bug in these scripts: fix the script, not the adapter).
3. **Assign severity:**
   - high: wrong result, data loss, a session left unusable, a permission granted without consent;
   - medium: a broken flow with a workaround, or misleading UI;
   - low: cosmetic.

## 6. Report

Write `$QA_DIR/report.md` with:

- **Header:** rc commit and version, Muse version, caps, turns used / budget, and duration.
- **Summary table:** id, severity, title, classification, status (new / known / flaky).
- **Per finding:** scenario, steps to reproduce, expected vs actual, evidence paths or excerpts (≤ 20 lines each), and the suspected source.
- **Coverage:** scenarios passed, failed or skipped, with reasons.

Show the user the summary table and the report path.

## 7. File

- **New adapter bugs:** one w3 inbox note each, following the `pm` skill (`Why:` line, evidence, next unused number, index line in `.pm/w3/README.md`). Link the report evidence by restating it; `/tmp` paths do not survive.
- **New upstream bugs:**
  - add or update the row in `.pm/UPSTREAM_DEPENDENCIES.md`;
  - draft an issue (title, versions, a minimal MSP reproduction) in the report;
  - only post upstream when the user asks.
- **Known items whose behavior changed** (fixed or worse): update their row or board note with the date and version.
- Do not change source code or commit. Suggest `/ship` for the board edits.

## 8. Cleanup (always)

- `node scripts/bex-agent.mjs remove`, then confirm `status` reports `installed: false`.
- `ui.sh quit` if Bex was not running at preflight.
- Remove any leftover `~/muse-acp-qa-*.txt`.
- Keep `QA_DIR` for evidence and mention its path.
