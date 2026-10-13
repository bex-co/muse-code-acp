import type { AvailableCommand, PromptRequest } from "@agentclientprotocol/sdk";
import type { WorkflowCommand } from "./review-prompt.js";

export const BUILTIN_COMMANDS: AvailableCommand[] = [
  { name: "models", description: "Refresh model choices without a model request" },
  { name: "skills", description: "List available Muse skills without a model request" },
  { name: "tasks", description: "List running Muse background tasks without a model request" },
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
type Blocks = PromptRequest["prompt"];
export interface SlashCommand {
  local?: { kind: "models" | "skills" | "tasks" | "logout" | "rename"; argument: string };
  blocks: Blocks;
  index: number;
  workflow?: WorkflowCommand;
  status?: "goal" | "mcp" | "status";
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
    if (!match || !names.has(match[1].toLowerCase())) return [];
    return [{ index, name: match[1].toLowerCase(), args: match[2]?.trim() ?? "" }];
  });
  if (!matches.length) return;
  const different = new Set(matches.map((m) => m.name));
  const selected = matches.find((m) => m.name === "plan") ?? matches[0];
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
    selected.name === "skills" ||
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
      const verb = control[1].toLowerCase() as GoalVerb;
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
