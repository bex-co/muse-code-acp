# Session branching

The SDK backend supports ACP `session/fork` with Muse 1.1.1 or newer exposing
`serve`. The exec backend and older or unrecognized hosts do not advertise fork.
The source must already exist in the native Muse store, be inactive with no
pending interaction, and belong to the requested absolute `cwd`. Additional
workspace roots are rejected.

A baseline request copies all completed history into a distinct native session:

```json
{ "sessionId": "source-session-id", "cwd": "/absolute/workspace", "mcpServers": [] }
```

To select a completed turn boundary, initialize with client capability
`_meta: { "muse/fork": 1 }`. The agent acknowledges that extension. Then include:

```json
{
  "sessionId": "source-session-id",
  "cwd": "/absolute/workspace",
  "_meta": { "muse/fork": { "lastTurnId": "observed-muse-turn-id" } }
}
```

The turn is included. Unknown or unfinished boundaries fail without changing the
source. Muse 1.4.3-R5018.1 also rejects every completed turn except the latest
(`forkBoundaryInvalid`), although its own schema accepts any completed turn; the
adapter then names the latest turn ID, and forking at it or without a boundary
still works. Earlier boundaries are not emulated. Turn IDs can be observed through the separately negotiated
`muse/steering` extension; they are native turn IDs, not ACP request IDs or counts.
The fork response includes its new `sessionId`, configuration, and default mode.
Negotiated metadata includes source identity, the host's opaque `cutCursor`, and
whether the boundary was explicit. A fork does not stream copied history during
creation; `session/load` replays it and `session/resume` continues without replay.

The branch retains the source's saved model and adapter effort preference. Muse
1.1.1 initializes fork model metadata from its host settings, so the adapter uses
the same isolated settings overlay as ordinary SDK turns and verifies the model
returned by Muse. An accepted idle `session/setModel` alone did not establish
that model was persisted; the adapter does not rely on that acknowledgement.
Native session history is created by public `session/fork`, never copied locally.

Each branch gets its own configuration, host and MCP inventory supplied in the
fork request. Safety mode resets to `default` with normal sandbox protection and
onRequest approvals; earlier permission grants are not inherited. Source settings
and messages remain independent. Binding operations reject concurrent prompts,
close and duplicate fork requests; disposal cannot install a late fork result.
If a native fork was created before a later validation or shutdown failure, its
native record may remain discoverable; no deletion or automatic replay is attempted.

Acceptance covers real Muse with a local loopback provider, explicit and default
boundaries, invalid boundaries, model/effort preservation, and independent
source/fork provider input after restarting the ACP process. On 1.4.3-R5018.1 the
same test asserts the earlier-boundary rejection and cuts at the latest turn. Other
compatibility claims still need their own host evidence.
