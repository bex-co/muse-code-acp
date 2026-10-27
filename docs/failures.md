# Failures and authentication observations

SDK turn failures retain `error.data.failure` with `kind`, `source` (host,
provider, transport or adapter), optional host `retryable`, `outcome` and a recovery hint.
Unknown native kinds remain visible. `authRequired` uses ACP's authentication
error; other failures use an internal-error response with this structured data.
Cancellation and step limits retain their standard ACP stop reasons.

A retryable failure does not schedule a retry. The adapter never resubmits an
ambiguous turn. After a transport failure, reload and inspect the session before
explicitly deciding to submit again. Native retry scheduling remains a
[future host integration](../.pm/w1/done/006.md).

Clients can negotiate `clientCapabilities._meta["muse/authStatus"] = 1`.
Initialize, authenticate and logout responses describe credential configuration;
SDK turns also emit `session_info_update._meta["muse/authStatus"]` with:

- `configured` and `source`: environment, stored file, client provider or none.
  A nonempty credential file is configuration evidence only; its contents are
  never read by the adapter.
- `verification`: `unknown`, `rejected` following native `authRequired`, or
  `acceptedForTurn` following a successful SDK turn. This last value describes
  that turn's outcome, not validation of an account, every stored credential, or
  future requests. Account `identity` is always `unknown`.
- Session-scoped `latestFailure`, cleared by a later successful turn. Other
  sessions retain independent observations. Close/reload, credential replacement
  and logout clear transient verification; restored configuration is unverified.

`authenticate` checks configuration and does not contact a provider. Expired
credentials can therefore be configured with verification unknown until a real
turn rejects them. `muse logout` cannot unset an inherited `META_API_KEY`; logout
still reports that environment key as configured and unverified. All adapter sessions and retained hosts are closed by logout; client gateway
credentials are removed from adapter memory.

Baseline clients receive standard errors and can use SDK `/status` for local
configuration/observation text. Exec supports configuration reporting but has no
structured native turn evidence; it never emits SDK verification observations.
No raw stderr or arbitrary protocol data is copied into SDK turn errors. Error
messages are bounded and redact supplied secret environment values, bearer
credentials and common credential URL forms.

## Startup phases and deadlines

SDK host initialization, session preparation and turn submission have separate
budgets. Initialization includes spawning and the public initialize handshake;
preparation includes session resume/start and applying/verifying settings.
Submission ends when the SDK returns the turn acknowledgement. Model execution
then follows the existing turn/cancellation/watchdog rules, not a startup timer.

| Setting                            | Default  | Scope                                                   |
| ---------------------------------- | -------- | ------------------------------------------------------- |
| `MUSE_CODE_ACP_STARTUP_TIMEOUT_MS` | `120000` | Each initialization and preparation phase independently |
| `MUSE_CODE_ACP_SUBMIT_TIMEOUT_MS`  | `30000`  | Waiting for the turn submission acknowledgement         |

Values are positive integer milliseconds, at most 2147483647; zero does not
silently disable cleanup limits. Set them in the adapter's environment. They do
not change Muse permissions, provider deadlines, or the legacy exec backend.
Phase transition timings are logged without prompt content or credentials.

The previous shared 20-second cutoff rejected an observed successful 29-second
native initialization. The two-minute startup budget provides roughly fourfold
headroom over that observation while bounding unattended waits. It is an
operational default, not a claimed maximum startup latency: increase it for an
environment whose measured cold starts require more time. Separating phases
prevents session restoration from consuming the handshake's remaining budget.
The 30-second acknowledgement budget is separate from model generation and gives
headroom over measured concurrent acknowledgement latency; loss of that reply
still does not prove the turn was rejected.

SDK failures now include `phase` (`initializing`, `preparing`, `submitting`,
`running`, `reading`, or `forking`) and `execution` in `error.data.failure`. Adapter deadlines
use `kind: "deadlineExceeded"`, `source: "adapter"`. The first observed initiating
failure wins; a cleanup EOF cannot replace its timeout. A requested cancellation
still returns ACP's normal cancelled result; cancelling after an already observed
failure does not hide that failure. Recognized host environment diagnostics and
native authentication/provider errors remain available.

- `execution: "notSubmitted"`: this operation failed before submission or was
  read-only. Startup/read failures have a failed outcome, and the error says no model turn was submitted
  by this operation. Inspect host availability, configuration and the named
  deadline before explicitly retrying.
- `execution: "possiblySubmitted"`: submission has begun. A transport or
  acknowledgement-timeout failure has unknown outcome; reload and inspect the
  session before deciding whether to submit again. A separately observed native
  terminal can still supply a definite failure. No automatic turn replay occurs.

Read/list hosts use the startup budget for initialization, then a separate
20-second bounded read budget. Load/resume, goal inspection and stored-output
reads share this path. Adapter disposal aborts these reads and awaits host cleanup;
list requests also retain their caller-abort handling. Model discovery retains
its independent five-second advisory budget and fallback catalog behavior.
Read timeouts never claim that a model turn was submitted. Fork control hosts also
use the shared startup policy, followed by bounded source reads and a separate
20-second fork request budget. A failure after fork submission adds
`mutation: "possiblyApplied"` and an unknown outcome: no model turn was submitted,
but a branch may have been created. Inspect session/list before retrying.

Regression evidence includes an induced 21-second real-host start, cancellation
and deadline cleanup, and 16 independent concurrent ACP clients on both supported
host versions. This does not establish that every failure in the original external
review integration had the same cause, or fix that client's error suppression and
retry policy.
