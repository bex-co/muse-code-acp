import { RequestError, type SessionNotification } from "@agentclientprotocol/sdk";
import type { Connection, FoldedItem } from "@muse-code/sdk";
import { z } from "zod";
import { readLatestItems } from "./async-tasks.js";

export const OUTPUT_EXTENSION = "muse/output";
export const OUTPUT_METHOD = "_muse/readOutput";
export const MAX_OUTPUT_READ = 1024 * 1024;
export const supportsStoredOutput = (version: string | null | undefined) => version === "1.2.1";
const identifier = z.string().min(1).max(1024);
const request = z.object({
  sessionId: identifier,
  itemId: identifier,
  outputRef: identifier,
  offsetBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  lengthBytes: z.number().int().min(1).max(MAX_OUTPUT_READ).default(65536),
});
export type OutputRequest = z.infer<typeof request>;
export function parseOutputRequest(raw: unknown): OutputRequest {
  const parsed = request.safeParse(raw);
  if (!parsed.success)
    throw RequestError.invalidParams(
      undefined,
      "Output reads require sessionId, itemId, outputRef and bounded byte offsets/lengths",
    );
  return parsed.data;
}
const result = z.object({
  content: z.string().max((MAX_OUTPUT_READ * 4) / 3 + 4),
  encoding: z.enum(["utf8", "base64"]),
  byteLen: z.number().int().nonnegative().max(MAX_OUTPUT_READ),
  offsetBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  eof: z.boolean(),
  mediaType: z.string().min(1).max(256),
});
export type OutputPage = z.infer<typeof result> &
  Pick<OutputRequest, "sessionId" | "itemId" | "outputRef">;
export function validateOutputPage(raw: unknown, params: OutputRequest): OutputPage {
  const parsed = result.safeParse(raw);
  if (!parsed.success)
    throw RequestError.internalError(undefined, "Invalid stored output page from Muse");
  const page = parsed.data;
  const bytes = Buffer.from(page.content, page.encoding === "base64" ? "base64" : "utf8");
  if (
    page.offsetBytes !== params.offsetBytes ||
    page.byteLen > params.lengthBytes ||
    bytes.length !== page.byteLen ||
    (!page.eof && page.byteLen === 0) ||
    (page.encoding === "base64" && bytes.toString("base64") !== page.content)
  )
    throw RequestError.internalError(undefined, "Inconsistent stored output range from Muse");
  return {
    ...page,
    sessionId: params.sessionId,
    itemId: params.itemId,
    outputRef: params.outputRef,
  };
}

export function outputMetadata(sessionId: string, item: FoldedItem) {
  const ref = item.outputRef;
  if (
    !ref ||
    typeof ref.id !== "string" ||
    !ref.id ||
    ref.id.length > 1024 ||
    !Number.isSafeInteger(ref.byteLen) ||
    ref.byteLen < 0
  )
    return undefined;
  return {
    sessionId,
    itemId: item.itemId,
    outputRef: ref.id,
    byteLen: ref.byteLen,
    availability: ref.availability,
    ...(ref.mediaType ? { mediaType: ref.mediaType } : {}),
    ...(ref.availability === "available"
      ? { method: OUTPUT_METHOD, maxLengthBytes: MAX_OUTPUT_READ }
      : {}),
  };
}
export function restoredOutputUpdates(
  sessionId: string,
  items: FoldedItem[],
): SessionNotification[] {
  return items.flatMap((item) => {
    const metadata = outputMetadata(sessionId, item);
    return metadata
      ? [
          {
            sessionId,
            update: {
              sessionUpdate: "tool_call_update" as const,
              toolCallId: item.callId ?? item.itemId,
              _meta: { [OUTPUT_EXTENSION]: metadata },
            },
          },
        ]
      : [];
  });
}

/** Documented public item/readOutput (declared in SDK 1.3.0; Connection.request stays untyped). */
export async function readStoredOutput(
  connection: Connection,
  params: OutputRequest,
): Promise<OutputPage> {
  const items = await readLatestItems(connection, params.sessionId);
  const item = items.find((i) => i.itemId === params.itemId);
  const ref = item?.outputRef;
  if (!ref || ref.id !== params.outputRef)
    throw RequestError.invalidParams(
      undefined,
      "Output reference not found for this session/item in bounded public history",
    );
  if (ref.availability !== "available")
    throw RequestError.invalidRequest(
      undefined,
      `Stored output is unavailable (${String(ref.availability).slice(0, 80)})`,
    );
  if (!Number.isSafeInteger(ref.byteLen) || ref.byteLen < 0 || params.offsetBytes > ref.byteLen)
    throw RequestError.invalidParams(
      undefined,
      "Output offset is outside the observed stored bytes",
    );
  const read = connection.request.bind(connection) as unknown as (
    method: string,
    params: OutputRequest,
  ) => Promise<unknown>;
  return validateOutputPage(await read("item/readOutput", params), params);
}
