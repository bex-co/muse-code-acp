# w3 — project workstream (worker1)

**Worker:** worker1 — general-purpose worker for this project. Placement records scheduling and history, not permanent ownership or a component boundary.

## Milestones

- [x] [**m1** — Profiled catalog model selection and catalog-aware default](done/m1/README.md) (7 tasks) ← PR #10 triage (2026-10-06)
- [x] [**m2** — Muse 1.4.3 real-host compatibility](done/m2/README.md) (8 tasks) ← 1.4.3 live-suite triage (2026-10-06)
- [x] [**m3** — Release 0.8.0](done/m3/README.md) (5 tasks) ← release-readiness triage (2026-10-06)
- [x] [**m4** — Exec backend fidelity on Muse 1.4.x](done/m4/README.md) (7 tasks) ← promoted from w3/001 and w3/002 (2026-10-08)
- [x] [**m5** — Release 0.9.0 and report host regressions upstream](done/m5/README.md) (5 tasks) ← SDK 1.4.4 bump and w3/003 (2026-10-08)
- [x] [**m6** — Exec default-mode continuity and stall triage](done/m6/README.md) (9 tasks) ← promoted from w3/004 and the 2026-10-09 resolution plan
- [x] [**m7** — Catch up to SDK and Muse 1.4.6](done/m7/README.md) (6 tasks) ← 2026-10-12 Muse feature research
- [x] [**m8** — Native goal controls](done/m8/README.md) (6 tasks) ← 2026-10-12 Muse feature research
- [ ] [**m9** — Native session compaction](m9/README.md) (6 tasks) ← 2026-10-12 Muse feature research
- [x] [**m10** — Background task and workflow controls](done/m10/README.md) (6 tasks) ← 2026-10-12 Muse feature research
- [x] [**m11** — Recap and native session rename](done/m11/README.md) (6 tasks) ← 2026-10-12 Muse feature research
- [x] [**m12** — Skill activation, skill import and feedback](done/m12/README.md) (6 tasks) ← 2026-10-12 Muse feature research
- [x] [**m13** — Turn interrupt, unqueue and native usage](done/m13/README.md) (6 tasks) ← 2026-10-12 Muse feature research
- [x] [**m14** — Plugin and hook visibility](done/m14/README.md) (6 tasks) ← 2026-10-12 Muse feature research
- [x] [**m15** — Trustworthy quality gates](done/m15/README.md) (7 tasks) ← 2026-10-15 code-quality brainstorm
- [x] [**m16** — Real-host CI on the newest verified Muse](done/m16/README.md) (7 tasks) ← 2026-10-15 code-quality brainstorm
- [x] [**m17** — Catch up to ACP SDK 1.8.0 and Muse SDK 1.4.8](done/m17/README.md) (7 tasks) ← 2026-10-15 code-quality brainstorm
- [x] [**m18** — Split acp-agent.ts without changing behavior](done/m18/README.md) (8 tasks) ← 2026-10-15 code-quality brainstorm
- [ ] [**m19** — Standard ACP session state and stop reasons](m19/README.md) (6 tasks) ← 2026-10-15 code-quality brainstorm

## Inbox

- [005](005.md) — Side chats over ACP (deferred)
- [006](006.md) — Computer-use settings and setup (deferred)
- [009](009.md) — Assess stricter TypeScript compiler flags (after m18)
- [010](010.md) — Show native model retries as ACP notices (Muse 1.4.8; from w1/006)

001 and 002 were promoted to m4, 003 to m5 (2026-10-08) and 004 to m6 (2026-10-09).

## Dropped

- ~~**007**~~ — Media upload and video prompt input — dropped 2026-10-15: incorrect; user-requested triage. `media/upload` accepts only `video/mp4` and `video/quicktime` (it fills the session's video store; SDK 1.4.8 `MediaUploadParams`), so the note's "use it for large images/resources" is impossible. Its "video needs an ACP content type first" also doesn't hold up: ACP 1.8.0 still has no video `ContentBlock`, but `resource` blobs and `resource_link` can already carry video MIME types (`src/prompt-content.ts` rejects them today). A future video-input note should start from that mapping.
- ~~**008**~~ — Surface Muse reviewer decisions and decide on reviewer control — dropped 2026-10-15: outdated; user-requested triage. (1) Already delivered: clients negotiating `muse/approval` get `judgeEscalated` on permission requests and the final decision with `resolvedBy` through session-info `_meta` (`src/muse-sdk.ts` `publishApprovalResults`, `docs/workflows.md` § Permission presentation). On Muse 1.4.8-R6256.1 with the loopback reviewer approving, no permission prompt arrived, the tool ran and `resolvedBy: "llmJudge"` was published; an escalation reached the client with `resolvedBy: "user"` after the choice. (2) Nothing to offer: on 1.4.8 `muse serve --approval-judge` is refused ("not a serve option; approval mode is selected over the wire") and `-c approval_judge=…` is an unknown key. Only `muse exec --approval-judge` exists, and turning the reviewer off there would make headless exec stall on approvals (w3/m6). The reviewer behavior itself is recorded in w3/m7, CHANGELOG 0.10.0 Compatibility and the README.
