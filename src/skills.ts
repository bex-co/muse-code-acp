import { AvailableCommand } from "@agentclientprotocol/sdk";
import { Logger } from "./logger.js";
import { runMuseCapture } from "./muse-run.js";

/**
 * Muse skills surfaced as ACP slash commands. Invocation is pure prompt
 * passthrough: a prompt beginning with `/<skill-id> …` reaches `muse exec`
 * verbatim, and muse's model loads the skill via its read_skill tool
 * (verified live on muse 0.2.1 — `/plan …` produced a read_skill call).
 */
export interface MuseSkill {
  id: string;
  description: string;
  scope: string;
  activation: string;
}

export async function listMuseSkills(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
  museBinary?: string,
  logger: Logger = console,
): Promise<MuseSkill[]> {
  const stdout = await runMuseCapture(
    ["skills", "list", "--json", "--workspace", cwd],
    env,
    museBinary,
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    logger.log(`skills list produced unparseable JSON: ${err}`);
    return [];
  }
  const skills = (parsed as { skills?: unknown[] })?.skills;
  if (!Array.isArray(skills)) {
    return [];
  }
  return skills.flatMap((raw) => {
    const skill = raw as Record<string, unknown>;
    if (typeof skill.id !== "string") {
      return [];
    }
    return [
      {
        id: skill.id,
        description: typeof skill.description === "string" ? skill.description : "",
        scope: typeof skill.scope === "string" ? skill.scope : "unknown",
        activation: typeof skill.activation === "string" ? skill.activation : "off",
      },
    ];
  });
}

const DESCRIPTION_MAX = 200;

export function skillsToCommands(skills: MuseSkill[]): AvailableCommand[] {
  return skills
    .filter((skill) => skill.activation === "on")
    .map((skill) => ({
      name: skill.id,
      description: truncate(skill.description || `${skill.scope} muse skill`, DESCRIPTION_MAX),
      input: { hint: "input for the skill" },
    }));
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
