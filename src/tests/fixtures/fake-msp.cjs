#!/usr/bin/env node
// Deterministic MSP peer. Exercises the real SDK's stdio and RPC handling.
const { createInterface } = require("node:readline");
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

if (process.argv.includes("skills")) {
  console.log(JSON.stringify({ skills: [] }));
  process.exit(0);
}
if (!process.argv.includes("serve")) {
  process.exit(2);
}
const mode = process.env.FAKE_MSP_MODE ?? "complete";
if (process.env.FAKE_MSP_SETTINGS_CAPTURE) {
  const configHome = process.env.XDG_CONFIG_HOME;
  writeFileSync(process.env.FAKE_MSP_SETTINGS_CAPTURE, JSON.stringify({
    configHome, args: process.argv.slice(2),
    settings: JSON.parse(readFileSync(join(configHome, "muse", "settings.json"), "utf8")),
  }));
}
if (mode === "disabled") {
  process.stderr.write("the experimental SDK tier is disabled\n");
  process.exit(5);
}
let sessionId;
let turnId;
let cursor = 0;
const barrier = process.env.FAKE_MSP_BARRIER;
const write = (message) => console.log(JSON.stringify({ jsonrpc: "2.0", ...message }));
const notify = (method, params) =>
  write({ method, params: { sessionId, viewCursor: `v:${++cursor}`, ...params } });
const terminal = (terminal, extra = {}) => notify("turn/completed", { turnId, terminal, ...extra });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function defaultChoices() {
  return [
    { choiceId: "allow-once", label: "Allow once", decision: "approved", scope: "once" },
    { choiceId: "deny-once", label: "Deny once", decision: "denied", scope: "once" },
  ];
}

function approvalParams(id, toolName, toolCallId, rawArgs) {
  return {
    turnId,
    approvalId: id,
    itemId: `${id}-item`,
    toolCallId,
    toolName,
    taskId: `${id}-task`,
    rawArgs,
    judgeEscalated: false,
    protectedWrite: toolName === "write_file",
    currentRequirementId: { approvalId: id, sourceIndex: 0 },
    availableChoices: defaultChoices(),
    subject: { kind: "toolCall", toolName },
    sourceRange: { start: 0, end: 0 },
  };
}

const pendingApprovals = new Map();
const pendingUserInputs = new Map();
let gapFillCursor = null;

const rl = createInterface({ input: process.stdin });
rl.on("close", () => process.exit(0));
rl.on("line", async (line) => {
  const request = JSON.parse(line);
  if (process.env.FAKE_MSP_CAPTURE) {
    appendFileSync(process.env.FAKE_MSP_CAPTURE, JSON.stringify(request) + "\n");
  }
  const { id, method, params = {} } = request;
  const reply = (result) => write({ id, result });
  switch (method) {
    case "initialize":
      if (barrier === "handshake") {
        await sleep(60_000);
      }
      reply({ schema: { fingerprint: "fake-schema" }, sessionDurability: "durable" });
      break;
    case "initialized":
      break;
    case "session/resume":
      if (mode === "busy" || mode === "wrongWorkspace") {
        reply({ session: {
          sessionId: params.sessionId, modelId: "muse-spark-1.2",
          ...(mode === "busy" ? { activeTurnId: "earlier-turn" } : { workspaceRoot: require("node:path").dirname(process.cwd()) }),
        } });
        break;
      }
      write({
        id,
        error: {
          code: mode === "inUse" ? -32021 : -32020,
          message: mode === "inUse" ? "session is in use" : "session not found",
          data: { kind: mode === "inUse" ? "sessionInUse" : "sessionNotFound" },
        },
      });
      break;
    case "session/start":
      if (barrier === "session") {
        await sleep(60_000);
      }
      sessionId = params.sessionId;
      reply({ session: { sessionId, modelId: params.modelId }, viewCursor: "" });
      break;
    case "session/setModel":
      reply({ status: "accepted", commandId: params.commandId });
      break;
    case "session/setApprovalMode":
      reply({
        status: "accepted",
        commandId: params.commandId,
        applyOutcome: "completed",
        effectiveMode: { mode: params.mode ?? "onRequest", source: "approvalReconfigure" },
      });
      break;
    case "turn/start": {
      turnId = params.commandId;
      if (barrier === "ack") {
        await sleep(60_000);
      }
      const item = { itemId: "message", turnId, kind: "agentMessage", revision: 1, status: "inProgress", text: "" };
      notify("turn/started", { turnId, commandId: params.commandId, sourceRange: { start: 0, end: 0 } });
      notify("item/started", { item });
      notify("item/delta", { itemId: item.itemId, delta: "hello" });
      if (mode === "exit") {
        process.exit(1);
      }
      if (mode === "approval" || mode === "approvalAllow" || mode === "approvalDeny" || mode === "concurrentApprovals") {
        const first = approvalParams("apr1", "bash", "call1", JSON.stringify({ command: "pwd", description: "Show directory" }));
        pendingApprovals.set("apr1", first);
        notify("approval/requested", first);
        if (mode === "concurrentApprovals") {
          const second = approvalParams("apr2", "bash", "call2", JSON.stringify({ command: "ls", description: "List files" }));
          pendingApprovals.set("apr2", second);
          notify("approval/requested", second);
        }
      } else if (mode === "userInput" || mode === "userInputMultiple") {
        const ui = {
          turnId,
          userInputId: "ui1",
          itemId: "ui-item",
          toolCallId: "ui-call",
          toolName: "ask_user",
          questions: [{
            id: "q1",
            header: "Choice",
            question: "Pick a color",
            options: [{ label: "red" }, { label: "blue" }],
            selection: mode === "userInputMultiple" ? { mode: "multiple", minSelections: 2, maxSelections: 2 } : { mode: "single" },
          }],
        };
        pendingUserInputs.set("ui1", ui);
        notify("userInput/requested", ui);
      } else if (mode === "gapRecoverable") {
        gapFillCursor = "v:gap-next";
        notify("view/gap", { after: "v:gap-after", next: gapFillCursor });
        // Live overlapping event that should be discarded after fill.
        notify("item/delta", { itemId: item.itemId, delta: " ignored-overlap" });
      } else if (mode === "gapFail") {
        notify("view/gap", { after: "v:bad-after", next: "v:bad-next" });
      } else if (mode === "gap") {
        notify("view/gap", { after: "v:1", next: "v:99" });
      } else if (mode === "autherr") {
        terminal("failed", { error: { kind: "authRequired", message: "not logged in", retryable: false } });
      } else if (mode === "stepLimit") {
        terminal("failed", { error: { kind: "stepLimit", message: "step limit", retryable: false } });
      } else if (mode === "malformed") {
        console.log("{not-json");
      } else if (mode !== "block" && mode !== "approval" && mode !== "approvalAllow" && mode !== "approvalDeny" && mode !== "concurrentApprovals" && mode !== "userInput" && mode !== "gapRecoverable") {
        notify("item/completed", { item: { ...item, revision: 2, status: "completed", text: "hello world" } });
        terminal("completed");
      }
      // Deliberately acknowledge AFTER the notifications, in the same read.
      reply({
        status: "accepted",
        turnId,
        commandId: params.commandId,
        disposition: "started",
        startedNewTurn: true,
      });
      break;
    }
    case "approval/decide": {
      const held = pendingApprovals.get(params.approvalId);
      if (!held) {
        write({ id, error: { code: -32051, message: "approval not found", data: { kind: "approvalNotFound" } } });
        break;
      }
      const choice = held.availableChoices.find((c) => c.choiceId === params.choiceId);
      if (!choice) {
        write({ id, error: { code: -32052, message: "invalid choice", data: { kind: "approvalChoiceInvalid" } } });
        break;
      }
      pendingApprovals.delete(params.approvalId);
      reply({ status: "accepted", commandId: params.commandId, approvalId: params.approvalId, terminal: true });
      const toolItem = {
        itemId: held.itemId,
        callId: held.toolCallId,
        turnId,
        kind: "toolCall",
        tool: held.toolName,
        revision: 1,
        status: choice.decision === "approved" ? "completed" : "failed",
        args: held.rawArgs,
        visibleOutput: choice.decision === "approved"
          ? JSON.stringify({ command: JSON.parse(held.rawArgs).command, output: "ok" })
          : "denied by user",
        failureReason: choice.decision === "approved" ? undefined : "denied by user",
      };
      notify("item/completed", { item: toolItem });
      notify("approval/resolved", {
        approvalId: params.approvalId,
        decision: choice.decision,
        policyResult: choice.decision === "approved" ? "allow" : "deny",
        resolvedBy: "user",
        itemId: held.itemId,
        turnId,
        stageEvidence: [],
        sourceRange: { start: 0, end: 0 },
      });
      if (pendingApprovals.size === 0 && mode !== "block") {
        notify("item/completed", {
          item: { itemId: "message", turnId, kind: "agentMessage", revision: 2, status: "completed", text: "hello world" },
        });
        terminal("completed");
      }
      break;
    }
    case "userInput/answer":
    case "userInput/cancel": {
      const held = pendingUserInputs.get(params.userInputId);
      if (!held) {
        write({ id, error: { code: -32056, message: "user input not found", data: { kind: "userInputNotFound" } } });
        break;
      }
      pendingUserInputs.delete(params.userInputId);
      reply({ status: "accepted", commandId: params.commandId, userInputId: params.userInputId });
      notify("userInput/settled", {
        userInputId: params.userInputId,
        outcome: method === "userInput/cancel" ? "cancelled" : "answered",
        answers: params.answers ?? [],
        clarification: null,
        decidedByCommandId: params.commandId,
        reason: params.reason ?? null,
        sourceRange: { start: 0, end: 0 },
      });
      notify("item/completed", {
        item: { itemId: "message", turnId, kind: "agentMessage", revision: 2, status: "completed", text: "hello world" },
      });
      terminal("completed");
      break;
    }
    case "view/page": {
      if (mode === "gapFail") {
        write({ id, error: { code: -32603, message: "page failed", data: { kind: "internal" } } });
        break;
      }
      if (mode === "gapRecoverable" && params.cursor === "v:gap-after") {
        // Durable page events need unique viewCursors; the walk skips later
        // frames that reuse a cursor already claimed as the gap target.
        reply({
          events: [
            {
              method: "item/completed",
              params: {
                sessionId,
                viewCursor: "v:filled",
                sourceRange: { start: 0, end: 1 },
                item: {
                  itemId: "message",
                  turnId,
                  kind: "agentMessage",
                  revision: 2,
                  status: "completed",
                  text: "hello world",
                },
              },
            },
            {
              method: "turn/completed",
              params: {
                sessionId,
                turnId,
                terminal: "completed",
                viewCursor: gapFillCursor,
                sourceRange: { start: 0, end: 1 },
              },
            },
          ],
          // Must be a string distinct from the request cursor or the SDK
          // reports pageStalled even when the target event is present.
          nextCursor: "v:page-done",
        });
        break;
      }
      if (mode === "gap" || mode === "gapFail") {
        write({ id, error: { code: -32603, message: "page failed", data: { kind: "internal" } } });
        break;
      }
      reply({ events: [], nextCursor: null });
      break;
    }
    case "turn/cancel":
      reply({ status: "accepted", turnId });
      terminal("cancelled");
      break;
    default:
      write({ id, error: { code: -32601, message: `unexpected method: ${method}` } });
  }
});
