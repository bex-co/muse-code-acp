import { afterEach, expect, test, vi } from "vitest";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Connection } from "@muse-code/sdk";
import { MuseModelDiscovery, readModelCatalog } from "../model-discovery.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function setup(
  options: { mode?: string; ttlMs?: number; timeoutMs?: number; maxEntries?: number } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "muse-discovery-"));
  mkdirSync(join(root, "muse"));
  const catalog = join(root, "catalog.json");
  const capture = join(root, "capture.jsonl");
  const pid = join(root, "pid");
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: root,
    FAKE_MSP_MODELS: catalog,
    FAKE_MSP_CAPTURE: capture,
    FAKE_MSP_PID: pid,
    FAKE_MSP_MODE: options.mode ?? "complete",
  };
  const binary = join(root, "fake-msp.cjs");
  copyFileSync(resolve("src/tests/fixtures/fake-msp.cjs"), binary);
  chmodSync(binary, 0o755);
  const discovery = new MuseModelDiscovery({
    env,
    museBinary: binary,
    logger: { log() {}, error() {} },
    ...options,
  });
  cleanups.push(async () => {
    await discovery.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  const setModels = (ids: string[]) =>
    writeFileSync(
      catalog,
      JSON.stringify({
        source: "fakeCatalog",
        models: ids.map((id) => ({ modelId: id, displayLabel: `Label ${id}`, description: null })),
      }),
    );
  setModels(["first"]);
  const calls = () =>
    readFileSync(capture, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((r) => r.method === "model/list").length;
  const dead = () => expect(() => process.kill(Number(readFileSync(pid, "utf8")), 0)).toThrow();
  return { root, binary, catalog, env, discovery, setModels, calls, dead };
}

test("discovers host rows, coalesces requests, caches snapshot and invalidates settings content", async () => {
  const f = setup();
  const [first, parallel] = await Promise.all([
    f.discovery.discover(f.root),
    f.discovery.discover(f.root),
  ]);
  expect(first).toEqual({
    status: "available",
    source: "fakeCatalog",
    models: [{ id: "first", name: "Label first" }],
  });
  expect(parallel).toEqual(first);
  expect(f.calls()).toBe(1);
  f.dead();
  f.setModels(["next", "another"]);
  expect(await f.discovery.discover(f.root)).toEqual(first);
  writeFileSync(join(f.root, "muse", "settings.json"), '{"model":"next"}');
  expect(await f.discovery.discover(f.root)).toMatchObject({
    models: [{ id: "next" }, { id: "another" }],
  });
  expect(f.calls()).toBe(2);
  writeFileSync(join(f.root, "muse", "auth.json"), '{"token":"changed"}');
  await f.discovery.discover(f.root);
  expect(f.calls()).toBe(3);
  f.env.XDG_CONFIG_HOME = join(f.root, "different-config");
  await f.discovery.discover(f.root);
  expect(f.calls()).toBe(4);
});

test("bounded LRU evicts old workspaces and TTL refreshes changed catalogs", async () => {
  const f = setup({ maxEntries: 1 });
  const other = join(f.root, "other");
  mkdirSync(other);
  await f.discovery.discover(f.root);
  await f.discovery.discover(other);
  f.setModels(["changed"]);
  expect(await f.discovery.discover(f.root)).toMatchObject({ models: [{ id: "changed" }] });
  expect(f.calls()).toBe(3);
  const expired = setup({ ttlMs: 0 });
  await expired.discovery.discover(expired.root);
  expired.setModels(["fresh"]);
  expect(await expired.discovery.discover(expired.root)).toMatchObject({
    models: [{ id: "fresh" }],
  });
});

test.each([
  null,
  {},
  { source: "fakeCatalog", models: [{ modelId: "x" }] },
  {
    source: "fakeCatalog",
    models: [
      { modelId: "x", displayLabel: "X" },
      { modelId: "x", displayLabel: "X" },
    ],
  },
])("malformed discovery uses cached explicit fallback: %j", async (value) => {
  const f = setup();
  writeFileSync(f.catalog, JSON.stringify(value));
  const result = await f.discovery.discover(f.root);
  expect(result).toMatchObject({ status: "fallback", models: [], reason: expect.any(String) });
  expect(await f.discovery.discover(f.root)).toEqual(result);
  expect(f.calls()).toBe(1);
  f.dead();
});

test("unsupported method falls back and an empty supported catalog remains valid", async () => {
  const f = setup();
  delete (f.env as Partial<typeof f.env>).FAKE_MSP_MODELS;
  expect(await f.discovery.discover(f.root)).toMatchObject({ status: "fallback", models: [] });
  f.dead();
  const empty = setup();
  empty.setModels([]);
  expect(await empty.discovery.discover(empty.root)).toEqual({
    status: "available",
    source: "fakeCatalog",
    models: [],
  });
});

test("deadline closes an unresponsive host and disposal prevents further spawning", async () => {
  // The deadline also covers spawning the fake host, which must reach model/list first.
  const f = setup({ mode: "model-timeout", timeoutMs: 2000 });
  expect(await f.discovery.discover(f.root)).toMatchObject({
    status: "fallback",
    reason: "Muse model discovery timed out",
  });
  f.dead();
  await f.discovery.dispose();
  expect(await f.discovery.discover(f.root)).toMatchObject({
    status: "fallback",
    reason: "Model discovery is disposed",
  });
  expect(f.calls()).toBe(1);
});

test("dispose drains a pending handshake without waiting for the discovery deadline", async () => {
  const f = setup({ timeoutMs: 30_000 });
  Object.assign(f.env, { FAKE_MSP_BARRIER: "handshake" });
  const result = f.discovery.discover(f.root);
  await expect
    .poll(() => {
      try {
        return readFileSync(join(f.root, "pid"), "utf8");
      } catch {
        return "";
      }
    })
    .not.toBe("");
  await f.discovery.dispose();
  expect(await result).toMatchObject({ status: "fallback" });
  f.dead();
});

test("a replaced host binary invalidates the cached catalog", async () => {
  const f = setup();
  await f.discovery.discover(f.root);
  f.setModels(["updated-host"]);
  appendFileSync(f.binary, "\n// New host build\n");
  expect(await f.discovery.discover(f.root)).toMatchObject({ models: [{ id: "updated-host" }] });
  expect(f.calls()).toBe(2);
});

test("retains duplicate model names across distinct provider identities", async () => {
  const f = setup();
  writeFileSync(
    f.catalog,
    JSON.stringify({
      source: "fakeCatalog",
      models: [
        { modelId: "same", displayLabel: "Same", providerId: "one" },
        { modelId: "same", displayLabel: "Same", providerId: "two" },
      ],
    }),
  );
  expect(await f.discovery.discover(f.root)).toMatchObject({
    status: "available",
    models: [
      { id: "same", providerId: "one" },
      { id: "same", providerId: "two" },
    ],
  });
});

test("borrowed catalog waiters share one request and cancelling one does not close the host", async () => {
  const gate = Promise.withResolvers<unknown>();
  const request = vi.fn().mockReturnValue(gate.promise);
  const close = vi.fn();
  const connection = { request, close } as unknown as Connection;
  const abort = new AbortController();
  const first = readModelCatalog(connection, abort.signal);
  const second = readModelCatalog(connection);
  abort.abort();
  expect(await first).toMatchObject({ status: "fallback", reason: "Model discovery cancelled" });
  expect(request).toHaveBeenCalledTimes(1);
  expect(close).not.toHaveBeenCalled();
  gate.resolve({ source: "test", models: [{ modelId: "x", displayLabel: "X" }] });
  expect(await second).toMatchObject({ status: "available", models: [{ id: "x" }] });
  await readModelCatalog(connection);
  expect(request).toHaveBeenCalledTimes(2);
  expect(close).not.toHaveBeenCalled();
});
