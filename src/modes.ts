import { SessionModeState } from "@agentclientprotocol/sdk";

/**
 * ACP session modes mapped honestly onto muse's headless safety levers.
 *
 * Muse 0.2.1 headless has NO interactive approval channel — approvals resolve
 * inside muse via its policy engine + LLM judge. So there is no mode that
 * routes individual tool calls through ACP `session/request_permission`; the
 * modes only choose which muse safety flags each `muse exec` spawn gets, and a
 * mode change applies from the NEXT prompt (spawn-time flags).
 */
export type MuseModeId = "default" | "readOnly" | "bypassApprovals" | "yolo";

export interface ModeDef {
  id: MuseModeId;
  name: string;
  description: string;
  /** Flags appended to every `muse exec` spawn while this mode is active. */
  flags: string[];
  /** Gated behind MUSE_CODE_ACP_ALLOW_YOLO=1; never available as root. */
  dangerous?: boolean;
}

export const MODES: Record<MuseModeId, ModeDef> = {
  default: {
    id: "default",
    name: "Policy + judge (report-only)",
    description:
      "Muse's approval policy and LLM judge decide tool calls autonomously inside its " +
      "sandbox; decisions are reported, not asked. Applies from the next prompt.",
    flags: [],
  },
  readOnly: {
    id: "readOnly",
    name: "Read-only",
    description:
      "Disable workspace file writes and shell execution for the run. Applies from the next prompt.",
    flags: ["--disable-write", "--disable-shell"],
  },
  bypassApprovals: {
    id: "bypassApprovals",
    name: "Bypass approvals",
    description:
      "Skip muse's approval prompts; the OS sandbox stays on. Applies from the next prompt.",
    flags: ["--disable-approval"],
    dangerous: true,
  },
  yolo: {
    id: "yolo",
    name: "Yolo (no approval, no sandbox)",
    description:
      "Disable approval AND the OS sandbox and trust this workspace — muse's own --yolo. " +
      "Only for already-isolated environments. Applies from the next prompt.",
    flags: ["--yolo"],
    dangerous: true,
  },
};

export interface ModeGuardContext {
  env: Record<string, string | undefined>;
  /** True when running as uid 0 — dangerous modes are refused outright. */
  isRoot: boolean;
}

export function guardContext(): ModeGuardContext {
  return {
    env: process.env,
    isRoot: typeof process.getuid === "function" && process.getuid() === 0,
  };
}

/** Modes offered to the client under the given guard context. */
export function availableModes(guard: ModeGuardContext): ModeDef[] {
  return Object.values(MODES).filter((mode) => {
    if (!mode.dangerous) {
      return true;
    }
    if (guard.isRoot) {
      return false;
    }
    if (mode.id === "yolo") {
      return guard.env.MUSE_CODE_ACP_ALLOW_YOLO === "1";
    }
    return true;
  });
}

export function isModeAvailable(id: string, guard: ModeGuardContext): id is MuseModeId {
  return availableModes(guard).some((mode) => mode.id === id);
}

export function modeState(current: MuseModeId, guard: ModeGuardContext): SessionModeState {
  return {
    currentModeId: current,
    availableModes: availableModes(guard).map((mode) => ({
      id: mode.id,
      name: mode.name,
      description: mode.description,
    })),
  };
}
