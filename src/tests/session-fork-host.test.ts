import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { MspError } from "@muse-code/sdk";
const mocks = vi.hoisted(() => ({ command: vi.fn(), close: vi.fn() }));
vi.mock("@muse-code/sdk", async (original) => ({
  ...(await original<typeof import("@muse-code/sdk")>()),
  spawnMspConnection: () => ({
    initialize: async () => ({ connection: { command: mocks.command } }),
    close: mocks.close,
  }),
}));
import { forkMuseSession } from "../session-fork.js";
const cwd = mkdtempSync(join(tmpdir(), "fork-host-"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));
const options = {
  sessionId: "source",
  cwd,
  env: {},
  museBinary: "/unused",
  checkHost: false,
  logger: { log() {}, error() {} },
};
let source: Record<string, unknown>;
let fork: Record<string, unknown>;
beforeEach(() => {
  source = {
    sessionId: "source",
    workspaceRoot: cwd,
    modelId: "selected",
    activeTurnId: null,
    status: "idle",
  };
  fork = {
    ...source,
    sessionId: "branch",
    forkedFrom: { sessionId: "source", cutCursor: "observed", cutExplicit: false },
  };
  mocks.command.mockReset().mockImplementation(async (method) => ({
    session: method === "session/read" ? source : fork,
    pendingRequests: [],
  }));
  mocks.close.mockReset().mockResolvedValue(undefined);
});
it("uses only public read/fork methods and releases the control host", async () => {
  await expect(forkMuseSession(options)).resolves.toMatchObject({
    session: { sessionId: "branch" },
  });
  expect(mocks.command.mock.calls.map(([method]) => method)).toEqual([
    "session/read",
    "session/fork",
  ]);
  expect(mocks.close).toHaveBeenCalledOnce();
});
it.each(["active", "unknown-active", "workspace"])(
  "rejects %s source before a native fork",
  async (kind) => {
    if (kind === "active") source.activeTurnId = "live-turn";
    if (kind === "unknown-active") delete source.activeTurnId;
    if (kind === "workspace") source.workspaceRoot = tmpdir();
    await expect(forkMuseSession(options)).rejects.toThrow();
    expect(mocks.command).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledOnce();
  },
);
it.each(["identity", "model", "provenance", "boundary"])(
  "rejects inconsistent fork %s",
  async (kind) => {
    if (kind === "identity") fork.sessionId = "source";
    if (kind === "model") fork.modelId = "different";
    if (kind === "provenance") fork.forkedFrom = null;
    if (kind === "boundary")
      fork.forkedFrom = { sessionId: "source", cutCursor: "observed", cutExplicit: true };
    await expect(forkMuseSession(options)).rejects.toThrow();
    expect(mocks.close).toHaveBeenCalledOnce();
  },
);
it.each([
  ["an earlier turn", "first", /accept only the latest one \(latest\)/],
  ["the latest turn", "latest", /rejected: forkBoundaryInvalid\. No model turn/],
])("explains a rejected boundary at %s", async (_, lastTurnId, message) => {
  mocks.command.mockImplementation(async (method) => {
    if (method === "session/read")
      return { session: source, pendingRequests: [], lastTurn: { turnId: "latest" } };
    throw new MspError({
      code: -32602,
      message: "invalid fork boundary: InvalidCut",
      data: { kind: "forkBoundaryInvalid" },
    });
  });
  await expect(forkMuseSession({ ...options, lastTurnId })).rejects.toThrow(message);
  expect(mocks.close).toHaveBeenCalledOnce();
});
it("preserves fork timeout certainty and never retries a possibly created branch", async () => {
  vi.useFakeTimers();
  try {
    mocks.command.mockImplementation(async (method) =>
      method === "session/read" ? { session: source, pendingRequests: [] } : new Promise(() => {}),
    );
    const pending = forkMuseSession(options);
    const assertion = expect(pending).rejects.toMatchObject({
      data: {
        failure: {
          kind: "deadlineExceeded",
          phase: "forking",
          execution: "notSubmitted",
          mutation: "possiblyApplied",
          outcome: "unknown",
        },
      },
    });
    await vi.advanceTimersByTimeAsync(20001);
    await assertion;
    expect(mocks.command.mock.calls.filter(([method]) => method === "session/fork")).toHaveLength(
      1,
    );
  } finally {
    vi.useRealTimers();
  }
});
