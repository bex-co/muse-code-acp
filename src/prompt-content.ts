import { decodeImage, IMAGE_EXTENSIONS } from "./prompt-images.js";
import { ContentBlock, PromptRequest, RequestError } from "@agentclientprotocol/sdk";

/** Muse turn input text part. */
export type MuseTextInputPart = { type: "text"; text: string };
export type MuseInputPart =
  MuseTextInputPart | { type: "image"; base64Data: string; mediaType: string };

/**
 * Lossless text encoding for ACP `resource_link` blocks. Muse's turn input
 * only declares `text` | `image`, so resource links travel as ordered text
 * parts that preserve name/uri/description/title/mimeType without fetching.
 */
export function formatResourceLink(
  block: Extract<ContentBlock, { type: "resource_link" }>,
): string {
  const lines = [`Resource: ${block.name}`, `URI: ${block.uri}`];
  if (block.title) {
    lines.push(`Title: ${block.title}`);
  }
  if (block.description) {
    lines.push(`Description: ${block.description}`);
  }
  if (block.mimeType) {
    lines.push(`MIME: ${block.mimeType}`);
  }
  return lines.join("\n");
}

export type PromptConversion =
  { ok: true; parts: MuseInputPart[]; text: string } | { ok: false; error: RequestError };

/**
 * Convert ACP prompt content into Muse turn input and a legacy exec string.
 * Baseline ACP requires text + resource_link; images use inline MSP parts; audio and embedded resources are rejected.
 */
export function convertPromptContent(blocks: PromptRequest["prompt"]): PromptConversion {
  if (blocks.length === 0) {
    return {
      ok: false,
      error: RequestError.invalidParams(undefined, "prompt contains no content"),
    };
  }

  const parts: MuseInputPart[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push({ type: "text", text: block.text });
        break;
      case "resource_link":
        parts.push({ type: "text", text: formatResourceLink(block) });
        break;
      case "image": {
        const mediaType = block.mimeType.trim().toLowerCase();
        if (!IMAGE_EXTENSIONS.has(mediaType))
          return {
            ok: false,
            error: RequestError.invalidParams(
              undefined,
              "supported MIME types: image/png, image/jpeg, image/gif, image/webp",
            ),
          };
        try {
          parts.push({
            type: "image",
            mediaType,
            base64Data: decodeImage(block.data).toString("base64"),
          });
        } catch (error) {
          return { ok: false, error: error as RequestError };
        }
        break;
      }
      case "audio":
      case "resource":
        return {
          ok: false,
          error: RequestError.invalidParams(
            undefined,
            `unsupported prompt content type: ${block.type}; this agent advertises text, resource_link and image; send embedded resources as resource_link blocks instead`,
          ),
        };
      default:
        return {
          ok: false,
          error: RequestError.invalidParams(
            undefined,
            `unsupported prompt content type: ${(block as { type: string }).type}`,
          ),
        };
    }
  }

  const text = parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n\n")
    .trim();
  if (text.length === 0 && !parts.some((part) => part.type === "image")) {
    return {
      ok: false,
      error: RequestError.invalidParams(
        undefined,
        "prompt contains no text or resource_link content",
      ),
    };
  }
  return { ok: true, parts, text };
}
