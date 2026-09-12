import {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationPropertySchema,
  ElicitationSchema,
} from "@agentclientprotocol/sdk";
import type { Connection } from "@muse-code/sdk";
import { TurnScopedLifecycle } from "./turn-lifecycle.js";

export interface MuseUserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string }>;
  selection: { mode: "single" | "multiple"; minSelections?: number; maxSelections?: number };
}

export interface MuseUserInputRequest {
  userInputId: string;
  turnId: string;
  itemId: string;
  toolCallId: string;
  toolName: string;
  questions: MuseUserInputQuestion[];
}

export interface MuseUserInputAnswer {
  questionId: string;
  selectedLabel?: string;
  selectedLabels?: string[];
  freeText?: string;
}

/** Tracks pending user-input IDs so late answers cannot settle a later turn. */
export class UserInputLifecycle extends TurnScopedLifecycle {}

/**
 * Build an ACP form elicitation from an MSP user-input request.
 * Multi-question prompts become a single object schema keyed by question id.
 */
export function userInputToElicitation(
  sessionId: string,
  request: MuseUserInputRequest,
): CreateElicitationRequest {
  const properties: Record<string, ElicitationPropertySchema> = {};
  const required: string[] = [];
  for (const question of request.questions) {
    required.push(question.id);
    if (question.selection.mode === "multiple") {
      properties[question.id] = {
        type: "array",
        title: question.header || question.question,
        description: question.question,
        items: { type: "string", enum: question.options.map((option) => option.label) },
        minItems: question.selection.minSelections ?? 1,
        maxItems: question.selection.maxSelections ?? question.options.length,
      };
    } else if (question.options.length > 0) {
      properties[question.id] = {
        type: "string",
        title: question.header || question.question,
        description: question.question,
        enum: question.options.map((option) => option.label),
      };
    } else {
      properties[question.id] = {
        type: "string",
        title: question.header || question.question,
        description: question.question,
        maxLength: 500,
      };
    }
  }
  const message =
    request.questions.map((q) => q.question).join("\n") ||
    `Muse requested input for ${request.toolName}`;
  const requestedSchema: ElicitationSchema = {
    type: "object",
    properties,
    required,
  };
  return {
    mode: "form",
    message,
    sessionId,
    requestedSchema,
    _meta: {
      museUserInputId: request.userInputId,
      museTurnId: request.turnId,
      museToolCallId: request.toolCallId,
      museToolName: request.toolName,
    },
  };
}

export function elicitationToAnswers(
  request: MuseUserInputRequest,
  response: CreateElicitationResponse,
): MuseUserInputAnswer[] | "cancel" {
  if (response.action === "cancel" || response.action === "decline") {
    return "cancel";
  }
  if (response.action !== "accept") {
    return "cancel";
  }
  const content = (response.content ?? {}) as Record<string, unknown>;
  const answers: MuseUserInputAnswer[] = [];
  for (const question of request.questions) {
    const value = content[question.id];
    if (question.selection.mode === "multiple") {
      if (
        !Array.isArray(value) ||
        value.length < (question.selection.minSelections ?? 1) ||
        value.length > (question.selection.maxSelections ?? question.options.length) ||
        new Set(value).size !== value.length ||
        value.some(
          (label) => typeof label !== "string" || !question.options.some((o) => o.label === label),
        )
      ) {
        throw new Error(`elicitation invalid selections for ${question.id}`);
      }
      answers.push({ questionId: question.id, selectedLabels: value });
      continue;
    }
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`elicitation missing required answer for ${question.id}`);
    }
    if (question.options.length > 0) {
      if (!question.options.some((option) => option.label === value)) {
        throw new Error(`elicitation selected unknown option for ${question.id}`);
      }
      answers.push({ questionId: question.id, selectedLabel: value });
    } else {
      if (value.length > 500) {
        throw new Error(`elicitation answer exceeds 500 characters for ${question.id}`);
      }
      answers.push({ questionId: question.id, freeText: value });
    }
  }
  return answers;
}

/** Answer or cancel a pending MSP user-input request over the public Connection API. */
export async function settleUserInput(
  connection: Connection,
  sessionId: string,
  request: MuseUserInputRequest,
  response: CreateElicitationResponse,
): Promise<void> {
  const answers = elicitationToAnswers(request, response);
  if (answers === "cancel") {
    await connection.command(
      "userInput/cancel",
      { sessionId, userInputId: request.userInputId, reason: "client declined" },
      { maxAttempts: 1 },
    );
    return;
  }
  await connection.command(
    "userInput/answer",
    { sessionId, userInputId: request.userInputId, answers },
    { maxAttempts: 1 },
  );
}
