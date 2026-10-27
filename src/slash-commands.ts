import type { AvailableCommand, PromptRequest } from "@agentclientprotocol/sdk";
import type { WorkflowCommand } from "./review-prompt.js";

export const BUILTIN_COMMANDS: AvailableCommand[] = [
  { name: "models", description: "Refresh model choices without a model request" },
  {
    name: "skills",
    description: "List Muse skills, enable or disable one, or import Claude/Codex skills",
    input: { hint: "[enable <skill> | disable <skill> | import claude|codex [--apply]]" },
  },
  { name: "tasks", description: "List running Muse background tasks without a model request" },
  { name: "recap", description: "Ask Muse for a short recap of this session" },
  { name: "compact", description: "Ask Muse to compact this session's context" },
  {
    name: "plugins",
    description: "List installed Muse plugins, or install one from a local folder",
    input: { hint: "[install <path>]" },
  },
  { name: "hooks", description: "List installed Muse hooks" },
  {
    name: "feedback",
    description: "Send feedback to Muse (no files; the session record only with --with-session)",
    input: { hint: "bug|bad|good|other <note> [--with-session]" },
  },
  {
    name: "logout",
    description:
      "Log out stored Muse credentials and close adapter sessions; exported keys remain configured",
  },
  {
    name: "rename",
    description: "Set a persistent adapter-owned session title",
    input: { hint: "title" },
  },
  {
    name: "status",
    description: "Inspect requested settings and observed usage/context without a model request",
  },
  {
    name: "goal",
    description:
      "Inspect or control Muse's persistent goal (set, edit, pause, resume, clear), or execute a task once",
    input: {
      hint: "[status | set <objective> | edit <objective> | pause | resume | clear | task]",
    },
  },
  {
    name: "mcp",
    description: "Inspect MCP configuration or ask a question about it",
    input: { hint: "[status | question]" },
  },
  {
    name: "plan",
    description: "Enter plan mode; optionally start a planning task",
    input: { hint: "[objective]" },
  },
  {
    name: "review",
    description: "Review working-tree changes with optional focus",
    input: { hint: "[review instructions]" },
  },
  {
    name: "review-branch",
    description: "Review changes from a branch merge base",
    input: { hint: "[ref (default: upstream)] [focus]" },
  },
  {
    name: "review-commit",
    description: "Review a commit",
    input: { hint: "[ref (default: HEAD)] [focus]" },
  },
];
const names = new Set(BUILTIN_COMMANDS.map((command) => command.name));
export type GoalVerb = "set" | "edit" | "pause" | "resume" | "clear";
export type NativeCommand =
  | { kind: "recap" }
  | { kind: "compact" }
  | { kind: "pluginList" }
  | { kind: "pluginInstall"; path: string }
  | { kind: "hookList" }
  | { kind: "skill"; verb: "enable" | "disable"; selector: string }
  | { kind: "skillImport"; source: "claude" | "codex"; apply: boolean }
  | {
      kind: "feedback";
      classification: "bug" | "bad" | "good" | "other";
      note: string;
      withSession: boolean;
    };
type Blocks = PromptRequest["prompt"];
export interface SlashCommand {
  local?: { kind: "models" | "skills" | "tasks" | "logout" | "rename"; argument: string };
  blocks: Blocks;
  index: number;
  workflow?: WorkflowCommand;
  status?: "goal" | "mcp" | "status";
  /** A native host command; the agent checks backend and host support. */
  native?: NativeCommand;
  /** A native goal control; the agent checks backend and host support. */
  goal?: { verb: GoalVerb; objective?: string };
  notice?: string;
  stop?: boolean;
  barePlan?: boolean;
}

/** Only explicit command-leading top-level text is executable; attachments are data. */
export function parseSlashCommand(prompt: Blocks): SlashCommand | undefined {
  const matches = prompt.flatMap((block, index) => {
    if (block.type !== "text") return [];
    const match = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(block.text.trim());
    const name = match?.[1]?.toLowerCase();
    if (!name || !names.has(name)) return [];
    return [{ index, name, args: match?.[2]?.trim() ?? "" }];
  });
  const [first] = matches;
  if (!first) return;
  const different = new Set(matches.map((m) => m.name));
  const selected = matches.find((m) => m.name === "plan") ?? first;
  const blocks = prompt.map((block) => ({ ...block }));
  const result: SlashCommand = { blocks, index: selected.index };
  if (different.size > 1 && selected.name !== "plan")
    return {
      ...result,
      stop: true,
      notice:
        "Several different commands were requested. Send one operation at a time; no task has been started.",
    };
  for (const match of matches)
    blocks[match.index] = {
      type: "text",
      text:
        match.index !== selected.index &&
        /^(goal|mcp)$/.test(match.name) &&
        /^status$/i.test(match.args)
          ? ""
          : match.args,
    };
  const extraText = blocks.some(
    (block, index) => index !== selected.index && block.type === "text" && block.text.trim(),
  );
  const attachments = blocks.some((block) => block.type !== "text");
  const args = selected.args;
  if (
    selected.name === "models" ||
    (selected.name === "skills" && !args) ||
    selected.name === "tasks" ||
    selected.name === "logout" ||
    selected.name === "rename"
  ) {
    if (extraText || attachments || (selected.name !== "rename" && args))
      return {
        ...result,
        stop: true,
        notice:
          "Send this local command alone; accompanying instructions and attachments were not executed.",
      };
    return { ...result, stop: true, local: { kind: selected.name, argument: args } };
  }
  const native = nativeCommand(selected.name, args);
  if (native !== undefined) {
    if (typeof native === "string" || extraText || attachments)
      return {
        ...result,
        stop: true,
        notice:
          typeof native === "string"
            ? native
            : `Send /${selected.name} alone; accompanying instructions and attachments were not executed.`,
      };
    blocks[selected.index] = { type: "text", text: "" };
    return { ...result, native };
  }
  if (selected.name === "status")
    return {
      ...result,
      status: "status",
      stop: true,
      notice:
        args || extraText || attachments
          ? "This local status query does not execute accompanying instructions or process attachments."
          : undefined,
    };
  if (selected.name === "plan") {
    result.workflow = { kind: "plan", text: args };
    result.barePlan = !args && !extraText && !attachments;
    if (different.size > 1) {
      result.barePlan = false;
      result.notice =
        "This request includes planning and other commands. This turn will only plan; it will not execute the other operations.";
      // Preserve the requested operations as planning inputs, not dispatched commands.
      for (const match of matches)
        if (match.name !== "plan")
          blocks[match.index] = {
            type: "text",
            text: `Requested operation to plan: /${match.name} ${match.args}`,
          };
    }
    return result;
  }
  if (selected.name === "goal" || selected.name === "mcp") {
    const isGoal = selected.name === "goal";
    const control = isGoal ? /^(set|edit|pause|resume|clear)(?:\s+([\s\S]*))?$/i.exec(args) : null;
    if (control) {
      const verb = control[1]!.toLowerCase() as GoalVerb;
      const objective = control[2]?.trim() ?? "";
      const needsObjective = verb === "set" || verb === "edit";
      const problem =
        extraText || attachments
          ? "Send goal controls alone; accompanying instructions and attachments were not executed."
          : needsObjective && !objective
            ? `Use /goal ${verb} <objective>. No goal was changed.`
            : !needsObjective && objective
              ? `/goal ${verb} takes no arguments. No goal was changed.`
              : undefined;
      if (problem) return { ...result, stop: true, notice: problem };
      blocks[selected.index] = { type: "text", text: "" };
      return { ...result, goal: { verb, ...(needsObjective ? { objective } : {}) } };
    }
    const status = /^status$/i.test(args) || (!args && !extraText);
    if (status) {
      blocks[selected.index] = { type: "text", text: "" };
      result.status = selected.name;
      result.stop = !extraText;
      if (attachments && result.stop)
        result.notice = "Attached context was not processed by this local status query.";
    } else if (isGoal) {
      result.notice =
        "I will execute this task once in the current mode; no persistent goal is created. Use /goal set <objective> for a persistent Muse goal.";
    } else {
      result.status = "mcp";
      result.notice =
        "I will use the available MCP diagnostics to address this request. This does not invoke a native MCP control command.";
    }
    return result;
  }
  if (selected.name === "review") {
    result.workflow = { kind: "review", target: "workingTree" };
    return result;
  }
  const ref = args.match(/^\S+/)?.[0];
  const focus = args.slice(ref?.length ?? 0).trim();
  if (ref && (ref.startsWith("-") || ref.includes("\0")))
    return {
      ...result,
      stop: true,
      notice: `Use /${selected.name} with a Git reference, followed by optional review instructions. References cannot begin with '-'.`,
    };
  const target = selected.name === "review-branch" ? "branch" : "commit";
  result.workflow = {
    kind: "review",
    target,
    ref: ref ?? (target === "branch" ? "@{upstream}" : "HEAD"),
  };
  blocks[selected.index] = { type: "text", text: focus };
  if (!ref) result.notice = `Review target: ${result.workflow.ref}.`;
  return result;
}

/** Parse native host commands: a command, a usage notice, or undefined when not one. */
function nativeCommand(name: string, args: string): NativeCommand | string | undefined {
  if (name === "recap") return args ? "Send /recap without arguments." : { kind: "recap" };
  if (name === "compact")
    return args ? "Send /compact without arguments. Nothing was sent." : { kind: "compact" };
  if (name === "hooks") return args ? "Send /hooks without arguments." : { kind: "hookList" };
  if (name === "plugins") {
    if (!args) return { kind: "pluginList" };
    const install = /^install\s+(\S[\s\S]*)$/i.exec(args);
    return install
      ? { kind: "pluginInstall", path: install[1]!.trim() }
      : "Use /plugins or /plugins install <local folder>. Nothing changed.";
  }
  if (name === "skills" && args) {
    const control = /^(enable|disable)\s+(\S+)$/i.exec(args);
    if (control)
      return {
        kind: "skill",
        verb: control[1]!.toLowerCase() as "enable" | "disable",
        selector: control[2]!,
      };
    const imported = /^import\s+(claude|codex)(\s+--apply)?$/i.exec(args);
    if (imported)
      return {
        kind: "skillImport",
        source: imported[1]!.toLowerCase() as "claude" | "codex",
        apply: !!imported[2],
      };
    return "Use /skills, /skills enable <skill>, /skills disable <skill>, or /skills import claude|codex [--apply]. Nothing changed.";
  }
  if (name === "feedback") {
    const withSession = /(^|\s)--with-session(\s|$)/.test(args);
    const match = /^(bug|bad|good|other)\s+([\s\S]+)$/i.exec(
      args.replace(/(^|\s)--with-session(?=\s|$)/, " ").trim(),
    );
    if (!match)
      return "Use /feedback bug|bad|good|other <note> [--with-session]. Nothing was sent.";
    return {
      kind: "feedback",
      classification: match[1]!.toLowerCase() as "bug" | "bad" | "good" | "other",
      note: match[2]!.trim(),
      withSession,
    };
  }
  return undefined;
}
