import { modelChoice } from "../config-options.js";
import { probeSdkHost } from "../muse-host.js";
import { startLoopbackProvider } from "./loopback-provider.js";
import { expectLegacyContinuation, expectLegacyLoad } from "./acp-real-host-helpers.js";
import { CAT_IMAGE_BASE64 } from "./fixtures/cat-image.js";
import { methods } from "@agentclientprotocol/sdk";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { museCliPath } from "../muse-cli.js";
import { connectTestClient, initialized, museAvailable, capturingLogger } from "./helpers.js";

const available = museAvailable() && spawnSync(museCliPath(), ["serve", "--help"]).status === 0;
const requireMuse = process.env.MUSE_CODE_ACP_REQUIRE_MUSE === "1";

if (requireMuse && !available) {
  throw new Error(
    "muse serve ≥1.1.1 is required for MUSE_CODE_ACP_REQUIRE_MUSE=1 (m6 integration job)",
  );
}

/** Real Muse + real SDK, with a loopback provider and isolated dummy credentials. */
describe.skipIf(!available)("SDK live host (no external API)", () => {
  it("streams, resumes across processes, lists/loads history, cancels and continues", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-sdk-live-"));
    const cwd = join(root, "workspace");
    const config = join(root, "config", "muse");
    mkdirSync(cwd);
    mkdirSync(config, { recursive: true });
    let holdResponses = false;
    const server = createServer((request, response) => {
      request.resume();
      request.on("error", () => {});
      response.on("error", () => {});
      request.on("end", () => {
        if (request.method === "GET" && request.url?.endsWith("/muse-code/models")) {
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              object: "list",
              data: [
                {
                  id: "fake-model",
                  object: "model",
                  metadata: {
                    "muse-code": {
                      release_date: "2026-01-01",
                      is_hidden: false,
                      limit: { context: 1_000_000, output: 1024 },
                    },
                  },
                },
              ],
            }),
          );
          return;
        }
        if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
          response.writeHead(404).end();
          return;
        }
        response.setHeader("content-type", "text/event-stream");
        const frame = {
          id: "test-response",
          object: "response",
          model: "fake-model",
          status: "in_progress",
          output: [],
        };
        const sse = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
        sse({ type: "response.created", sequence_number: 1, response: frame });
        sse({
          type: "response.output_text.delta",
          sequence_number: 2,
          output_index: 0,
          item_id: "test-message",
          content_index: 0,
          delta: "sdk live reply",
        });
        if (!holdResponses) {
          sse({
            type: "response.completed",
            sequence_number: 3,
            response: {
              ...frame,
              status: "completed",
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          });
          response.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test provider did not bind");
    }
    writeFileSync(
      join(config, "settings.json"),
      JSON.stringify({
        schema_version: 1,
        model: "fake-model",
        reasoning_effort: "none",
        endpoint_transport: { base_url: `http://127.0.0.1:${address.port}`, auth: "bearer" },
      }),
    );
    writeFileSync(
      join(config, "auth.json"),
      JSON.stringify({ schema_version: 1, providers: { meta: { api_key: "test-dummy-key" } } }),
    );
    const env = {
      HOME: root,
      PATH: process.env.PATH,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      TBH_CREDENTIAL_BACKEND: "file",
      TBH_DISABLE_TELEMETRY: "1",
      MUSE_CODE_ACP_BACKEND: "sdk",
    };
    const first = connectTestClient({ env });
    const second = connectTestClient({ env });
    const legacy = connectTestClient({ backend: "exec", provider: "echo", env });
    try {
      const ctx = await initialized(first);
      const { sessionId } = await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] });
      const prompt = [{ type: "text" as const, text: "repeat token sdk-test" }];
      for (let i = 0; i < 2; i++) {
        await expect(
          ctx.request(methods.agent.session.prompt, { sessionId, prompt }),
        ).resolves.toEqual({ stopReason: "end_turn" });
      }
      const chunks = first.updates
        .map((n) => n.update)
        .filter((u) => u.sessionUpdate === "agent_message_chunk");
      expect(chunks.map((u) => (u.content.type === "text" ? u.content.text : "")).join("")).toBe(
        "sdk live replysdk live reply",
      );

      // A retained host owns the native writer lease until close/idle expiry.
      await ctx.request(methods.agent.session.close, { sessionId });
      const loaded = await initialized(second);
      const listing = await loaded.request(methods.agent.session.list, { cwd });
      expect(listing.sessions.some((s) => s.sessionId === sessionId)).toBe(true);
      await loaded.request(methods.agent.session.load, { sessionId, cwd, mcpServers: [] });
      expect(JSON.stringify(second.updates)).toContain("sdk live reply");
      await loaded.request(methods.agent.session.setMode, { sessionId, modeId: "readOnly" });
      holdResponses = true;
      const running = loaded.request(methods.agent.session.prompt, { sessionId, prompt });
      const state = second.agent.sessions.get(sessionId)!;
      await expect.poll(() => state.activeTurn, { timeout: 10_000 }).not.toBeNull();
      // The loopback endpoint holds all responses, including reminder calls,
      // so the host stays active until the adapter sends turn/cancel.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await loaded.notify(methods.agent.session.cancel, { sessionId });
      await expect(running).resolves.toEqual({ stopReason: "cancelled" });
      holdResponses = false;
      await expect(
        loaded.request(methods.agent.session.prompt, { sessionId, prompt }),
      ).resolves.toEqual({ stopReason: "end_turn" });

      // Existing users have UUIDv4 sessions created through muse exec.
      const legacyCtx = await initialized(legacy);
      const old = await legacyCtx.request(methods.agent.session.new, { cwd, mcpServers: [] });
      expect(old.sessionId.split("-")[2][0]).toBe("4");
      await legacyCtx.request(methods.agent.session.prompt, { sessionId: old.sessionId, prompt });
      if (
        await expectLegacyLoad(
          loaded.request(methods.agent.session.load, {
            sessionId: old.sessionId,
            cwd,
            mcpServers: [],
          }),
        )
      ) {
        // Legacy echo history requires an explicit provider migration.
        await loaded.request(methods.agent.session.prompt, {
          sessionId: old.sessionId,
          prompt: [{ type: "text", text: "/models" }],
        });
        await loaded.request(methods.agent.session.setConfigOption, {
          sessionId: old.sessionId,
          configId: "model",
          value: modelChoice({ id: "fake-model", name: "fake-model", providerId: "meta" }),
        });
        await expectLegacyContinuation(
          loaded.request(methods.agent.session.prompt, { sessionId: old.sessionId, prompt }),
        );
      }
    } finally {
      await Promise.all([first.agent.dispose(), second.agent.dispose(), legacy.agent.dispose()]);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // The CLI's asynchronous skills advertisement may still be finishing
      // its cache write after the final turn has closed.
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 60_000);
});

describe.skipIf(!available)("SDK image provider input", () => {
  it.each([false, true])(
    "forwards image bytes through the real host (image-only: %s)",
    async (imageOnly) => {
      const provider = await startLoopbackProvider({
        scriptedToolCallWhen: ["never-call-tools"],
        scriptedToolCallCommand: "",
        holdMs: 20,
      });
      const cwd = join(provider.root, "workspace");
      mkdirSync(cwd);
      const client = connectTestClient({
        backend: "sdk",
        env: {
          HOME: provider.home,
          PATH: process.env.PATH,
          XDG_CONFIG_HOME: join(provider.root, "config"),
          XDG_DATA_HOME: join(provider.root, "data"),
          TBH_DISABLE_TELEMETRY: "1",
          TBH_CREDENTIAL_BACKEND: "file",
        },
      });
      try {
        const ctx = await initialized(client);
        const { sessionId } = await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] });
        await expect(
          ctx.request(methods.agent.session.prompt, {
            sessionId,
            prompt: [
              ...(imageOnly ? [] : [{ type: "text" as const, text: "describe image-marker" }]),
              { type: "image", mimeType: "image/png", data: CAT_IMAGE_BASE64 },
            ],
          }),
        ).resolves.toEqual({ stopReason: "end_turn" });
        expect(
          provider.requests().some((r) => {
            const input = JSON.stringify(r.input);
            return (
              (imageOnly || input.includes("image-marker")) && input.includes(CAT_IMAGE_BASE64)
            );
          }),
        ).toBe(true);
      } finally {
        await client.agent.dispose();
        await provider.close();
        await rm(provider.root, { recursive: true, force: true });
      }
    },
    60000,
  );
});

describe.skipIf(!available)("SDK discovered capabilities and embedded context", () => {
  it("discovers real host models and forwards unsaved embedded text to provider input", async () => {
    const provider = await startLoopbackProvider({
      scriptedToolCallWhen: ["never-tool"],
      scriptedToolCallCommand: "",
      holdMs: 10,
    });
    const cwd = join(provider.root, "workspace");
    mkdirSync(cwd);
    const client = connectTestClient({
      backend: "sdk",
      env: {
        HOME: provider.home,
        PATH: process.env.PATH,
        XDG_CONFIG_HOME: join(provider.root, "config"),
        XDG_DATA_HOME: join(provider.root, "data"),
        TBH_CREDENTIAL_BACKEND: "file",
        TBH_DISABLE_TELEMETRY: "1",
      },
    });
    const text = 'unsaved m8 buffer 日本語\nURI: "not another resource"\n';
    try {
      const ctx = await initialized(client);
      const created = await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] });
      await ctx.request(methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "/models" }],
      });
      expect(client.agent.sessions.get(created.sessionId)?.modelDiscovery).toMatchObject({
        status: "available",
        models: expect.arrayContaining([expect.objectContaining({ id: "fake-model" })]),
      });
      const update = client.updates.findLast(
        (n) => n.update.sessionUpdate === "config_option_update",
      )?.update;
      expect(
        update?.sessionUpdate === "config_option_update" &&
          update.configOptions.find((o) => o.id === "model"),
      ).toMatchObject({
        description: expect.stringContaining("catalog"),
        options: expect.arrayContaining([
          {
            value: modelChoice({ id: "fake-model", name: "fake-model", providerId: "meta" }),
            // The loopback catalog has no second `fake-model`, so the provider
            // is dropped from the display name as redundant.
            name: "fake-model",
          },
        ]),
      });
      await expect(
        ctx.request(methods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt: [
            {
              type: "resource",
              resource: { uri: "file:///unsaved-m8.ts", mimeType: "text/typescript", text },
            },
          ],
        }),
      ).resolves.toEqual({ stopReason: "end_turn" });
      const strings = (value: unknown): string[] =>
        typeof value === "string"
          ? [value]
          : value && typeof value === "object"
            ? Object.values(value).flatMap(strings)
            : [];
      const line = provider
        .requests()
        .flatMap((r) => strings(r.input))
        .flatMap((s) => s.split("\n"))
        .find((s) => s.startsWith("Embedded text resource: "));
      expect(line).toBeDefined();
      expect(JSON.parse(line!.slice("Embedded text resource: ".length)).resource).toEqual({
        uri: "file:///unsaved-m8.ts",
        mimeType: "text/typescript",
        text,
      });
    } finally {
      await client.agent.dispose();
      await provider.close();
      await rm(provider.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("accepts the public effort vocabulary through completed real-host turns", async () => {
    const { spawnMspConnection, MuseClient, readSessionDurability } =
      await import("@muse-code/sdk");
    const provider = await startLoopbackProvider({
      scriptedToolCallWhen: ["never-tool"],
      scriptedToolCallCommand: "",
      holdMs: 10,
    });
    const cwd = join(provider.root, "workspace");
    mkdirSync(cwd);
    const handshake = spawnMspConnection({
      command: museCliPath(),
      args: ["serve"],
      cwd,
      env: {
        HOME: provider.home,
        PATH: process.env.PATH!,
        XDG_CONFIG_HOME: join(provider.root, "config"),
        XDG_DATA_HOME: join(provider.root, "data"),
        TBH_CREDENTIAL_BACKEND: "file",
        TBH_DISABLE_TELEMETRY: "1",
      },
      shutdownTimeoutMs: 1000,
    });
    const timer = setTimeout(() => void handshake.close(), 50_000);
    try {
      const host = await handshake.initialize({
        clientInfo: { name: "m8_capability_test", version: "0.2.0" },
      });
      expect(host.initializeResult.serverInfo.version).toBeTruthy();
      const catalog = await host.connection.request("model/list", {});
      expect(catalog.models).toEqual(
        expect.arrayContaining([expect.objectContaining({ modelId: "fake-model" })]),
      );
      const sdk = new MuseClient(host.connection, {
        durability: readSessionDurability(host.initializeResult),
        host,
      });
      const session = await sdk.startSession({
        workspaceRoot: cwd,
        modelId: "fake-model",
        approvalMode: "onRequest",
      });
      for (const reasoningEffort of [
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        ...(["1.1.1", "1.2.1"].includes(probeSdkHost().version ?? "") ? [] : (["max"] as const)),
        "ultra",
      ] as const) {
        const turn = await session.sendUserTurn({
          input: [{ type: "text", text: `m8 effort ${reasoningEffort}` }],
          reasoningEffort,
        });
        expect(await turn.completed).toMatchObject({
          kind: "completed",
          params: { terminal: "completed" },
        });
      }
    } finally {
      clearTimeout(timer);
      await handshake.close();
      await provider.close();
      await rm(provider.root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe.skipIf(!available)("SDK retained host and steering", () => {
  it("delivers ordered corrections to the provider and reuses a host across compatible turns", async () => {
    const provider = await startLoopbackProvider({
      scriptedToolCallWhen: ["m10-action"],
      scriptedToolCallCommand: "printf m10-probe",
      holdMs: 700,
    });
    const cwd = join(provider.root, "workspace");
    mkdirSync(cwd);
    const logs: string[] = [];
    const client = connectTestClient(
      {
        backend: "sdk",
        env: {
          HOME: provider.home,
          PATH: process.env.PATH,
          XDG_CONFIG_HOME: join(provider.root, "config"),
          XDG_DATA_HOME: join(provider.root, "data"),
          TBH_CREDENTIAL_BACKEND: "file",
          TBH_DISABLE_TELEMETRY: "1",
        },
      },
      capturingLogger(logs),
    );
    client.setPermissionResponder((request) => ({
      outcome: {
        outcome: "selected",
        optionId: request.options.find((o) => o.kind === "allow_once")!.optionId,
      },
    }));
    try {
      const ctx = await initialized(client, { _meta: { "muse/steering": 1 } });
      const { sessionId } = await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] });
      const running = ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "m10-action" }],
      });
      await expect
        .poll(
          () => provider.requests().some((r) => JSON.stringify(r.input).includes("m10-action")),
          { timeout: 10000 },
        )
        .toBe(true);
      await expect
        .poll(
          () =>
            client.agent.sessions.get(sessionId)?.activeTurn &&
            "activeTurnId" in client.agent.sessions.get(sessionId)!.activeTurn!
              ? (client.agent.sessions.get(sessionId)!.activeTurn as { activeTurnId?: string })
                  .activeTurnId
              : undefined,
          { timeout: 10000 },
        )
        .toEqual(expect.any(String));
      const expectedTurnId = client.updates
        .map((n) => n.update._meta?.["muse/activeTurnId"])
        .findLast((v) => typeof v === "string");
      expect(expectedTurnId).toEqual(expect.any(String));
      const results = await Promise.all(
        ["m10-first-correction", "m10-second-correction"].map((text) =>
          ctx.request("_muse/steer", {
            sessionId,
            expectedTurnId,
            prompt: [{ type: "text", text }],
          }),
        ),
      );
      expect(results).toEqual([
        { status: "accepted", turnId: expectedTurnId },
        { status: "accepted", turnId: expectedTurnId },
      ]);
      expect(await running).toEqual({ stopReason: "end_turn" });
      const correction = provider
        .requests()
        .map((r) => JSON.stringify(r.input))
        .find(
          (input) =>
            input.includes("m10-first-correction") && input.includes("m10-second-correction"),
        );
      expect(correction).toBeDefined();
      expect(correction!.indexOf("m10-first-correction")).toBeLessThan(
        correction!.indexOf("m10-second-correction"),
      );
      await expect(
        ctx.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "m10-second-turn" }],
        }),
      ).resolves.toEqual({ stopReason: "end_turn" });
      expect(
        provider.requests().some((r) => {
          const input = JSON.stringify(r.input);
          return (
            input.includes("m10-second-turn") &&
            input.includes("m10-action") &&
            input.includes("m10-second-correction")
          );
        }),
      ).toBe(true);
      expect(logs.filter((line) => line.startsWith("muse-sdk spawn:"))).toHaveLength(1);
      await ctx.request(methods.agent.session.close, { sessionId });
      expect(client.agent.sessions.size).toBe(0);
    } finally {
      await client.agent.dispose();
      await provider.close();
      await rm(provider.root, { recursive: true, force: true });
    }
  }, 90_000);
});

it.skipIf(!available)(
  "observes public model/mode changes and reads their durable page without changing policy",
  async () => {
    const { spawnMspConnection, MuseClient, readSessionDurability } =
      await import("@muse-code/sdk");
    const { SessionStateObserver } = await import("../session-state-observer.js");
    const provider = await startLoopbackProvider({
      scriptedToolCallWhen: ["never-tool"],
      scriptedToolCallCommand: "",
      holdMs: 10,
    });
    const host = spawnMspConnection({
      command: museCliPath(),
      args: ["serve"],
      cwd: provider.root,
      env: {
        PATH: process.env.PATH,
        HOME: provider.home,
        XDG_CONFIG_HOME: join(provider.root, "config"),
        XDG_DATA_HOME: join(provider.root, "data"),
        TBH_CREDENTIAL_BACKEND: "file",
        TBH_DISABLE_TELEMETRY: "1",
      },
      shutdownTimeoutMs: 1000,
    });
    const seen: unknown[] = [];
    try {
      const initialized = await host.initialize({
        clientInfo: { name: "state_observer_probe", version: "1" },
      });
      const client = new MuseClient(initialized.connection, {
        host: initialized,
        durability: readSessionDurability(initialized.initializeResult),
      });
      const session = await client.startSession({
        workspaceRoot: provider.root,
        modelId: "initial-model",
        approvalMode: "onRequest",
      });
      const observer = new SessionStateObserver(
        session.sessionId,
        async (value) => {
          seen.push(value);
        },
        () => {},
      );
      const catalog = await initialized.connection.request("model/list", {});
      expect(catalog.models).toEqual(
        expect.arrayContaining([expect.objectContaining({ modelId: "fake-model" })]),
      );
      await initialized.connection.command("session/setModel", {
        sessionId: session.sessionId,
        model: { modelId: "fake-model", providerId: "meta" },
      });
      // This probe selects the stricter mode; the observer itself never sends setters.
      await initialized.connection.command("session/setApprovalMode", {
        sessionId: session.sessionId,
        mode: "denyUnmatched",
      });
      await expect
        .poll(async () => {
          await observer.poll(session.fold, initialized.connection);
          return seen;
        })
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              model: expect.objectContaining({ modelId: "fake-model" }),
            }),
            expect.objectContaining({
              approvalMode: expect.objectContaining({ mode: "denyUnmatched" }),
            }),
          ]),
        );
      const page = await initialized.connection.request("view/page", {
        sessionId: session.sessionId,
        direction: "forward",
        limit: 100,
      });
      expect(page.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ method: "session/modelChanged" }),
          expect.objectContaining({ method: "session/approvalModeChanged" }),
        ]),
      );
      observer.stop();
    } finally {
      await host.close();
      await provider.close();
      await rm(provider.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
  30_000,
);
