/**
 * Failures older Muse hosts report for upstream bugs a later Muse release fixed.
 * Matched on Muse's own error text only; the hint names the fixing release so
 * users on an affected host know that updating Muse is the remedy.
 */
const FIXED_UPSTREAM: readonly { pattern: RegExp; hint: string }[] = [
  {
    // muse-code-sdk#120: every session/fork on Linux, Muse 1.4.12–1.4.13.
    pattern: /file birth time is unavailable/,
    hint: "Muse 1.4.14 fixes forking on Linux; update Muse.",
  },
  {
    // muse-code-sdk#112: MCP startup skipped after resuming a compacted session, 1.4.11–1.4.13.
    pattern: /MCP startup audit failed/,
    hint: "If this session was compacted and then reopened, Muse 1.4.11 through 1.4.13 lose its MCP servers; Muse 1.4.14 fixes it, so update Muse.",
  },
];

/** The upgrade hint for a failure an older Muse host is known to report, if any. */
export function upstreamFixHint(message: string): string | undefined {
  return FIXED_UPSTREAM.find(({ pattern }) => pattern.test(message))?.hint;
}

/** `message` followed by its upgrade hint, when it has one. */
export function withUpstreamFixHint(message: string): string {
  const hint = upstreamFixHint(message);
  return hint ? `${message} ${hint}` : message;
}
