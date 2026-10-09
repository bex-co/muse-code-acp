import { methods } from "@agentclientprotocol/sdk";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execSupportsPermissionProfile } from "../muse-host.js";
import { expectLegacyContinuation, expectLegacyLoad } from "./acp-real-host-helpers.js";
import { connectTestClient, initialized, museAvailable } from "./helpers.js";
import { startLoopbackProvider } from "./loopback-provider.js";

const available = museAvailable();
if (!available && process.env.MUSE_CODE_ACP_REQUIRE_MUSE === "1")
  throw new Error("Muse required for exec profile acceptance");

describe.skipIf(!available)("exec permission profiles", () => {
  it("keeps a read-only exec session loadable through the SDK backend", async () => {
    const provider = await startLoopbackProvider({
      holdMs: 20,
      scriptedToolCallWhen: [],
      scriptedToolCallCommand: "",
      scriptedToolCallForRequest: () => undefined,
    });
    const cwd = join(provider.root, "workspace");
    mkdirSync(cwd);
    const env = {
      PATH: process.env.PATH,
      HOME: provider.home,
      XDG_CONFIG_HOME: join(provider.root, "config"),
      XDG_DATA_HOME: join(provider.root, "data"),
      TBH_CREDENTIAL_BACKEND: "file",
      TBH_DISABLE_TELEMETRY: "1",
    };
    const exec = connectTestClient({ backend: "exec", provider: "meta", env });
    const sdk = connectTestClient({ backend: "sdk", env });
    try {
      const ctx = await initialized(exec);
      const { sessionId } = await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] });
      await ctx.request(methods.agent.session.setMode, { sessionId, modeId: "readOnly" });
      await expect(
        ctx.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "exec-read-only-first" }],
        }),
      ).resolves.toEqual({ stopReason: "end_turn" });
      await exec.agent.dispose();
      const sdkCtx = await initialized(sdk);
      const load = sdkCtx.request(methods.agent.session.load, { sessionId, cwd, mcpServers: [] });
      const continuation = () =>
        sdkCtx.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "sdk-after-exec" }],
        });
      // Without built-in exec profiles the session keeps the host's default
      // profile, so the enumerated legacy expectations apply.
      if (!execSupportsPermissionProfile(env)) {
        if (await expectLegacyLoad(load)) await expectLegacyContinuation(continuation());
        return;
      }
      await load;
      await expect(continuation()).resolves.toEqual({ stopReason: "end_turn" });
      const input = JSON.stringify(
        provider.requests().findLast((r) => JSON.stringify(r.input).includes("sdk-after-exec"))
          ?.input,
      );
      expect(input).toContain("exec-read-only-first");
    } finally {
      await exec.agent.dispose();
      await sdk.agent.dispose();
      await provider.close();
      rmSync(provider.root, { recursive: true, force: true });
    }
  }, 90_000);
});
