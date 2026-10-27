# Scenario catalogue

`headless.mjs` implements the L and R scenarios; the G scenarios are driven by
hand with `ui.sh` in SKILL.md step 4. Keep this table, the script and the
known-issue list in `analyze.mjs` in step: a new scenario gets a row here.

## Loopback (free, deterministic; local fake provider)

| Id  | What it does                                                                             | Expected                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | Bex handshake, `session/new` + immediate option restore, wait, prompt                    | `session/new` < 5 s; unique command names; model picker lists the 2 loopback models before any prompt; `end_turn` with the reply text |
| L2  | Escalated bash approval: Reject, then Allow once                                         | an ACP permission request each time with host-provided option kinds; no file after Reject, file after Allow once                      |
| L3  | Held turn, `session/cancel` after 2 s, then a prompt                                     | `cancelled` within 5 s; next prompt `end_turn`                                                                                        |
| L4  | Idle mode + model change, then a mode change during a held turn                          | every prompt `end_turn`; the mid-turn change is either accepted for the next prompt or refused cleanly                                |
| L5  | Two prompts, agent restart, `session/load`, prompt                                       | both prompts replayed with unique `messageId`s, no card above the first replayed prompt (analyzer); prompt after restart `end_turn`   |
| L6  | Fork, then prompt both branches                                                          | fork succeeds (Linux 1.4.12+: known #120); both branches `end_turn`                                                                   |
| L7  | `/status /tasks /skills /mcp status /models /recap /compact /hooks /plugins`             | each ends `end_turn` with non-empty text and no `undefined` / `[object Object]`; `/compact` reports Muse's refusal on the loopback    |
| L8  | Two sessions prompting concurrently                                                      | both `end_turn`                                                                                                                       |
| L9  | Relative cwd, invalid option value, unknown mode, unknown session, unknown slash command | refused with JSON-RPC errors; unknown slash is plain text; agent still usable                                                         |

## Real provider (`QA_REAL_MODEL`, default `muse-spark-1.3`, effort low; counts against `QA_TURN_BUDGET`)

| Id    | What it does                                                               | Expected                                                                                                                                                                                |
| ----- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1    | File-write tool turn                                                       | `end_turn`, file written; reminder cards named "Muse reminder: …" (analyzer)                                                                                                            |
| R2    | Write to `$HOME` (sandbox-escaping) with Reject, then Allow once           | when Muse asks, Reject writes nothing and Allow once writes; when Muse settles it itself the scenario is `inconclusive` (the GUI pass G3 then covers Reject); test files always deleted |
| R3-R4 | Tool turn, `/compact`, memory question, agent restart + load, prompt, fork | compaction reported; memory kept; prompt after restart `end_turn` (#121 path); fork succeeds (a refusal is a bug; on Linux, known #120)                                                 |
| R5    | Stdio MCP server tool, `/compact`, restart + load, tool again              | tool works before; after resume known #112 if it fails                                                                                                                                  |
| R6    | Long essay, cancel after 8 s                                               | `cancelled` within 8 s                                                                                                                                                                  |
| R7    | New session, 20 s idle, prompt                                             | adapter wait before submission (`preparing` + `submitting`) < 2 s, i.e. the prewarmed host was used; first output is recorded as a metric (model time is Muse's)                        |

## GUI pass in Bex.app (screenshots to `$QA_DIR/gui/`)

| Id  | What to do                                                      | Look for in the screenshot and `logs/gui`                                                              |
| --- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| G1  | New "Muse Code (QA)" thread, open the model picker after ~15 s  | the catalog is listed without `/models`                                                                |
| G2  | A file-write prompt                                             | tool card with path, file link in the reply, only "Muse reminder: …" cards                             |
| G3  | A `$HOME` write: click Reject, then repeat and click Allow once | the prompt shows Muse's options only; results match the click                                          |
| G4  | Long essay, click the stop button                               | stops at once; send button returns                                                                     |
| G5  | Quit Bex, relaunch, reopen the thread, prompt                   | replay keeps separate messages ("No reply was recorded" after the cancelled one); the prompt completes |

## Known issues (tagged, not refiled)

From `.pm/UPSTREAM_DEPENDENCIES.md`: #120 Linux fork, #121 phantom active turn
(worked around; `session/fork` is unaffected), #112 MCP after compacted resume, the
loopback's `compaction_unavailable`, and the SDK-pin fingerprint warning. Update
`KNOWN` in `analyze.mjs` when that file changes.
