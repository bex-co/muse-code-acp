import { describe, expect, it } from "vitest";
import { hostSupports } from "./helpers.js";

const requiring = (value: string) => ({ MUSE_CODE_ACP_REQUIRE_HOST_FEATURES: value });

describe("hostSupports", () => {
  it("runs a gated suite on a host that has the capability", () => {
    expect(hostSupports("goal-controls", "1.4.6", requiring("all"))).toBe(true);
    expect(hostSupports("session-commands", "1.4.7", {})).toBe(true);
    expect(hostSupports("exec-reviewer", "1.4.4", {})).toBe(true);
    expect(hostSupports("task-controls", "1.5.0", {})).toBe(true);
  });

  it("skips an unsupported capability unless the run requires it", () => {
    expect(hostSupports("session-commands", "1.4.6", {})).toBe(false);
    expect(hostSupports("exec-reviewer", "1.1.1", requiring("goal-controls"))).toBe(false);
  });

  it("fails a run that requires a capability the host lacks", () => {
    expect(() => hostSupports("session-commands", "1.4.6", requiring("all"))).toThrow(
      'Muse host 1.4.6 lacks required capability "session-commands"',
    );
    expect(() =>
      hostSupports("task-controls", "1.1.1", requiring("goal-controls, task-controls")),
    ).toThrow('lacks required capability "task-controls"');
    expect(() => hostSupports("goal-controls", null, requiring("goal-controls"))).toThrow(
      "Muse host (not found)",
    );
  });
});
