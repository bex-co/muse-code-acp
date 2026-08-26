import { expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnMuseExec } from "../muse-exec.js";

it("spawn-level echo provider under vitest", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "dbg-"));
  const handle = spawnMuseExec({
    prompt: "dbg hello",
    sessionId: crypto.randomUUID(),
    cwd,
    provider: "echo",
    env: { ...process.env, XDG_DATA_HOME: join(cwd, "xdg") },
    logger: { log: (...a) => console.error("LOG", ...a), error: console.error },
  });
  let text = "";
  for await (const e of handle.events) {
    if (e.payload_type === "run.terminal.completed") text = String(e.payload.text);
  }
  console.error("TERMINAL TEXT:", text);
  expect(text.length).toBeGreaterThan(0);
}, 30000);
