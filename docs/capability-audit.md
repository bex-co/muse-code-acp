# Capability evidence and current ownership

Audited 2026-09-14 at SDK 0.1.1 with Muse 1.1.1-R2514.1 and
1.2.1-R2847.1 on macOS ARM64. “Native” means a public host operation;
“adapter” means a labeled client-side behavior. A declared schema, accepted
command, or configured credential alone does not establish delivery. Versions
outside this matrix need fresh behavior checks.

The [ownership ledger](../.pm/ownership-2026-09-14.md) remains authoritative.
Historical w1 milestones are source records; their replacement w2 tasks execute
current work. Future w1 notes are triggers, not dependencies of current delivery.
The table records the m6 audit snapshot; subsequent owner evidence can supersede it.

| Surface / public route                                | Current adapter contract and classification                                                                           | Evidence / sole remaining owner                                                                                                       |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| ACP initialize, authenticate, logout                  | Native CLI login/logout integration; SDK handshake; no inferred logged-in state                                       | `acp-agent.ts`, `muse-host.ts`; observed auth improvements w2/m8; slash logout w2/m10                                                 |
| new, load, resume                                     | SDK session/start/resume/read plus public export for history; one workspace root                                      | Both host suites; `acp-restart-live.test.ts`; additionalDirectories now rejected by all four lifecycle entries                        |
| list, close                                           | Native discovery with pagination; close releases the host and retains history                                         | `session-discovery-live.test.ts`; native deletion is absent, future w1/012                                                            |
| fork                                                  | Native full or completed-turn boundary fork, gated by SDK host support; separate owner/MCP inventory                  | `session-fork-live.test.ts`; no extra roots or silent recreation                                                                      |
| model/provider                                        | Adapter settings overlay plus explicit public setter; provider-qualified IDs; idle replacement                        | w2/m5 shipped; actual model requests verified on both hosts even when resume metadata already agrees                                  |
| named model profiles                                  | Catalog rows keep their profile identity and are selectable; setModel carries the profile                             | Muse 1.3.0-R3401.1: every live providerCatalog row carries the catalog profile; selecting one served that model                       |
| effort                                                | Requested preference; 1.1.1 omits main effort, 1.2.1 maps none→minimal and ultra→max                                  | w2/m5 provider matrix; no per-model restrictions inferred; future w1/010                                                              |
| client gateway and recommendations                    | Negotiated adapter-owned isolated settings/keys and advisory choice provenance                                        | w2/m5; no automatic selection, account/tier/quota claim or endpoint fallback                                                          |
| mode / native approval policy                         | Adapter automatic once choices are independent of native policy; dangerous modes guarded                              | w2/m4 tool effects; m6 policy menu/rejection share version decisions; 1.1.1 offers native onRequest only                              |
| sandbox / writes / shell / network                    | Native spawn-time flags, independent controls and retained safe defaults                                              | Both serve help and w2/m4 effects; platform limits recorded in m4; no implicit trust-workspace                                        |
| approval requested/updated/resolved                   | Real ACP decisions for host-offered stages, cancellation/stale handling and observed outcome                          | `muse-sdk.ts`, `muse-permissions.ts`, both multi-stage suites                                                                         |
| form user input                                       | Public answer/cancel; single/multiple/free text; missing form support cancels and fails                               | `muse-user-input.ts` and SDK user-input tests; userInput/clarify is declared but has no mapped ACP dialog action, behavior unverified |
| URL elicitation                                       | No correlated public URL request/settlement route found; ordinary form support does not imply it                      | SDK method/input declarations; future w1/009                                                                                          |
| cancel / steer                                        | Native turn/cancel; negotiated expected-turn steering and bounded queue                                               | `settings-live.test.ts`, SDK/reuse tests; command aliases and public alternate-route verification w2/m10                              |
| interrupt / unqueue / userShell / worker controls     | Public methods exist; not advertised as delivered controls                                                            | Current investigation and actual lifecycle/control delivery w2/m9; schema alone is unverified                                         |
| native compaction                                     | Both hosts reject completed durable-session compact with -32030 compaction_unavailable                                | Fresh `artifacts/w2-m6/compact-{111,121}.log`; future w1/004; local summary is not native compaction                                  |
| native goal mutation                                  | No set/pause/resume/clear method in pinned public registry                                                            | `/goal status` observes; `/goal task` explicitly executes once; future w1/002                                                         |
| MCP inventory and startup errors                      | Adapter inventory and observed startup errors; HTTP/stdio SDK support, stdio exec                                     | `mcp-http-live.test.ts`; native connected counts/status remain future w1/003                                                          |
| plan / review commands                                | Adapter workflows use public readonly flags and bounded Git snapshots; MCP guard remains                              | `workflows-live.test.ts`; no native review operation is claimed                                                                       |
| skills / rename / text search                         | Native skill expansion exists; command UX and adapter-owned title/search work pending                                 | Current w2/m10; native deletion remains separate w1/012                                                                               |
| prompt text/images/resources                          | Text, resource links, embedded text and image input; blobs/audio unsupported at audit time                            | `prompt-content.ts` and live resource/image tests; bounded embedded binary work w2/m10                                                |
| additional workspace roots                            | Public start has one workspaceRoot; no independent authorization route/serve flag                                     | m6 rejects new/load/resume/fork extras before binding; future w1/008                                                                  |
| agent message / toolCall                              | Public text deltas and snapshots; tool output, file reports; no private-reasoning access                              | `muse-sdk-events.ts`; richer public summaries/output w2/m7                                                                            |
| usage / context / todos / public reasoning            | Public events/items exist; current translator omissions assigned explicitly                                           | Current w2/m7; they do not depend on native compaction                                                                                |
| workflow / subagent / userShell / reminderChild items | 1.2.1 workflow completes; 1.1.1 workflow_launch_unavailable; current rendering incomplete                             | Fresh worker probes; current w2/m9; no blanket all-host worker blocker                                                                |
| separate native child history                         | Observed reminder child IDs reject read/resume -32020 on both probes                                                  | Future w1/005; a separate root session is not equivalent native child execution                                                       |
| structured tool media / output retrieval              | Mixed MCP text/image/link call produces flattened visibleOutput only; 1.1.1 terminal projectionError, 1.2.1 completes | Fresh rich probes; current public-output improvements w2/m7, native missing output/ref surface w1/007                                 |
| error and authentication terminals                    | Public authRequired/modelError observations exist; improved structured reporting pending                              | Current w2/m8; never replay an ambiguous turn to hide failure                                                                         |
| scheduled retries                                     | 503 causes provider retries and retryable modelError, without turn/retryScheduled on both hosts                       | Fresh retry probes (20 total requests including subordinate work); future w1/006, current errors w2/m8                                |
| account quotas / native tier                          | No pinned account/quota or tier-setting method; model pricing is not quota                                            | Future w1/010–011; no fabricated account facts                                                                                        |
| branchChanged / retracted / userMessage               | Branch has no owned ACP field; retracted is nonterminal; submitted prompt already belongs to client                   | Explicit decisions in `muse-view-events.ts`; not accidental silent capability claims                                                  |

All ACP handlers are enumerated in `createAgentConnection`; model/effort/mode and
safety options above cover their configuration routes. `muse-view-events.ts`
classifies every folded event and every named public item family; regression tests
compare against the installed declarations. Unknown future item kinds remain
unverified. Missing branch display is an explicit omission, not a native blocker.
Unknown slash names (including `/compact`) remain ordinary prompt text and are not
advertised commands; only registered adapter commands dispatch locally. Attached
or quoted command text is data. A model summary does not prove native compaction.

Availability decisions distinguish unknown selection, unsupported backend,
host-version limit, missing guard, temporarily busy and unverified behavior.
Advertisement and rejection share decisions for modes and native approval policy.
They never switch backends, authorize extra roots or select broader privilege.
Unverified named profile routing remains explicit instead of claiming an endpoint.

Rerun both host matrices after an SDK/host upgrade, a capability advertisement
change or a modified adapter route. For each newly positive host finding, retain
a provider/filesystem or native lifecycle assertion, assign one current w2 owner,
and retire only the exact former blocker. Do not relabel all neighboring features.

## m9 host-schema correction

The m6 table above is historical. Public host schema export, rather than only the
pinned SDK method union, shows that Muse 1.2.1 additionally serves rename, standing
effort, view subscribe and item/readOutput. Bounded real shell-output reads now
have positive evidence and are assigned to [w2/m11](../.pm/w2/done/m11/README.md).
Workflow cancellation is delivered by [w2/m9](../.pm/w2/done/m9/README.md) using the
public conformance contract even though SDK 0.1.1 omits its declaration.
