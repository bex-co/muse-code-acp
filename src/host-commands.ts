import { MspError } from "@muse-code/sdk";
import type { MuseSdkHost } from "./muse-sdk-host.js";

/** A native host command: its reply text, or undefined when cancelled. */
export type HostCommand = (
  owner: MuseSdkHost,
  isCancelled: () => boolean,
) => Promise<string | undefined>;

/** Run a call and turn a Muse refusal into reply text instead of a failure. */
async function answer(
  label: string,
  run: () => Promise<string | undefined>,
): Promise<string | undefined> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof MspError)) throw error;
    const reason = (error.data as { reason?: unknown }).reason;
    return `Muse rejected ${label}: ${typeof reason === "string" ? reason : error.kind}.`;
  }
}

export const recapCommand: HostCommand = (owner, isCancelled) =>
  answer("the recap", async () => {
    const recap = await owner.requestRecap(isCancelled);
    if (recap.outcome === "cancelled") return undefined;
    return recap.outcome === "completed"
      ? `${recap.title ? `${recap.title}\n` : ""}${recap.text ?? ""}`
      : `Muse could not produce a recap (${recap.outcome}${recap.reason ? `: ${recap.reason}` : ""}).`;
  });

/** Enable or disable one skill in the scope it comes from, per `skill/list`. */
export function skillActivationCommand(verb: "enable" | "disable", selector: string): HostCommand {
  return (owner) =>
    answer(`${verb} ${selector}`, async () => {
      const listed = (await owner.call("request", "skill/list")) as {
        skills?: { selector: string; source: string }[];
      };
      const row = listed.skills?.find((skill) => skill.selector === selector);
      if (!row) return `No Muse skill named ${selector} in this session; nothing changed.`;
      const result = (await owner.call("command", "skill/setActivation", {
        selector,
        scope: row.source,
        activation: verb === "enable" ? "on" : "off",
      })) as { previous?: string; activation?: string; scope?: string };
      return `Skill ${selector} (${result.scope ?? row.source}): ${result.previous ?? "unknown"} → ${result.activation ?? "unknown"}.`;
    });
}

/** Preview a foreign-skill import, or apply it on explicit request. */
export function skillImportCommand(source: "claude" | "codex", apply: boolean): HostCommand {
  return (owner) =>
    answer(`the ${source} skill import`, async () => {
      const result = (await owner.call("command", "skill/import", {
        source,
        dryRun: !apply,
      })) as {
        installed?: string[];
        skipped?: string[];
        quarantined?: { id?: string; reason?: string }[];
        failed?: { id?: string; reason?: string }[];
      };
      const list = (label: string, values: string[] | undefined) =>
        values?.length ? [`${label}: ${values.slice(0, 50).join(", ")}`] : [];
      return [
        apply
          ? `Imported ${source} skills into Muse.`
          : `Preview of importing ${source} skills (nothing written). Send /skills import ${source} --apply to import.`,
        ...list(apply ? "Installed" : "Would install", result.installed),
        ...list("Already imported", result.skipped),
        ...list(
          "Quarantined",
          result.quarantined?.map((q) => `${q.id ?? "?"} (${q.reason ?? "no reason"})`),
        ),
        ...list(
          "Failed",
          result.failed?.map((f) => `${f.id ?? "?"} (${f.reason ?? "no reason"})`),
        ),
      ].join("\n");
    });
}

export const FEEDBACK_CLASSIFICATIONS = {
  bug: "bug",
  bad: "badResult",
  good: "goodResult",
  other: "other",
} as const;

/** Submit feedback to Muse; never attaches files, and the session record only on request. */
export function feedbackCommand(
  classification: keyof typeof FEEDBACK_CLASSIFICATIONS,
  note: string,
  withSession: boolean,
): HostCommand {
  return (owner) =>
    answer("the feedback", async () => {
      const result = (await owner.call("command", "feedback/submit", {
        classification: FEEDBACK_CLASSIFICATIONS[classification],
        note,
        withFiles: false,
        attachSessionRecord: withSession,
      })) as { outcome?: string; cause?: string; bundlePath?: string; uploadId?: string };
      return [
        `Feedback outcome: ${result.outcome ?? "unknown"}${result.cause ? ` (${result.cause})` : ""}.`,
        ...(result.uploadId ? [`Upload id: ${result.uploadId}`] : []),
        ...(result.bundlePath ? [`Local copy: ${result.bundlePath}`] : []),
        withSession
          ? "The session record was attached."
          : "No files or session record were attached.",
      ].join("\n");
    });
}

/** Installed plugins (`plugin/list`). */
export const pluginListCommand: HostCommand = (owner) =>
  answer("the plugin listing", async () => {
    const { plugins } = (await owner.call("request", "plugin/list")) as {
      plugins?: { id: string; version: string; enabled: boolean; source: string }[];
    };
    return plugins?.length
      ? plugins
          .slice(0, 200)
          .map((p) => `${p.id} ${p.version} [${p.enabled ? "enabled" : "disabled"}, ${p.source}]`)
          .join("\n")
      : "No Muse plugins are installed.";
  });

/** Install a plugin from a local folder; only on this explicit command. */
export function pluginInstallCommand(path: string): HostCommand {
  return (owner) =>
    answer(`installing the plugin at ${path}`, async () => {
      const result = (await owner.call("command", "plugin/install", {
        target: { localPath: { path } },
      })) as { id?: string; version?: string; enabled?: boolean; source?: string };
      return `Installed Muse plugin ${result.id ?? "?"} ${result.version ?? ""} from ${path} (${result.enabled ? "enabled" : "disabled"}, ${result.source ?? "unknown source"}).`;
    });
}

/** Installed hook handlers (`hook/list`). */
export const hookListCommand: HostCommand = (owner) =>
  answer("the hook listing", async () => {
    const { hooks } = (await owner.call("request", "hook/list")) as {
      hooks?: { event: string; key: string; handlerKind: string; enabled: boolean }[];
    };
    return hooks?.length
      ? hooks
          .slice(0, 200)
          .map(
            (h) => `${h.event}: ${h.key} [${h.handlerKind}, ${h.enabled ? "enabled" : "disabled"}]`,
          )
          .join("\n")
      : "No Muse hooks are installed.";
  });
