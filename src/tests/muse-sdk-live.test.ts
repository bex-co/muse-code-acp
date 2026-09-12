import { startLoopbackProvider } from "./loopback-provider.js";
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
import { connectTestClient, initialized, museAvailable } from "./helpers.js";

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
      await loaded.request(methods.agent.session.load, {
        sessionId: old.sessionId,
        cwd,
        mcpServers: [],
      });
      await expect(
        loaded.request(methods.agent.session.prompt, { sessionId: old.sessionId, prompt }),
      ).resolves.toEqual({ stopReason: "end_turn" });
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
  it("forwards image bytes through the real host", async () => {
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
            { type: "text", text: "describe image-marker" },
            { type: "image", mimeType: "image/png", data: CAT_IMAGE_BASE64 },
          ],
        }),
      ).resolves.toEqual({ stopReason: "end_turn" });
      expect(
        provider.requests().some((r) => {
          const input = JSON.stringify(r.input);
          return input.includes("image-marker") && input.includes(CAT_IMAGE_BASE64);
        }),
      ).toBe(true);
    } finally {
      await client.agent.dispose();
      await provider.close();
      await rm(provider.root, { recursive: true, force: true });
    }
  }, 60000);
});
