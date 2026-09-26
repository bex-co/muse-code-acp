import { spawnMspConnection } from "@muse-code/sdk";
import { museCliPath } from "./muse-cli.js";
import { isLegacyAutoReviewRefusal, legacyAutoReviewReadError } from "./legacy-profile.js";
import { SdkOperation, SdkCancelled, sdkDeadline } from "./sdk-operation.js";
import type { Logger } from "./logger.js";
import packageJson from "../package.json" with { type: "json" };

type Host = Awaited<ReturnType<ReturnType<typeof spawnMspConnection>["initialize"]>>;
/** Control/read hosts get a bounded request budget after host readiness; callbacks mark mutations explicitly. */
export async function withSdkControlHost<T>(
  options: {
    env: Record<string, string | undefined>;
    museBinary?: string;
    cwd: string;
    logger: Logger;
    signal?: AbortSignal;
  },
  read: (host: Host, operation: SdkOperation) => Promise<T>,
): Promise<T> {
  const startupMs = sdkDeadline(options.env, "STARTUP");
  if (options.signal?.aborted) throw new SdkCancelled("Muse SDK read cancelled");
  const handshake = spawnMspConnection({
    command: options.museBinary ?? museCliPath(options.env),
    args: ["serve"],
    cwd: options.cwd,
    env: options.env as Record<string, string>,
    shutdownTimeoutMs: 1000,
    onStderr: (chunk) => options.logger.log(`muse-sdk read: ${chunk.trimEnd()}`),
  });
  let closing: Promise<unknown> | undefined;
  const close = () => (closing ??= handshake.close().catch(() => {}));
  const operation = new SdkOperation(
    () => {
      void close();
    },
    (text) => options.logger.log(text),
  );
  const abort = () => operation.fail(new SdkCancelled("Muse SDK read cancelled"));
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    operation.enter("initializing", startupMs);
    const host = await operation.wait(
      handshake.initialize({ clientInfo: { name: "muse_code_acp", version: packageJson.version } }),
    );
    operation.enter("reading", 20_000);
    return await operation.wait(
      read(host, operation).catch((error: unknown) => {
        throw isLegacyAutoReviewRefusal(error) ? legacyAutoReviewReadError() : error;
      }),
    );
  } catch (error) {
    throw operation.error(error, options.env);
  } finally {
    operation.dispose();
    options.signal?.removeEventListener("abort", abort);
    await close();
  }
}
