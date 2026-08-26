import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listMuseSkills, skillsToCommands } from "../skills.js";
import { fakeMuseBinary, museAvailable, newTestSession, connectTestClient } from "./helpers.js";
import { silentLogger } from "./helpers.js";
import { sleep } from "../utils.js";

describe("skillsToCommands", () => {
  it("keeps only active skills and truncates long descriptions", () => {
    const commands = skillsToCommands([
      { id: "plan", description: "p".repeat(300), scope: "built-in", activation: "on" },
      { id: "off-skill", description: "x", scope: "user", activation: "off" },
    ]);
    expect(commands).toHaveLength(1);
    expect(commands[0].name).toBe("plan");
    expect(commands[0].description.length).toBeLessThanOrEqual(200);
  });
});

describe("listMuseSkills (fake binary)", () => {
  it("parses the skills document", async () => {
    const skills = await listMuseSkills(
      mkdtempSync(join(tmpdir(), "muse-skills-test-")),
      process.env,
      fakeMuseBinary(),
      silentLogger(),
    );
    expect(skills.map((s) => s.id)).toEqual(["plan", "dormant"]);
  });
});

describe.skipIf(!museAvailable())("listMuseSkills (real muse)", () => {
  it("lists built-in skills for a fresh workspace", async () => {
    const skills = await listMuseSkills(
      mkdtempSync(join(tmpdir(), "muse-skills-test-")),
      process.env,
      undefined,
      silentLogger(),
    );
    expect(skills.length).toBeGreaterThan(0);
    // The JSON document says "bundled" where the text view says "built-in".
    expect(skills.some((s) => s.scope === "bundled")).toBe(true);
  }, 30_000);
});

describe("commands advertisement over ACP", () => {
  it("sends available_commands_update with active skills after session/new", async () => {
    const testClient = connectTestClient({ museBinary: fakeMuseBinary() });
    await newTestSession(testClient);

    const deadline = Date.now() + 5000;
    let commands: unknown;
    while (Date.now() < deadline) {
      const update = testClient.updates
        .map((u) => u.update)
        .find((u) => u.sessionUpdate === "available_commands_update");
      if (update && update.sessionUpdate === "available_commands_update") {
        commands = update.availableCommands;
        break;
      }
      await sleep(10);
    }

    expect(commands).toEqual([
      {
        name: "plan",
        description: "ground a plan in files",
        input: { hint: "input for the skill" },
      },
    ]);
  }, 10_000);
});
