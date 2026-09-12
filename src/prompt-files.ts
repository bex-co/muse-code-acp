import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestError, type ContentBlock } from "@agentclientprotocol/sdk";
import { convertPromptContent } from "./prompt-content.js";
import { IMAGE_EXTENSIONS } from "./prompt-images.js";
export type CompiledMusePrompt = {
  prompt: string;
  imagePaths: string[];
  cleanup(): Promise<void>;
};

export async function compileMusePrompt(blocks: ContentBlock[]): Promise<CompiledMusePrompt> {
  const converted = convertPromptContent(blocks);
  if (!converted.ok) throw converted.error;
  const images = converted.parts.flatMap((part) =>
    part.type === "image"
      ? [
          {
            bytes: Buffer.from(part.base64Data, "base64"),
            extension: IMAGE_EXTENSIONS.get(part.mediaType)!,
          },
        ]
      : [],
  );
  const prompt = converted.text;
  if (!prompt)
    throw RequestError.invalidParams(
      undefined,
      "Muse Code requires text or a resource link alongside image content",
    );
  if (images.length === 0) {
    return { prompt, imagePaths: [], cleanup: async () => {} };
  }

  const directory = await mkdtemp(join(tmpdir(), "muse-code-acp-images-"));
  try {
    await chmod(directory, 0o700);
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
