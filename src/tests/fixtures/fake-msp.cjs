#!/usr/bin/env node
// Deterministic MSP peer. Exercises the real SDK's stdio and RPC handling.
const { createInterface } = require("node:readline");
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

if (process.argv.includes("logout")) { process.exit(0); }
if (process.argv.includes("skills")) {
  console.log(JSON.stringify({ skills: [] }));
  process.exit(0);
}
if (!process.argv.includes("serve")) {
  process.exit(2);
}
const noOnce = process.env.FAKE_MSP_MODE === "approvalNoOnce";
const mode = noOnce ? "approval" : (process.env.FAKE_MSP_MODE ?? "complete");
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
if (process.env.FAKE_MSP_PID) writeFileSync(process.env.FAKE_MSP_PID, String(process.pid));
let sessionId;
let currentModelId = "muse-spark-1.2";
let currentProviderId = "meta";
let turnId;
let cursor = 0;
const observationPages = [];
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
  ].filter(choice => !noOnce || choice.decision !== "approved");
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

// ---- Multi-stage approval scripts (w2/m1) ---------------------------------
// Shapes replay the Muse 1.2.1 wire recorded in w2/m1's "Issue cause":
// `approval/requested` carries `subject.stages[]`; a decision that satisfies one
// stage while others remain answers `terminal: false` and is followed by
// `approval/updated` whose `currentRequirementId` names the next unresolved
// stage. `terminal: true` only accompanies the last requirement.
const SCRIPTS = {
  "two-stage": { stages: ["unresolved", "known_safe", "unresolved", "known_safe"] },
  "three-stage": { stages: ["unresolved", "known_safe", "unresolved", "unresolved"] },
  "deny-at-stage-2": { stages: ["unresolved", "known_safe", "unresolved", "known_safe"] },
  "choices-refresh": { stages: ["unresolved", "unresolved"], refreshChoices: true },
  "decide-then-silence": { stages: ["unresolved", "unresolved"], silenceAfterStage: 0 },
  "stale-then-progress": { stages: ["unresolved", "unresolved"], staleOnStage: 0 },
  "userinput-settle-then-silence": { userInputSilence: true },
  "unknown-method": { unknownMethod: true },
};
const script = SCRIPTS[process.env.FAKE_MSP_SCRIPT ?? ""];

const STAGE_ARGV = [
  ["echo", "one"],
  ["ls", "."],
  ["echo", "two"],
  ["cat", "a.txt"],
];
const STAGED_COMMAND = "echo one > a.txt; ls .; echo two > b.txt; cat a.txt";

function stagedChoices(withSessionScope = false) {
  const choices = [
    { choiceId: "allow_once", label: "Allow once", decision: "approved", scope: "once" },
    { choiceId: "abort", label: "Abort", decision: "abort", scope: "once" },
  ];
  if (withSessionScope) {
    choices.splice(1, 0, {
      choiceId: "allow_session",
      label: "Allow for session",
      decision: "approvedForSession",
      scope: "session",
    });
  }
  return choices;
}

function stageList(state) {
  return state.stages.map((kind, index) => ({
    position: index + 1,
    totalStages: state.stages.length,
    requirementId: { approvalId: state.approvalId, sourceIndex: index },
    resolution: { kind: state.resolutions[index] ?? kind },
    argv: STAGE_ARGV[index] ?? ["echo", String(index)],
  }));
}

function stagedSubject(state) {
  return { kind: "shellCommand", rawCommand: STAGED_COMMAND, stages: stageList(state) };
}

function startStagedApproval() {
  const state = {
    approvalId: "apr-staged",
    itemId: "apr-staged-item",
    toolCallId: "call1",
    stages: script.stages,
    resolutions: script.stages.slice(),
    choices: stagedChoices(),
    currentIndex: script.stages.indexOf("unresolved"),
    rawArgs: JSON.stringify({ command: STAGED_COMMAND, description: "Run the compound command" }),
  };
  stagedApprovals.set(state.approvalId, state);
  notify("approval/requested", {
    turnId,
    approvalId: state.approvalId,
    itemId: state.itemId,
    toolCallId: state.toolCallId,
    toolName: "bash",
    taskId: "apr-staged-task",
    rawArgs: state.rawArgs,
    judgeEscalated: false,
    protectedWrite: false,
    currentRequirementId: { approvalId: state.approvalId, sourceIndex: state.currentIndex },
    availableChoices: state.choices,
    subject: stagedSubject(state),
    sourceRange: { start: 0, end: 0 },
  });
  if (script.refreshChoices) {
    // A refresh that keeps the requirement and widens the offered choices.
    state.choices = stagedChoices(true);
    notify("approval/updated", {
      approvalId: state.approvalId,
      change: { kind: "choicesRefreshed" },
      currentRequirementId: { approvalId: state.approvalId, sourceIndex: state.currentIndex },
      availableChoices: state.choices,
      subject: stagedSubject(state),
      sourceRange: { start: 0, end: 0 },
    });
  }
}

function finishStagedApproval(state, decision) {
  stagedApprovals.delete(state.approvalId);
  const approved = decision === "approved" || decision === "approvedForSession";
  notify("item/completed", {
    item: {
      itemId: state.itemId,
      callId: state.toolCallId,
      turnId,
      kind: "toolCall",
      tool: "bash",
      revision: 1,
      status: approved ? "completed" : "failed",
      args: state.rawArgs,
      visibleOutput: approved
        ? JSON.stringify({ command: STAGED_COMMAND, output: "ok" })
        : "tool approval cancelled",
      failureReason: approved ? undefined : "tool approval cancelled",
    },
  });
  notify("approval/resolved", {
    approvalId: state.approvalId,
    decision,
    policyResult: approved ? "allow" : "deny",
    resolvedBy: "user",
    itemId: state.itemId,
    turnId,
    stageEvidence: stageList(state),
    sourceRange: { start: 0, end: 0 },
  });
  notify("item/completed", {
    item: {
      itemId: `message-${turnId}`,
      turnId,
      kind: "agentMessage",
      revision: 2,
      status: "completed",
      text: "hello world",
    },
  });
  terminal("completed");
}

function decideStaged(id, params, state) {
  const requirement = params.requirementId;
  if (script.staleOnStage === state.currentIndex && !state.staleFired) {
    // The SS5.4 race the requirementId guard exists for: the stage this
    // decision names is satisfied concurrently, so the decision bounces and the
    // refreshed requirement arrives on the view instead.
    state.staleFired = true;
    write({
      id,
      error: {
        code: -32053,
        message: "requirement is stale",
        data: { kind: "approvalRequirementStale" },
      },
    });
    const decidedIndex = state.currentIndex;
    state.resolutions[decidedIndex] = "allow_once";
    state.currentIndex = state.stages.findIndex(
      (kind, index) => index > decidedIndex && kind === "unresolved",
    );
    notify("approval/updated", {
      approvalId: state.approvalId,
      change: {
        kind: "stageResolved",
        requirementId: { approvalId: state.approvalId, sourceIndex: decidedIndex },
        choiceId: "allow_once",
        decision: "approved",
      },
      currentRequirementId: { approvalId: state.approvalId, sourceIndex: state.currentIndex },
      availableChoices: state.choices,
      subject: stagedSubject(state),
      sourceRange: { start: 0, end: 0 },
    });
    return;
  }
  if (
    !requirement ||
    requirement.approvalId !== state.approvalId ||
    requirement.sourceIndex !== state.currentIndex
  ) {
    write({
      id,
      error: {
        code: -32053,
        message: "requirement is stale",
        data: { kind: "approvalRequirementStale" },
      },
    });
    return;
  }
  const choice = state.choices.find((c) => c.choiceId === params.choiceId);
  if (!choice) {
    write({
      id,
      error: { code: -32052, message: "invalid choice", data: { kind: "approvalChoiceInvalid" } },
    });
    return;
  }
  const approved = choice.decision === "approved" || choice.decision === "approvedForSession";
  state.resolutions[state.currentIndex] = approved ? choice.choiceId : "abort";
  const decidedIndex = state.currentIndex;
  const next = approved
    ? state.stages.findIndex((kind, index) => index > decidedIndex && kind === "unresolved")
    : -1;
  if (next === -1) {
    write({
      id,
      result: {
        status: "accepted",
        commandId: params.commandId,
        approvalId: state.approvalId,
        terminal: true,
      },
    });
    finishStagedApproval(state, approved ? choice.decision : "abort");
    return;
  }
  write({
    id,
    result: {
      status: "accepted",
      commandId: params.commandId,
      approvalId: state.approvalId,
      terminal: false,
    },
  });
  if (script.silenceAfterStage === decidedIndex) {
    // The w2/m1 watchdog case: a non-terminal decision with no follow-up frame.
    return;
  }
  state.currentIndex = next;
  notify("approval/updated", {
    approvalId: state.approvalId,
    change: {
      kind: "stageResolved",
      requirementId: { approvalId: state.approvalId, sourceIndex: decidedIndex },
      choiceId: choice.choiceId,
      decision: choice.decision,
    },
    currentRequirementId: { approvalId: state.approvalId, sourceIndex: next },
    availableChoices: state.choices,
    subject: stagedSubject(state),
    sourceRange: { start: 0, end: 0 },
  });
}

const pendingApprovals = new Map();
const stagedApprovals = new Map();
const pendingUserInputs = new Map();
let gapFillCursor = null;
let goalEmitted = false;

const rl = createInterface({ input: process.stdin });
rl.on("close", () => process.exit(0));
rl.on("line", async (line) => {
  const request = JSON.parse(line);
  if (process.env.FAKE_MSP_CAPTURE) {
    appendFileSync(process.env.FAKE_MSP_CAPTURE, JSON.stringify(request) + "\n");
  }
  const { id, method, params = {} } = request;
  const reply = (result) => write({ id, result });
  if (method === process.env.FAKE_MSP_EXIT_METHOD) process.exit(1);
  if (method === process.env.FAKE_MSP_DELAY_METHOD) await sleep(Number(process.env.FAKE_MSP_DELAY_MS ?? 1000));
  switch (method) {
    case "initialize":
      if (barrier === "handshake") {
        await sleep(60_000);
      }
      reply({ schema: { fingerprint: "fake-schema" }, sessionDurability: "durable" });
      break;
    case "initialized":
      break;
    case "model/list":
      if (mode === "model-timeout") break;
      if (process.env.FAKE_MSP_MODELS) {
        reply(JSON.parse(readFileSync(process.env.FAKE_MSP_MODELS, "utf8")));
      } else {
        write({ id, error: { code: -32601, message: "model discovery unavailable" } });
      }
      break;
    case "session/list": {
      if (mode === "list-delay") { await sleep(60_000); break; }
      const all = process.env.FAKE_MSP_SESSIONS ? JSON.parse(readFileSync(process.env.FAKE_MSP_SESSIONS,"utf8")) : [];
      const filtered = params.workspaceRoot ? all.filter(s => s.workspaceRoot === params.workspaceRoot) : all;
      const offset = Number(params.cursor ?? 0);
      reply({sessions: filtered.slice(offset,offset+params.limit), nextCursor: offset+params.limit < filtered.length ? String(offset+params.limit) : null});
      break;
    }
    case "session/read":
      if (mode === "metadata-timeout" && turnId) break;
      if (mode === "autoReviewReadRefused") {
        write({ id, error: { code: -32603,
          message: "retained session refused (class c): compose session permission profile: permission profile ':auto-review' cannot be used: the automated reviewer is unavailable on this host [/tmp/session.jsonl]; remedy: retry with a compatible host that can read the retained permission frame, or start a new session",
          data: { kind: "internal", retryable: false, reason: "resume_refused_class_c", details: { refusalClass: "c", detail: "compose session permission profile: permission profile ':auto-review' cannot be used: the automated reviewer is unavailable on this host" } },
        } });
        break;
      }
      reply({session: {sessionId: params.sessionId, workspaceRoot: process.cwd(), modelId: currentModelId, providerId: currentProviderId, activeTurnId: null}, pendingRequests: []});
      break;
    case "session/resume":
      if (mode === "autoReviewUnavailable") {
        write({ id, error: { code: -32603,
          message: "internal error: compose session permission profile: permission profile ':auto-review' cannot be used: the automated reviewer is unavailable on this host",
          data: { kind: "internal" },
        } });
        break;
      }
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
      currentModelId = params.modelId; currentProviderId = params.providerId ?? "meta";
      reply({ session: { sessionId, modelId: currentModelId, providerId: currentProviderId }, viewCursor: "" });
      break;
    case "session/setModel":
      currentModelId = params.model.modelId; currentProviderId = params.model.providerId ?? currentProviderId;
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
      if (process.env.FAKE_MSP_OBSERVE === "1") {
        notify("session/modelChanged", { modelId: "host-model", providerId: "meta", source: "policy", sourceRange: { start: 0, end: 0 } });
        notify("session/approvalModeChanged", { mode: "denyUnmatched", source: "approvalReconfigure", clientName: "probe", commandId: "change", sourceRange: { start: 0, end: 0 } });
        setTimeout(() => {
          notify("session/modelChanged", { modelId: "idle-model", source: "policy", sourceRange: { start: 0, end: 0 } });
          notify("session/modelChanged", { modelId: "idle-model", source: "policy", sourceRange: { start: 0, end: 0 } });
        }, 300);
      }
      if (process.env.FAKE_MSP_GOAL === "lifecycle" && !goalEmitted) {
        goalEmitted = true;
        const goal = { objective: "wire-goal", status: "active", percentComplete: 140, currentWork: "observed", nextWork: "clear" };
        notify("session/goalChanged", { goal });
        setTimeout(() => notify("session/goalChanged", { goal }), 200);
        setTimeout(() => notify("session/goalChanged", { goal: null }), 400);
        setTimeout(() => notify("session/goalChanged", { goal: null }), 600);
      }
      turnId = params.commandId;
      if (barrier === "ack") {
        notify("turn/started", { turnId, commandId: params.commandId, sourceRange: { start: 0, end: 0 } });
        await sleep(60_000);
      }
      const item = { itemId: `message-${turnId}`, turnId, kind: "agentMessage", revision: 1, status: "inProgress", text: "" };
      notify("turn/started", { turnId, commandId: params.commandId, sourceRange: { start: 0, end: 0 } });
      notify("item/started", { item });
      notify("item/delta", { itemId: item.itemId, delta: "hello" });
      if (mode === "exit") {
        process.exit(1);
      }
      if (script) {
        if (script.unknownMethod) {
          // SS1.5.4 additive evolution: a method this SDK does not know.
          notify("session/futureFrame", { detail: "emitted by a newer host" });
          notify("item/completed", { item: { ...item, revision: 2, status: "completed", text: "hello world" } });
          terminal("completed");
        } else if (script.userInputSilence) {
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
              selection: { mode: "single" },
            }],
          };
          pendingUserInputs.set("ui1", ui);
          notify("userInput/requested", ui);
        } else {
          startStagedApproval();
        }
      } else if (mode === "approval" || mode === "approvalSubmitFailure" || mode === "approvalAllow" || mode === "approvalDeny" || mode === "concurrentApprovals") {
        const first = approvalParams("apr1", "bash", "call1", JSON.stringify({ command: "pwd", description: "Show directory" }));
        if (process.env.FAKE_MSP_OBSERVE === "1") first.availableChoices.push({ choiceId: "allow-persistent", label: "Always allow", decision: "approved", scope: "localPersistent" });
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
      } else if (mode === "futureFailure") {
        terminal("failed", { error: { kind: "futureFailure", message: "Future failure Bearer fixture-secret", retryable: true } });
      } else if (mode === "autherr") {
        terminal("failed", { error: { kind: "authRequired", message: "not logged in", retryable: false } });
      } else if (mode === "stepLimit") {
        terminal("failed", { error: { kind: "stepLimit", message: "step limit", retryable: false } });
      } else if (mode === "malformed") {
        console.log("{not-json");
      } else if (mode !== "block" && mode !== "approval" && mode !== "approvalSubmitFailure" && mode !== "approvalAllow" && mode !== "approvalDeny" && mode !== "concurrentApprovals" && mode !== "userInput" && mode !== "gapRecoverable") {
        if (mode === "nativeGoal")
          notify("session/goalChanged", { goal: { objective: "Native work", status: "active", percentComplete: 10 } });
        notify("item/completed", { item: { ...item, revision: 2, status: "completed", text: "hello world" } });
        terminal("completed");
        if (mode === "nativeGoal")
          notify("turn/started", { turnId: "native-turn", commandId: "native-turn", sourceRange: { start: 0, end: 0 } });
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
      const staged = stagedApprovals.get(params.approvalId);
      if (staged) {
        decideStaged(id, params, staged);
        break;
      }
      if (mode === "approvalSubmitFailure") {
        write({ id, error: { code: -32051, message: "sensitive host detail", data: { kind: "approvalNotFound" } } });
        break;
      }
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
      if (choice.scope === "localPersistent") {
        const persistence = { ...held, sessionId, viewCursor: `v:${++cursor}`,
          change: { kind: "policyPersistence", status: "failed", reason: "private-path secret-policy-detail" } };
        const event = { method: "approval/updated", params: persistence };
        observationPages.push(event);
        write(event); // Deliberately after resolution: the SDK fold drops it.
      }
      if (pendingApprovals.size === 0 && mode !== "block") {
        notify("item/completed", {
          item: { itemId: `message-${turnId}`, turnId, kind: "agentMessage", revision: 2, status: "completed", text: "hello world" },
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
      if (script?.userInputSilence) {
        // Accepted, then no `userInput/settled` and no terminal: the fold keeps
        // the prompt pending forever. The watchdog is the only way out.
        break;
      }
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
        item: { itemId: `message-${turnId}`, turnId, kind: "agentMessage", revision: 2, status: "completed", text: "hello world" },
      });
      terminal("completed");
      break;
    }
    case "view/page": {
      if (process.env.FAKE_MSP_OBSERVE === "1") {
        reply({ events: observationPages, nextCursor: null });
        break;
      }
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
                  itemId: `message-${turnId}`,
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
    case "turn/steer":
      if (process.env.FAKE_MSP_STEER === "scripted" && params.input[0]?.text === "complete-without-ack") {
        terminal("completed");
      } else if (params.expectedTurnId !== turnId) {
        write({ id, error: { code: -32030, message: "wrong steering target" } });
      } else if (
        process.env.FAKE_MSP_STEER === "hang" ||
        (process.env.FAKE_MSP_STEER === "scripted" && params.input[0]?.text === "hang")
      ) {
        // Pending response is deliberately owned by the test's close/cancel.
      } else if (process.env.FAKE_MSP_STEER === "scripted" && params.input[0]?.text === "bad-status") {
        reply({ status: "future-status", commandId: params.commandId, turnId });
      } else if (process.env.FAKE_MSP_STEER === "fail") {
        write({ id, error: { code: -32030, message: "steering rejected" } });
      } else {
        if (process.env.FAKE_MSP_STEER === "delay") await sleep(100);
        reply({ status: "accepted", commandId: params.commandId, turnId: params.expectedTurnId });
        if (process.env.FAKE_MSP_STEER === "scripted") terminal("completed");
      }
      break;
    case "turn/cancel":
      reply({ status: "accepted", turnId });
      terminal("cancelled");
      break;
    default:
      write({ id, error: { code: -32601, message: `unexpected method: ${method}` } });
  }
});
