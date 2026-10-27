import { expect, it, vi } from "vitest";
import type { Connection, FoldedItem } from "@muse-code/sdk";
import { MuseSdkTranslator } from "../muse-sdk-events.js";
import {
  OUTPUT_EXTENSION,
  parseOutputRequest,
  validateOutputPage,
  readStoredOutput,
} from "../stored-output.js";
const params = parseOutputRequest({
  sessionId: "session",
  itemId: "item",
  outputRef: "ref",
  lengthBytes: 3,
});
const item = {
  itemId: "item",
  kind: "toolCall",
  tool: "bash",
  callId: "call",
  revision: 1,
  status: "completed",
  outputRef: {
    id: "ref",
    uri: "tool-output://unused",
    kind: "bash",
    availability: "available",
    byteLen: 3,
  },
} as FoldedItem;
const page = {
  content: "AP8B",
  encoding: "base64",
  byteLen: 3,
  offsetBytes: 0,
  eof: true,
  mediaType: "application/octet-stream",
};
it("rejects malformed ranges and inconsistent host bytes", () => {
  for (const bad of [
    { offsetBytes: -1 },
    { lengthBytes: 0 },
    { lengthBytes: 1048577 },
    { offsetBytes: Number.MAX_SAFE_INTEGER + 1 },
    { itemId: "" },
  ])
    expect(() => parseOutputRequest({ ...params, ...bad })).toThrow();
  expect(validateOutputPage(page, params)).toMatchObject({ ...page, sessionId: "session" });
  for (const bad of [
    { byteLen: 2 },
    { offsetBytes: 1 },
    { encoding: "raw" },
    { content: "!bad" },
    { content: "", byteLen: 0, eof: false },
  ])
    expect(() => validateOutputPage({ ...page, ...bad }, params)).toThrow();
});
it("verifies public ownership and availability before fetching, without following URIs", async () => {
  let observed = item;
  let sessionId = "session";
  const request = vi.fn(async (method: string) =>
    method === "view/page" ? { events: [{ params: { sessionId, item: observed } }] } : page,
  );
  const connection = { request } as unknown as Connection;
  expect(await readStoredOutput(connection, params)).toMatchObject(page);
  expect(request).toHaveBeenLastCalledWith("item/readOutput", params);
  for (const change of ["other-session", "missing", "wrong-ref"]) {
    request.mockClear();
    if (change === "other-session") sessionId = "other";
    else {
      sessionId = "session";
      observed = {
        ...item,
        outputRef: {
          ...item.outputRef!,
          ...(change === "missing" ? { availability: "missing" } : { id: "another" }),
        },
      };
    }
    await expect(readStoredOutput(connection, params)).rejects.toThrow();
    expect(request.mock.calls.every(([method]) => method === "view/page")).toBe(true);
  }
});
it("keeps baseline output and merges read metadata with asynchronous task identity", () => {
  const baseline = new MuseSdkTranslator("session", console).fromItem(item)[0];
  expect(baseline!.update._meta?.[OUTPUT_EXTENSION]).toBeUndefined();
  const translator = new MuseSdkTranslator("session", console);
  translator.configureWorkers("generation", new Set(["cancel"] as const), true);
  translator.configureOutput(true);
  const notification = translator.fromItem(item)[0];
  expect(notification!.update).toMatchObject({
    toolCallId: "call",
    _meta: {
      "muse/asyncTasks": { target: "generation:item" },
      "muse/output": { itemId: "item", outputRef: "ref", method: "_muse/readOutput" },
    },
  });
});
it("propagates a vanished output failure after one public read, with no retries", async () => {
  const request = vi.fn(async (method: string) => {
    if (method === "view/page") return { events: [{ params: { sessionId: "session", item } }] };
    throw new Error("outputUnavailable");
  });
  await expect(readStoredOutput({ request } as unknown as Connection, params)).rejects.toThrow(
    "outputUnavailable",
  );
  expect(request.mock.calls.map(([method]) => method)).toEqual(["view/page", "item/readOutput"]);
});
