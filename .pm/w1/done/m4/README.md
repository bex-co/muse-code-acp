# w1 · m4 — SDK execution and ACP wire contracts

**Worker:** worker1 **Goal:** The opt-in SDK backend uses supported SDK lifecycle APIs and passes real ACP stdio contracts for initialization, required prompt content, streaming, and tool updates. **Status:** done

## Tasks (in order)

| id   | title                                                     | est | depends_on |            |
| ---- | --------------------------------------------------------- | --- | ---------- | ---------- |
| t001 | Pin SDK and host compatibility with an ACP support matrix | 45m | —          | — **DONE** |
| t002 | Add a spawned ACP stdio contract harness                  | 60m | t001       | — **DONE** |
| t003 | Use public SDK session and turn lifecycle APIs            | 60m | t002       | — **DONE** |
| t004 | Enforce ACP version, capability, and error contracts      | 45m | t003       | — **DONE** |
| t005 | Preserve required text and resource-link prompt content   | 45m | t004       | — **DONE** |
| t006 | Add message and tool-event execution contracts            | 60m | t005       | — **DONE** |
| t007 | Simplify                                                  | 30m | t006       | — **DONE** |
| t008 | CI + test coverage                                        | 45m | t006, t007 | — **DONE** |
| t009 | Closeout                                                  | 15m | t008       | — **DONE** |

## Definition of done

- The pinned SDK and a verified Muse host have an explicit compatibility contract; unsupported hosts fail with an actionable error before starting a model turn.
- The SDK backend uses public SDK session/turn/fold facilities where available and retains one owned host per turn for the minimal migration; early completion before acknowledgement and bounded cleanup remain correct.
- A test client drives the built ACP entrypoint over stdio using a scripted MSP child; requests, responses, notifications, and error metadata survive actual serialization.
- Text and resource-link prompts, including link-only prompts, reach Muse in order. Optional unsupported content is handled explicitly and is not advertised.
- Core negotiation and message/tool event tests pass, including duplicate/completion-only events, stable tool IDs, invalid requests, and unavailable client capabilities.
- The existing exec behavior and common ACP contracts still pass. The SDK remains opt-in until m6's cutover gate, and the CI + test coverage task records results.

## Validation evidence (t008)

Commands (2026-09-12 local):

```sh
npm run build          # ok
npm run test:run       # 125 passed, 1 skipped (live real-provider)
npm run lint           # ok
npm run format:check   # ok
```

Versions: `@muse-code/sdk@0.1.1`, `@agentclientprotocol/sdk@1.3.0`, Muse host `1.1.1` (live suite when `muse serve --help` succeeds). Offline coverage uses `src/tests/fixtures/fake-msp.cjs` and `src/tests/fixtures/msp/*`; live host coverage remains in `muse-sdk-live.test.ts` (skipped without serve).

## Simplify notes (t007)

- Cached `probeSdkHost` per binary path.
- Deduped helper imports; cast env as `Record<string, string>` like existing CLI helpers.
- No behavior changes.

## Source + Goal linkage

- **Source:** User request (2026-09-11) to migrate muse-code-acp to the [official Muse Code SDK](https://github.com/meta-models/muse-code-sdk) and add critical ACP execution tests inspired by `.tmp/codex-acp`; builds on the existing opt-in SDK implementation.
- **Goal linkage:** Establishes the execution and test foundation for making SDK-driven Muse sessions the project's default backend.
- **Expected outcome:** A spawned ACP client can initialize, submit text or resource links, receive ordered text/tool updates, and complete a turn through the pinned SDK without losing content.
- **Why now:** The current SDK spike already proves basic execution, but manually routes MSP events and uses in-process ACP tests. Pin compatibility and prove the actual wire boundary before adding interaction or changing the default.
- **Cross-surface parity omitted:** This milestone changes the adapter, protocol boundary, tests, and documentation. It does not change a user-facing UI alongside a backend/API. ACP/backend contract assertions remain implementation work.

## Reference patterns and scope

- `src/muse-sdk.ts`, `src/muse-sdk-events.ts`, `src/tests/muse-sdk.test.ts`, and `src/tests/muse-sdk-live.test.ts` are existing work to extend, not a reason to recreate the initial spike.
- Use the installed SDK's public exports and generated types. Prefer MuseClient/Session; use public Connection methods only for declared operations the facade does not expose. Do not copy framing, retry, fold, or gap-fill internals.
- Reference: `.tmp/codex-acp/src/__tests__/acp-test-utils.ts`, `CodexACPAgent/typed-session-failure-wire.test.ts`, `CodexACPAgent/CodexAcpClient.test.ts`, and `CodexACPAgent/file-change-events.test.ts` (the latter paths are relative to that **tests** directory).
- Normative baseline: [ACP v1 initialization](https://agentclientprotocol.com/protocol/v1/initialization). Track protocol-major support separately from the ACP npm SDK version; newer optional APIs require compatible published types.
- Check in any adapted fixtures under src/tests. The ignored .tmp reference checkout must never be a build or CI dependency. Normalize volatile snapshot values while preserving session/turn/tool identity relationships and explicit behavior assertions.
- Audio/images, client filesystem or terminal delegation, optional session fork/delete/close methods, and Codex/AIR extensions are outside this minimal migration; leave them unadvertised and test capability-off behavior.
