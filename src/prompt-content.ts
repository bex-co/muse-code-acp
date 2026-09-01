import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestError, type ContentBlock, type ResourceLink } from "@agentclientprotocol/sdk";

const IMAGE_EXTENSIONS = new Map([
  ["image/gif", "gif"],
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

const SUPPORTED_IMAGE_TYPES = [...IMAGE_EXTENSIONS.keys()].join(", ");

export type CompiledMusePrompt = {
  prompt: string;
  imagePaths: string[];
  cleanup(): Promise<void>;
};

function unsupportedContent(type: string, detail?: string): RequestError {
  const suffix = detail ? ` (${detail})` : "";
  return RequestError.invalidParams(
    undefined,
    `unsupported ACP prompt content: ${type}${suffix}. ` +
      "Muse Code accepts text, resource links, and PNG/JPEG/GIF/WebP images; " +
      "send embedded resources as resource_link blocks instead.",
  );
}

function decodeImage(data: string): Buffer {
  const normalized = data.replace(/\s/gu, "");
  if (!normalized || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized)) {
    throw unsupportedContent("image", "invalid base64 data");
  }
  const decoded = Buffer.from(normalized, "base64");
  const canonical = normalized.replace(/=+$/u, "");
  if (!decoded.length || decoded.toString("base64").replace(/=+$/u, "") !== canonical) {
    throw unsupportedContent("image", "invalid base64 data");
  }
  return decoded;
}

function renderResourceLink(link: ResourceLink): string {
  const fields = [
    `name=${JSON.stringify(link.name)}`,
    `uri=${JSON.stringify(link.uri)}`,
    ...(link.mimeType ? [`mimeType=${JSON.stringify(link.mimeType)}`] : []),
    ...(link.size == null ? [] : [`size=${String(link.size)}`]),
    ...(link.title ? [`title=${JSON.stringify(link.title)}`] : []),
    ...(link.description ? [`description=${JSON.stringify(link.description)}`] : []),
  ];
  return `Resource link: ${fields.join("; ")}`;
}

export async function compileMusePrompt(blocks: ContentBlock[]): Promise<CompiledMusePrompt> {
  const promptParts: string[] = [];
  const images: Array<{ bytes: Buffer; extension: string }> = [];

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        promptParts.push(block.text);
        break;
      case "resource_link":
        promptParts.push(renderResourceLink(block));
        break;
      case "image": {
        const mimeType = block.mimeType.trim().toLowerCase();
        const extension = IMAGE_EXTENSIONS.get(mimeType);
        if (!extension) {
          throw unsupportedContent("image", `supported MIME types: ${SUPPORTED_IMAGE_TYPES}`);
        }
        images.push({ bytes: decodeImage(block.data), extension });
        break;
      }
      case "audio":
        throw unsupportedContent("audio");
      case "resource":
        throw unsupportedContent("embedded resource");
      default:
        throw unsupportedContent("unknown");
    }
  }

  const prompt = promptParts.join("\n\n").trim();
  if (!prompt) {
    throw RequestError.invalidParams(
      undefined,
      images.length > 0
        ? "Muse Code requires text or a resource link alongside image content"
        : "prompt contains no text or resource link content",
    );
  }
  if (images.length === 0) {
    return { prompt, imagePaths: [], cleanup: async () => {} };
  }

  const directory = await mkdtemp(join(tmpdir(), "muse-code-acp-images-"));
  await chmod(directory, 0o700);
  try {
    const imagePaths: string[] = [];
    for (const [index, image] of images.entries()) {
      const imagePath = join(directory, `image-${String(index + 1)}.${image.extension}`);
      await writeFile(imagePath, image.bytes, { mode: 0o600 });
      imagePaths.push(imagePath);
    }
    return {
      prompt,
      imagePaths,
      cleanup: async () => await rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
