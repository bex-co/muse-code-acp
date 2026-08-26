import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MuseEnvelope, MuseLineParser } from "../muse-events.js";
import { spawnMuseExec } from "../muse-exec.js";
import { museCliPath } from "../muse-cli.js";
import { silentLogger } from "./helpers.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function parseAll(text: string): { envelopes: MuseEnvelope[]; garbage: [string, string][] } {
  const envelopes: MuseEnvelope[] = [];
  const garbage: [string, string][] = [];
  const parser = new MuseLineParser(
    (envelope) => envelopes.push(envelope),
    (line, reason) => garbage.push([line, reason]),
  );
  parser.push(text);
  parser.end();
  return { envelopes, garbage };
}

describe("MuseLineParser", () => {
  const fixture = readFileSync(join(fixturesDir, "echo-basic.jsonl"), "utf8");

  it("parses a recorded echo run into ordered envelopes", () => {
    const { envelopes, garbage } = parseAll(fixture);

    expect(garbage).toEqual([]);
    expect(envelopes.length).toBe(23);
    expect(envelopes.map((e) => e.sequence)).toEqual(
      [...envelopes].map((_, i) => envelopes[0].sequence + i),
    );
    const types = envelopes.map((e) => e.payload_type);
    expect(types).toContain("run.output.delta");
    expect(types[types.length - 1]).toBe("run.terminal.completed");

    const delta = envelopes.find((e) => e.payload_type === "run.output.delta");
    expect(delta?.payload.text).toBe("echo: fixture one");
  });

  it("survives split chunks mid-line", () => {
    const midpoint = Math.floor(fixture.length / 2);
    const envelopes: MuseEnvelope[] = [];
    const parser = new MuseLineParser((e) => envelopes.push(e));
    parser.push(fixture.slice(0, midpoint));
    parser.push(fixture.slice(midpoint));
    parser.end();
    expect(envelopes.length).toBe(23);
  });

  it("skips garbage lines without throwing and keeps parsing", () => {
    const lines = fixture.trim().split("\n");
    const withGarbage = [
      lines[0],
      "muse: some stray preamble",
      "{not json",
      ...lines.slice(1),
    ].join("\n");
    const { envelopes, garbage } = parseAll(withGarbage);

    expect(envelopes.length).toBe(23);
    expect(garbage.length).toBe(2);
    expect(garbage[0][1]).toBe("not JSON");
  });

  it("skips JSON lines that are not envelopes", () => {
    const { envelopes, garbage } = parseAll('{"hello": "world"}\n');
    expect(envelopes).toEqual([]);
    expect(garbage.length).toBe(1);
    expect(garbage[0][1]).toMatch(/not a muse envelope/);
  });

  it("passes through unknown schema versions with a warning", () => {
    const lines = readFileSync(join(fixturesDir, "echo-basic.jsonl"), "utf8").trim().split("\n");
    const doctored = JSON.parse(lines[0]);
    doctored.schema_version = 99;
    const { envelopes, garbage } = parseAll(`${JSON.stringify(doctored)}\n`);

    expect(envelopes.length).toBe(1);
    expect(envelopes[0].schema_version).toBe(99);
    expect(garbage.length).toBe(1);
    expect(garbage[0][1]).toMatch(/unexpected schema_version 99/);
  });
});

function museAvailable(): boolean {
  try {
    museCliPath();
    return true;
  } catch {
    return false;
  }
}

// Live spawns need the muse binary (echo provider — offline and free, but the
// CLI itself must be installed). CI without muse still runs everything above.
describe.skipIf(!museAvailable())("spawnMuseExec (live echo provider)", () => {
  it("streams envelopes and resolves completed", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "muse-exec-test-"));
    const handle = spawnMuseExec({
      prompt: "live test",
      sessionId: crypto.randomUUID(),
      cwd,
      provider: "echo",
      env: { ...process.env, XDG_DATA_HOME: join(cwd, "xdg-data") },
      logger: silentLogger(),
    });

    const collected: MuseEnvelope[] = [];
    for await (const envelope of handle.events) {
      collected.push(envelope);
    }
    const outcome = await handle.done;

    expect(outcome).toEqual({ kind: "completed", code: 0 });
    expect(collected.some((e) => e.payload_type === "run.output.delta")).toBe(true);
    expect(collected.at(-1)?.payload_type).toBe("run.terminal.completed");
  }, 30_000);
});

// The fake muse script blocks after its first envelope, so the kill path is
// deterministic and offline (`--echo-delay-ms` is TUI-only in muse 0.2.1).
describe("spawnMuseExec cancellation", () => {
  it("kill() resolves cancelled and reaps the child", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "muse-exec-test-"));
    const fakeMuse = join(fixturesDir, "fake-muse.cjs");
    chmodSync(fakeMuse, 0o755);
    const handle = spawnMuseExec({
      prompt: "blocked reply",
      sessionId: crypto.randomUUID(),
      cwd,
      museBinary: fakeMuse,
      logger: silentLogger(),
    });

    // Kill as soon as the stream proves the child is up.
    const iterator = handle.events[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value?.payload_type).toBe("run.lifecycle.started");
    handle.kill();

    const outcome = await handle.done;
    expect(outcome).toEqual({ kind: "cancelled", code: 130, signal: null });
  }, 15_000);
});
