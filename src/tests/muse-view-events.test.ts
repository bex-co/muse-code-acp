/**
 * Coverage for the two observability guardrails from w2/m1 t004: the view-event
 * classification tables, and the host compatibility metadata clients receive.
 */
import { methods } from "@agentclientprotocol/sdk";
import { EXPECTED_SCHEMA_FINGERPRINT } from "@muse-code/sdk";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HANDLED_VIEW_EVENTS,
  ITEM_KIND_CONSUMERS,
  IGNORED_VIEW_EVENTS,
  classifiedViewEvents,
  unclassifiedViewEvents,
} from "../muse-view-events.js";
import { hostCompatibility, servedFingerprint } from "../host-compatibility.js";
import { SDK_PACKAGE } from "../muse-host.js";
import { connectTestClient, fixturesDir, newTestSession, ensureExecutable } from "./helpers.js";

/** The method set the INSTALLED SDK can fold, read from its shipped types. */
function foldedViewEvents(): string[] {
  const require = createRequire(import.meta.url);
  const declaration = require.resolve("@muse-code/sdk/dist/src/fold/session-fold.d.ts");
  const source = readFileSync(declaration, "utf8");
  const start = source.indexOf("export type ViewEvent =");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\nexport ", start + 1);
  const region = source.slice(start, end === -1 ? undefined : end);
  return [...region.matchAll(/readonly method: "([^"]+)"/g)].map((match) => match[1]!);
}

describe("view event classification", () => {
  it("classifies every method the installed SDK folds", () => {
    const folded = foldedViewEvents();
    expect(folded.length).toBeGreaterThan(0);
    // A new SDK method must be given a consumer or a recorded reason; this is
    // the check that makes "nobody reads this frame" impossible to miss again.
    expect(unclassifiedViewEvents(folded)).toEqual([]);
  });

  it("classifies each method exactly once and claims nothing the SDK cannot fold", () => {
    const classified = classifiedViewEvents();
    expect(new Set(classified).size).toBe(classified.length);
    expect(Object.keys(HANDLED_VIEW_EVENTS).filter((m) => m in IGNORED_VIEW_EVENTS)).toEqual([]);
    const folded = new Set(foldedViewEvents());
    expect(classified.filter((method) => !folded.has(method))).toEqual([]);
  });

  it("classifies every named public item family without stale implementation owners", () => {
    const require = createRequire(import.meta.url);
    const source = readFileSync(require.resolve("@muse-code/sdk/dist/src/msp.d.ts"), "utf8");
    const declaration = source.match(/export type ItemKind = ([^;]+);/)![1];
    const kinds = [...declaration!.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(Object.keys(ITEM_KIND_CONSUMERS).sort()).toEqual(kinds.sort());
    for (const reason of [
      ...Object.values(ITEM_KIND_CONSUMERS),
      ...Object.values(IGNORED_VIEW_EVENTS),
    ])
      expect(reason).not.toMatch(/w1\/m(?:9|11|14|15|17|20|21|23)\b/);
  });

  it("routes both approval frames, which is the w2/m1 regression guard", () => {
    expect(HANDLED_VIEW_EVENTS["approval/requested"]).toContain("reconcileApprovals");
    expect(HANDLED_VIEW_EVENTS["approval/updated"]).toContain("reconcileApprovals");
  });

  it("gives every ignored method a reason naming its owner", () => {
    for (const [method, reason] of Object.entries(IGNORED_VIEW_EVENTS)) {
      expect(reason, method).toMatch(/w2\/m\d+|w1\/\d{3}|not scheduled|contract/);
    }
  });
});

describe("host compatibility metadata", () => {
  it("reports agreement when the host serves the pinned schema", () => {
    expect(hostCompatibility({ hostVersion: "1.1.1" })).toMatchObject({
      sdk: SDK_PACKAGE,
      hostVersion: "1.1.1",
      matches: true,
      pinnedFingerprint: EXPECTED_SCHEMA_FINGERPRINT,
      servedFingerprint: EXPECTED_SCHEMA_FINGERPRINT,
    });
  });

  it("reports both fingerprints on divergence without treating it as fatal", () => {
    const compatibility = hostCompatibility({
      hostVersion: "1.2.1",
      fingerprintWarning: {
        kind: "schemaFingerprintMismatch",
        pinned: "sha256:pinned",
        served: "sha256:served",
        message: "schema advanced",
      },
    });
    expect(compatibility).toMatchObject({
      hostVersion: "1.2.1",
      matches: false,
      pinnedFingerprint: "sha256:pinned",
      servedFingerprint: "sha256:served",
    });
    expect(compatibility.verifiedHosts).toContain("1.2.1");
  });

  it("keeps an unknown host version explicit rather than guessing", () => {
    expect(hostCompatibility({}).hostVersion).toBeNull();
    expect(servedFingerprint({ schema: { fingerprint: "sha256:x" } })).toBe("sha256:x");
    expect(servedFingerprint({})).toBeUndefined();
    expect(servedFingerprint(undefined)).toBeUndefined();
  });

  it("announces once per host over ACP", async () => {
    const binary = join(fixturesDir, "fake-msp.cjs");
    ensureExecutable(binary);
    const client = connectTestClient({
      backend: "sdk",
      museBinary: binary,
      skipSdkHostCheck: true,
      env: { ...process.env, FAKE_MSP_MODE: "complete" },
    });
    const { ctx, sessionId } = await newTestSession(client);
    await ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });
    const announcements = client.updates.flatMap((n) =>
      n.update.sessionUpdate === "session_info_update" && n.update._meta?.["muse/hostCompatibility"]
        ? [n.update._meta["muse/hostCompatibility"]]
        : [],
    );
    expect(announcements).toHaveLength(1);
    expect(announcements[0]).toMatchObject({
      sdk: SDK_PACKAGE,
      // The probe is skipped for the fixture host, so the version stays unknown
      // rather than being invented.
      hostVersion: null,
      matches: false,
      servedFingerprint: "fake-schema",
    });
  });
});
