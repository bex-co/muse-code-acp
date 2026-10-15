# Session discovery and metadata

The SDK backend uses public Muse `session/list` on verified Muse 1.1.1-R2514.1 with SDK 0.1.1.
Each ACP response contains at most 50 sessions. Send its `nextCursor` with the
same `cwd` to continue; omit it to refresh. The opaque adapter cursor binds the
native cursor to the canonical workspace and backend. Malformed cursors and
changed filters are rejected. Listing never starts/resumes a native session or
acquires its writer lease. Disposing ACP closes outstanding discovery processes.

Muse orders by activity descending using its native index. The index is eventually
consistent: newly created sessions and recent turns may appear only after the
index catches up. Pages are not a frozen snapshot. Concurrent activity can move a
session ahead of an existing cursor; refresh from the first page to observe it.
Do not parse the native cursor or infer exact current turn counts from list rows.
Each listing starts a fresh discovery host, so it sees what Muse has persisted. A
session that another Muse process started but never prompted may be missing, and
Muse discards it when that process exits (observed on 1.1.1 and 1.4.7). Sessions
with a completed turn, and their forks, are durable.
The real-host acceptance traverses 52 such sessions, created by two Muse
processes, including a source and native fork.

Titles use a nonempty host title when supplied. The tested public host schema has
no title field or rename event, so the compatibility fallback reads at most 64 KiB
from each listed session's log head to find its first prompt, truncated to 80
characters. It never enumerates the store to render a public page. Missing or
unreadable prompt evidence displays `(no prompt)`. There is no model-generated
title request. On Muse 1.4.7 or newer, `/rename` also sets Muse's own session name
through `session/rename` (immediately when the session's host is open, otherwise
when it next starts); Muse normalizes names (for example to lower case), so the
adapter title keeps the user's text for display.

Load and cold resume publish `session_info_update` from the public metadata read.
Successful native turns with no active goal or subsequent native turn make a bounded, optional metadata read using the same
host, and publish the observed title and recency. Metadata failure does not change
the turn result; a timed-out request retires that host before subsequent work.
Fresh reads and index pages can temporarily differ in recency. Clients negotiating
`_meta["muse/fork"]: 1` also receive source/cut provenance in list and metadata
updates. Other clients receive the standard title/recency fields.

Complete chronological history still uses `muse export`, including its existing
schema/size checks and explicit failures. Public `session/read` can return inline,
snapshot, anchored-snapshot or absent history; an anchor is not proof of a complete
transcript. This change does not silently replace full replay with a suffix. Load,
resume and fork compatibility lookups retain their existing read-only store
helpers; metadata notifications do not replay transcript events.

The explicit `MUSE_CODE_ACP_BACKEND=exec` compatibility backend retains store
enumeration and offset pagination. Its pages are also bounded to 50 results, but
concurrent changes may shift offsets. SDK discovery failures are reported instead
of silently falling back to a different backend. No list/load operation makes a
paid provider request.
