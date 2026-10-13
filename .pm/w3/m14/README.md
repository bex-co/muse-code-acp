# w3 · m14 — Plugin and hook visibility

**Worker:** worker1 **Goal:** `/plugins` and `/hooks` list installed plugins and hooks; plugin install and marketplace changes run only on explicit user commands. **Status:** todo

## Tasks (in order)

| id   | title                                                   | est | depends_on               |
| ---- | ------------------------------------------------------- | --- | ------------------------ |
| t001 | Verify plugin and hook visibility on the installed host | 1h  | w3/m7/t006               |
| t002 | Implement plugin and hook visibility                    | 2h  | w3/m14/t001              |
| t003 | Adoption surface                                        | 30m | w3/m14/t001, w3/m14/t002 |
| t004 | Simplify milestone changes                              | 30m | w3/m14/t003              |
| t005 | CI and behavior coverage                                | 45m | w3/m14/t004              |
| t006 | Close out milestone                                     | 15m | w3/m14/t005              |

## Definition of done

- Listing commands show host data; install/marketplace commands mutate only on explicit user input, surface host errors (`pluginNotFound`, `marketplaceAlreadyExists`, `pluginMutationsDisabled`) verbatim, and are covered by tests that never touch the real user configuration.
- Unverified operations remain unadvertised with a recorded reason.

## Source + Goal linkage

- **Source:** 2026-10-12 Muse feature research (user request "research recent muse wonder and add them to the offering"; `/pm all for w3`). SDK 1.3.0/1.4.4/1.4.6 method registries compared against adapter call sites: the SDK facade covers only turns, approvals and user input, and the adapter calls `session/read`, `view/page`, `model/list`, `session/setModel`, `session/setApprovalMode`, `session/list`, `session/fork`, `workflow/cancel`, `item/readOutput`, `turn/cancel`, `turn/steer`, `approval/decide` and `userInput/answer|cancel` only.
- **Goal linkage:** Truthful capabilities and usable editor integration: offer verified public Muse features through ACP instead of leaving them unreachable.
- **Expected outcome:** Users can inspect and manage Muse plugins and hooks from their client.
- **Methods:** plugin/list, hook/list (1.4.4); plugin/install, plugin/marketplaceAdd|Remove|Update (1.4.6); plugin/changed (non-folded).
- **Why now:** Plugin/hook management is new in 1.4.4/1.4.6 and otherwise requires leaving the client.
- **Adoption surface:** separate closing task t003.
- **Constraints:** public SDK/MSP only, feature-detected and live-verified on the installed host before advertisement (DO_NOT_DO); no fabricated controls; safe defaults unchanged.

## Validation evidence

Pending.
