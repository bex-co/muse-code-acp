# Anti-goals — muse-code-acp

Read before proposing or materializing work.

- **Do not fork `claude-agent-acp` wholesale.** Transplant only the vendor-neutral shell (`utils.ts`, `index.ts` structure, `runAcp` wiring, `AcpClient`/`ClientConnection` seam, test-harness patterns, tooling configs). The consumer loop, translators, permissions, and settings layers are rewrites, not edits.
- **Do not fake interactive permissions.** The legacy exec backend may resolve approvals internally. Only expose an ACP `session/request_permission` round-trip when the documented SDK/MSP request and decision actually gate the tool call. Offer only host-provided choices and scopes; cancellation, dismissal, malformed replies, and stale decisions must not grant permission.
- **Do not drive the `muse` TUI.** No pty scraping, no `expect`-style automation of interactive mode. The SDK migration requested on 2026-09-11 authorizes the official `@muse-code/sdk` and documented MSP over `muse serve`. The legacy `muse exec --json` path and bounded CLI/store/export helpers may remain for explicit compatibility needs; do not replace public SDK APIs with private protocol internals.
- **Do not default to `--yolo` or `--disable-sandbox`.** Muse's sandbox+approval defaults stay on unless the user selects an ACP mode that explicitly maps to bypassing them.
- **Do not depend on undocumented Muse internals without feature detection.** Pin an exact SDK version and verify its minimum supported Muse host. Detect CLI support via `--help`, use the SDK/MSP initialize capabilities and documented schema compatibility rules, and retain `schema_version` / `payload_schema_version` checks for legacy JSONL. Do not invent missing MSP methods or silently replay an ambiguous turn through another backend.
- **Do not imply Meta affiliation.** This is an unofficial community adapter; README and package metadata must say so. Keep Apache-2.0 attribution (NOTICE) for code transplanted from `claude-agent-acp` (Zed Industries).
