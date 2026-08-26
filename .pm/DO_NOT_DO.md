# Anti-goals — muse-code-acp

Read before proposing or materializing work.

- **Do not fork `claude-agent-acp` wholesale.** Transplant only the vendor-neutral shell (`utils.ts`, `index.ts` structure, `runAcp` wiring, `AcpClient`/`ClientConnection` seam, test-harness patterns, tooling configs). The consumer loop, translators, permissions, and settings layers are rewrites, not edits.
- **Do not fake interactive permissions.** Muse Code 0.2.1 headless mode resolves approvals internally (policy + LLM judge); never present an ACP `session/request_permission` round-trip that cannot actually gate the tool call. Report-only is honest; a fake gate is not.
- **Do not drive the `muse` TUI.** No pty scraping, no `expect`-style automation of interactive mode. The integration surface is `muse exec --json` + the session store + `muse export`, nothing else.
- **Do not default to `--yolo` or `--disable-sandbox`.** Muse's sandbox+approval defaults stay on unless the user selects an ACP mode that explicitly maps to bypassing them.
- **Do not depend on undocumented Muse internals without feature detection.** The CLI surface is churning (docs describe `muse hooks` and exec-level `--approval-mode` that 0.2.1 lacks). Pin a minimum `muse` version, detect capabilities via `--help`, and gate on `schema_version` / `payload_schema_version` in the JSONL.
- **Do not imply Meta affiliation.** This is an unofficial community adapter; README and package metadata must say so. Keep Apache-2.0 attribution (NOTICE) for code transplanted from `claude-agent-acp` (Zed Industries).
