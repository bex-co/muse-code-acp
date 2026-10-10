import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { spawnMuseExec } from "../muse-exec.js";
import { silentLogger } from "./helpers.js";

const envelope = (sequence: number, payloadType: string, event: Record<string, unknown>) =>
  JSON.stringify({
    schema_version: 1,
    id: `e${sequence}`,
    stream: { kind: "session", id: "s" },
    sequence,
    recorded_at: sequence,
    record_type: "event",
    durability: "durable",
    payload_type: payloadType,
    payload_schema_version: 1,
    payload: { kind: "task_lifecycle", event },
  });

function fakeExec(lines: string[], then: string): string {
  const dir = mkdtempSync(join(tmpdir(), "muse-exec-stall-"));
  const binary = join(dir, "muse");
  writeFileSync(
    binary,
    `#!/bin/sh\n${lines.map((l) => `printf '%s\\n' '${l}'`).join("\n")}\n${then}\n`,
  );
  chmodSync(binary, 0o755);
  return binary;
}

const proposed = envelope(1, "task.lifecycle.proposed", {
  kind: "proposed",
  task_kind: "tool.bash",
});

it("stops a run whose proposed tool never receives an approval decision", async () => {
  const handle = spawnMuseExec({
    prompt: "p",
    sessionId: "s",
    cwd: tmpdir(),
    museBinary: fakeExec([proposed], "exec sleep 30"),
    logger: silentLogger(),
    approvalStallMs: 200,
  });
  await Array.fromAsync(handle.events);
  expect(await handle.done).toMatchObject({ kind: "cancelled" });
  expect(handle.approvalStall()).toEqual({ taskKind: "tool.bash" });
});

it("does not fire once the proposed tool makes progress", async () => {
  const started = envelope(2, "task.lifecycle.started", { kind: "started" });
  const handle = spawnMuseExec({
    prompt: "p",
    sessionId: "s",
    cwd: tmpdir(),
    museBinary: fakeExec([proposed, started], "sleep 0.5; exit 0"),
    logger: silentLogger(),
    approvalStallMs: 200,
  });
  await Array.fromAsync(handle.events);
  expect(await handle.done).toMatchObject({ kind: "completed" });
  expect(handle.approvalStall()).toBeNull();
});
