import { AvailableCommand } from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { Logger } from "./logger.js";
import { museCliPath } from "./muse-cli.js";

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
  const binary = museBinary ?? museCliPath();
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(binary, ["skills", "list", "--json", "--workspace", cwd], {
      env: env as Record<string, string>,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (out += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(out);
      } else {
        reject(new Error(`muse skills list exited ${code}`));
      }
    });
  });

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
