# Observed usage, plans and output

The SDK backend reports public host observations. Muse 1.1.1-R2514.1 and
1.2.1-R2847.1 are verified against local provider fixtures. Native compaction
(`/compact`, Muse 1.4.12+) is a separate operation and does not gate these reports.
Legacy exec retains its existing output path.

`/status` is an idle local command. It reports requested model/provider/effort/mode,
last observed model/approval policy, root-session token totals, context pressure
and plan size. Missing observations say `unknown`. The command starts no model
turn and does not execute accompanying text or attachments. It does not inspect
credentials, infer quotas or estimate missing values.

Clients may negotiate `clientCapabilities._meta["muse/usage"] = 1`. The adapter
then announces version 1 and emits optional `session_info_update` metadata:

```json
{
  "muse/usage": {
    "scope": "rootSession",
    "cumulative": { "promptTokens": 10, "outputTokens": 3, "totalTokens": 13 },
    "lastModelCall": { "turnId": "host-turn-id", "promptTokens": 10, "totalTokens": 13 }
  }
}
```

Cumulative counters are host-computed replacements, never increments for the
client to sum. Optional raw last-call counters retain the host's cache convention;
they are not reinterpreted as cumulative values. Native child usage is separate.
Known context occupancy **and** window size use standard ACP `usage_update`.
If the host supplies no size, the adapter does not invent a denominator: negotiated
metadata and `/status` preserve the known facts and unknown fields. No cost or
account quota is inferred. Baseline clients need no extension to use `/status`,
standard context updates, plans or tool/summary output.

Todo events replace the entire ACP plan, including an empty list. Native
`inProgress` maps to `in_progress`; cancelled entries are marked completed for
ACP display with an explicit `[Cancelled]` label. Other unknown statuses retain
a visible label and pending display state. Muse supplies no priority here, so
entries use neutral `medium` presentation. Plans are bounded to 500 entries and
8 KiB per entry, with visible omission/truncation notices.

Only public `reasoning.summary` parts and their deltas become
`agent_thought_chunk`. Completion-only summaries render once in part order;
providers with no summaries remain supported. Raw reasoning text and encrypted
provider state are never read for this feature.

Tool `output` deltas update their original call ID before completion. Final
snapshots replace the tool content, and absent final text preserves already
observed output. Public unknown item kinds display kind/status/fallback text;
worker-specific lifecycle/control remains separate. Text is bounded to 64 KiB
per surface with explicit truncation notices. Metadata-only media keeps an explicit unavailable explanation. Stored output
references can be read through the negotiated [output interface](stored-output.md)
on verified Muse 1.2.1; other clients/hosts retain explicit fallback notices. The adapter neither
fetches an invented output endpoint nor treats descriptive image text as bytes.
Observed file-change reports keep their content and these notices.

The SDK owns live gap recovery. The adapter reads only a current fold and replaces
observations after catch-up. Load/resume reconstruct the latest root facts through
at most 20 backward public pages of 100 events; missing facts within that budget
remain unknown, and obsolete client plans are cleared before new state is shown.
Opaque cursors are relayed, never sorted or fabricated. This is read-only and
starts no provider request. Repeated facts do not accumulate twice.
