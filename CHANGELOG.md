# Changelog

## Unreleased

### Fixes

- Offer the `max` reasoning effort, which Muse 1.3 and later treat as its own tier between `xhigh` and `ultra`. Previously `max` from Muse settings silently became `high` and a client selection of `max` was rejected, while `ultra` is gated on newer hosts and falls back to `xhigh`, so the strongest effort a user could reach was below `max` ([#13](https://github.com/bex-co/muse-code-acp/issues/13)).
- Log an unknown `reasoning_effort` in Muse settings before the default applies, instead of silently running at `high` ([#11](https://github.com/bex-co/muse-code-acp/issues/11)).
- Offer catalog models that carry a named profile. Muse 1.3.0 tags every live `providerCatalog` row with the catalog's profile, so the model menu showed only the current model and no catalog choice could be selected. Profiled rows are now advertised and selectable, and the profile travels with the selection through `session/setModel`. Verified on Muse 1.3.0-R3401.1 and 1.4.3 ([#10](https://github.com/bex-co/muse-code-acp/pull/10), thanks @jean-losi).
- Show a model selected before the catalog arrived, or saved by an earlier version without a profile, as the one catalog row it names instead of listing it twice.

### Features

- When Muse settings name no model, a new session takes its default from the Muse catalog once one is known before its first turn (after `/models`, or a catalog already discovered in this agent). A contributor catalog default yields to its listed non-contributor model, since contributor models may use content for product improvement. Without a catalog the default stays `muse-spark-1.2`.

## [0.7.0](https://github.com/bex-co/muse-code-acp/compare/v0.6.1...v0.7.0) (2026-09-25)

### Features

- Read an explicit gateway endpoint from `MUSE_CODE_ACP_GATEWAY_URL` and `MUSE_CODE_ACP_GATEWAY_KEY`, so a client that configures the agent's environment can route a session without negotiating `muse/provider`. Both variables are required together, the same URL validation, guards and session binding apply, and a client-supplied `muse/provider` still wins. SDK backend only.

### Fixes

- Report legacy `:auto-review` sessions that the host refuses to read (Muse 1.3.0-R3401.1, `resume_refused_class_c`) with the same actionable message as a refused resume, so `session/load` no longer surfaces the raw host refusal. Detection uses the structured refusal detail as well as the older message form.
- Advertise workflow `cancel` on Muse 1.3.0 as well as 1.2.1, after verifying public `workflow/cancel` against a real observed run on 1.3.0-R3401.1. Other hosts still show workflow cards without `cancel`.

### Dependencies

- Bump `@muse-code/sdk` from 0.1.1 to 1.3.0. The SDK now reroutes `onApproval` when `approval/updated` advances a multi-stage requirement ([upstream #10](https://github.com/meta-models/muse-code-sdk/issues/10)); the adapter already decides approvals from the fold, so behavior is unchanged. The three newly folded view events (`session/nameChanged`, `session/reasoningEffortChanged`, `session/modelRouteUnserved`) are classified as ignored.

### Compatibility and upgrading

The adapter now depends on `@muse-code/sdk@1.3.0`. No ACP IDs, config options or approval behavior change; approvals are still decided from the fold, so the SDK's new multi-stage routing is not relied on.

On Muse 1.3.0-R3401.1, a legacy `muse exec` session saved with `:auto-review` now fails at `session/load` rather than at the next prompt, because that host refuses to read it. The message and remedy are the same: continue it in Muse with reviewer support, or start a new ACP session. This is a host behavior change; the pinned 1.1.1 baseline is unchanged.

## [0.6.1](https://github.com/bex-co/muse-code-acp/compare/v0.6.0...v0.6.1) (2026-09-16)

### Fixes

- Name modes, models and reasoning efforts for the narrow chips clients render them in, keeping `muse`'s own vocabulary: SDK `default` reads as "On request" after `muse --approval-mode on-request`, `bypassApprovals` as "Auto-approve", `rejectApprovals` as "Reject prompts" because known-safe tools may still run, and exec `yolo` as "No approval, no sandbox" — `muse --yolo` disables both, and the name keeps the pair that `muse`'s own safety section states together. Effort tiers are capitalized, and a model shows its provider only when that distinguishes two catalog entries.
- Correct a stale live-test version gate that pinned the legacy `:auto-review` resume limitation to 1.2.1-R2847.1, so 1.3.0-R3057.1 was expected to continue successfully. Affected builds stay enumerated, which is how 1.3.0 was caught still reproducing the rejection rather than fixing it. Adapter behavior is unchanged; only the test expectation and its documentation moved.

### Compatibility and upgrading

Display names only: mode IDs, config option IDs, model choices and effort values are unchanged, so stored selections and automated clients keying on IDs are unaffected. A client that matches on the previous display strings should key on the ID instead.

The legacy `:auto-review` resume limitation is now confirmed on 1.3.0-R3057.1 as well as 1.2.1-R2847.1. This is an observation about the Muse host, not a regression in this adapter, and the pinned 1.1.1 baseline is unchanged.

## [0.6.0](https://github.com/bex-co/muse-code-acp/compare/v0.5.0...v0.6.0) (2026-09-15)

### Features

- Expose verified SDK approval policies with independent sandbox controls, provider-aware model selection, requested reasoning effort, and client gateway settings.
- Report live session progress, bounded stored output, structured failures, observed authentication, and asynchronous task state through negotiated capabilities.
- Support embedded prompt bytes and independent session commands while retaining explicit limits for unsupported host features.

### Fixes

- Create and restore sessions without starting a catalog-only host. Model choices update when an execution host becomes ready; `/models` explicitly refreshes choices before a turn. Clients must accept deferred configuration updates and must not treat the initial model menu as a complete catalog.
- Preserve the initiating SDK failure, startup deadline, cancellation, and whether a turn may have been submitted. Startup deadlines cover the full operation rather than restarting at each phase.
- Keep workflow cancellation targeted and preserve verified task visibility without automatically replaying uncertain requests.

### Compatibility and upgrading

Requires Node.js 22+ and `@muse-code/sdk@0.1.1`. Muse 1.1.1 remains the pinned baseline; the expanded 62-test real-host loopback suite also passes on 1.2.1. A targeted populated-history startup regression was additionally checked on 1.3.0; this is not a claim of full 1.3.0 compatibility.

Long-lived native history can still slow host initialization, especially under concurrency. This release removes unnecessary catalog hosts; it does not fix Muse's native history traversal. See [startup measurements and limitations](docs/muse-startup-latency.md). Applications that scope history to a scan must retain that data directory for subsequent session restoration.

## [0.5.0](https://github.com/bex-co/muse-code-acp/compare/v0.4.1...v0.5.0) (2026-09-14)

### Features

- Report observed host model and approval-mode changes through opt-in `muse/sessionState` metadata, including idle sessions. Host-offered persistent-rule choices remain explicitly unverified until a public host report establishes success or failure. Observation never changes policy or retries a turn.
- Expose synchronized ACP mode config options with the same validation and persistence as `set_mode`, including updates after model, effort and `/plan` changes. SDK clients cannot select exec-only bypass modes.
- Publish advisory `muse/hostCompatibility` metadata with the detected host version and pinned/served schema fingerprints.

### Fixes

- Complete multi-stage shell approvals on the SDK backend when Muse advances a requirement through `approval/updated` without re-issuing a request. Ask once per unresolved stage and submit only host-offered choices. Permission titles show current stage arguments and position in plain ACP clients.
- Bound pending host requests with no outstanding client call or host progress using `MUSE_CODE_ACP_STALL_MS` (default 10 seconds). Stalled approvals and user input fail with diagnostics; already-answered user input is not requested again.
- Require startup of ACP-provided MCP servers explicitly, restoring prompt failures for unauthorized, malformed and unreachable HTTP endpoints on Muse 1.2.1. User-configured server modes are preserved.
- Execute `/goal <task>` once with an explicit persistence limitation. Recognize slash commands across prompt text blocks and preserve attached text, resources and images through planning and review.
- Add review focus/default Git targets, local goal-status guidance, and bare `/plan` mode selection. Mixed requests containing planning remain planning-only.

### Compatibility and upgrading

Requires Node.js 22+ and pinned `@muse-code/sdk@0.1.1`. Muse **1.1.1-R2514.1** remains the supported baseline. The complete 29-test loopback suite also passes on **1.2.1-R2847.1**, with three legacy-continuation paths asserting the documented host limitation: saved `:auto-review` exec sessions cannot resume in `muse serve`. SDK-created continuity passes. Affected legacy sessions receive an actionable error and need a new ACP session or Muse with reviewer support; no saved profile is rewritten.

The multi-stage approval workaround is now included on npm; SDK users no longer need the exec workaround for that hang. The underlying SDK routing defect is tracked in [upstream issue #10](https://github.com/meta-models/muse-code-sdk/issues/10). Native automatic approval remains unverified; default sandboxing and real host permission gates remain enabled.

Pin the Muse binary outside the launcher's replaceable cache. Direct artifact URLs and SHA-256 checks are recorded in CI. The opt-in session-state extension reports observations only; it does not synchronize ACP settings. Policy-persistence failure recovery is covered by public-wire fixtures; no induced real-host policy-write failure is claimed.

## [0.4.1](https://github.com/bex-co/muse-code-acp/compare/v0.4.0...v0.4.1) (2026-09-13)

### Documentation

- Correct the README's host lifecycle, public session discovery and unsupported-worker claims; describe current session, prompt, workflow and negotiated capabilities.
- Add Node.js requirements, pinned-host login and Zed environment examples, explicit host compatibility limits, and accurate standalone distribution scope.
- Group user documentation before development details and use absolute repository links that work from npm.

Documentation-only patch; runtime behavior and dependencies are unchanged. Use Muse Code 1.1.1-R2514.1 with SDK 0.1.1; Muse 1.2.1-R2847.1 remains unsupported.

## [0.4.0](https://github.com/bex-co/muse-code-acp/compare/v0.3.0...v0.4.0) (2026-09-13)

### Features

- Fork native Muse sessions with isolated branch history, preserved model selection and verified restart continuity. Negotiated clients can select a completed-turn boundary.
- Show bounded, observed before/after file diffs and negotiated per-turn file-change reports. Reports explicitly mark partial coverage and concurrent-edit uncertainty; unknown preimages are no longer presented as file creation.
- Discover sessions through public, lease-free pagination, with scoped cursors, title/recency updates and optional fork provenance. Complete chronological load still uses validated export replay.
- Add guarded plan mode and Git review workflows. Planning disables workspace writes and shell execution; implementation requires an explicit mode change.
- Observe native goal state and progress, including autonomous work after the foreground prompt ends. Goal controls remain unadvertised where no verified public API exists.
- Add a reproducible standalone macOS ARM64 build and real-host smoke profile. The npm package remains the Node.js distribution; the standalone adapter still requires an external Muse host.

### Fixes

- Preserve fail-closed behavior when Muse encounters approval-settlement failures, with a safe numeric MSP error code for diagnosis.
- Bound file evidence and session discovery resources, close discovery hosts during disposal, and retire timed-out metadata hosts without replaying completed prompts.
- Publish through explicit GitHub Actions dispatch with OIDC authentication, after validating the exact release commit.

### Upgrading from npm 0.1.x

The previous GitHub 0.2.0/0.3.0 releases did not reach the public npm registry. This release also delivers their SDK-default execution backend, interactive ACP approvals, session close/resume, host reuse, negotiated mid-turn steering, embedded editor context, runtime model discovery, and HTTP MCP support with truthful local diagnostics.

Requires Node.js 22+ and the verified Muse Code **1.1.1-R2514.1** host with `muse serve`, selected with `MUSE_CODE_EXECUTABLE`, and pinned `@muse-code/sdk@0.1.1`. Configure credentials through Muse login or `META_API_KEY`. Explicit legacy execution remains available with `MUSE_CODE_ACP_BACKEND=exec`, with its documented capability differences.

### Known limits

Muse **1.2.1-R2847.1 is not supported**: six of 23 real-host checks failed because legacy exec sessions retained an unavailable `:auto-review` permission profile, and failed HTTP MCP connections no longer failed the prompt. Use the verified 1.1.1 host; do not disable permissions or sandboxing to work around these differences.

This is an unofficial adapter, not a claim of complete ACP/reference parity. Durable compaction, delegated child execution, scheduled retry observations, rich-output retrieval, multiple authorized roots, URL elicitation, account/service-tier APIs, native session deletion and broader approval-policy enforcement remain blocked or unverified on the tested host. File-change reports are partial; session indexes are eventually consistent. Default sandboxing and real host-provided permission gates remain enabled.


## [0.3.0](https://github.com/bex-co/muse-code-acp/compare/v0.2.0...v0.3.0) (2026-09-12)


### Features

* close Muse ACP sessions cleanly ([#4](https://github.com/bex-co/muse-code-acp/issues/4)) ([0aa9979](https://github.com/bex-co/muse-code-acp/commit/0aa99791f07070a623ae541e074a935f7a129dd2))
* discover Muse models and forward embedded editor context ([5188179](https://github.com/bex-co/muse-code-acp/commit/51881796f9b8d07bc82cdeaf9da9911a6a001a55))
* forward ACP prompt content to Muse ([#3](https://github.com/bex-co/muse-code-acp/issues/3)) ([3beeee8](https://github.com/bex-co/muse-code-acp/commit/3beeee88f84c13b5c6ba2947171b148ec0c4156f))
* resume Muse ACP sessions without replay ([#5](https://github.com/bex-co/muse-code-acp/issues/5)) ([dfc1d31](https://github.com/bex-co/muse-code-acp/commit/dfc1d3104f05f7be4b3417454d894885b9e56e44))
* reuse Muse hosts and support negotiated mid-turn steering ([3b26891](https://github.com/bex-co/muse-code-acp/commit/3b268916e294621de845e858ae528aac8373ff28))
* **skills:** add project PM and loop-worker workflows ([d5a2e7d](https://github.com/bex-co/muse-code-acp/commit/d5a2e7db849723fe9fab1e929ec5052fdc9f29c0))
* support HTTP MCP servers and local connection diagnostics ([9b9113e](https://github.com/bex-co/muse-code-acp/commit/9b9113e835dcdc910bda7307a02052759908b6bf))


### Bug Fixes

* harden ACP session lifecycle and prompt metadata ([7b1255f](https://github.com/bex-co/muse-code-acp/commit/7b1255f94fb946a25b80db93682dd2d638d3efa4))

## [0.2.0](https://github.com/bex-co/muse-code-acp/compare/v0.1.1...v0.2.0) (2026-09-12)


### Features

* make SDK the default backend with session continuity (m6) ([bd4f1c3](https://github.com/bex-co/muse-code-acp/commit/bd4f1c3ee2dbc4891236c44995889960ee87f605))
* ship interactive SDK approvals and resilient turns (m5) ([be80f1c](https://github.com/bex-co/muse-code-acp/commit/be80f1ce04a68c57110374a5967b606103ce98a2))
* ship SDK backend ACP wire contracts (m4) ([dcf9081](https://github.com/bex-co/muse-code-acp/commit/dcf90819ec0e8de78210d5140bd5c94efdda055e))


### Bug Fixes

* harden SDK interactions and gate release publishing ([7fe495b](https://github.com/bex-co/muse-code-acp/commit/7fe495b031fb6aec00daebf74ce7237a5120b7ec))

## [0.1.1](https://github.com/bex-co/muse-code-acp/compare/v0.1.0...v0.1.1) (2026-08-28)


### Bug Fixes

* normalize Muse ACP reliability signals ([768f78e](https://github.com/bex-co/muse-code-acp/commit/768f78e4619c0b83934b2179507e0a28024a5b16))
