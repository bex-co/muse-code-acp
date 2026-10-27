import { spawnMspConnection, type Connection } from "@muse-code/sdk";
import packageJson from "../package.json" with { type: "json" };
import type { Logger } from "./logger.js";
import { museHostIdentity } from "./host-identity.js";

export interface DiscoveredModel {
  id: string;
  name: string;
  description?: string;
  providerId?: string;
  profileId?: string | null;
  isDefault?: boolean;
  /** The efforts this model accepts (`variants`), when the catalog lists them. */
  efforts?: readonly string[];
  /** The catalog's default effort for this model. */
  defaultEffort?: string;
  /** Muse's own words for some efforts (`reasoningEffortVariants`). */
  effortDescriptions?: Readonly<Record<string, string>>;
}
export type ModelDiscoveryResult =
  | { status: "available"; models: readonly DiscoveredModel[]; source: string }
  | { status: "fallback"; models: readonly []; reason: string };

export interface ModelDiscoveryOptions {
  env: Record<string, string | undefined>;
  museBinary?: string;
  logger: Logger;
  timeoutMs?: number;
  ttlMs?: number;
  maxEntries?: number;
}

const fallback = (reason: string): ModelDiscoveryResult => ({
  status: "fallback",
  models: [],
  reason,
});

function parseCatalog(value: unknown): ModelDiscoveryResult {
  if (!value || typeof value !== "object") throw new Error("malformed model/list response");
  const { models, source } = value as Record<string, unknown>;
  if (
    !Array.isArray(models) ||
    models.length > 1000 ||
    typeof source !== "string" ||
    !source.trim()
  ) {
    throw new Error("malformed model/list catalog");
  }
  const ids = new Set<string>();
  const result = models.map((row: unknown): DiscoveredModel => {
    if (!row || typeof row !== "object") throw new Error("malformed model/list row");
    const {
      modelId,
      displayLabel,
      description,
      providerId,
      profileId,
      isDefault,
      variants,
      defaultReasoningEffort,
      reasoningEffortVariants,
    } = row as Record<string, unknown>;
    // Effort metadata is optional catalog detail: malformed values are ignored,
    // never a reason to reject the model row.
    const efforts =
      Array.isArray(variants) && variants.every((v) => typeof v === "string") && variants.length
        ? Object.freeze([...(variants as string[])])
        : undefined;
    const effortDescriptions = Array.isArray(reasoningEffortVariants)
      ? Object.freeze(
          Object.fromEntries(
            reasoningEffortVariants.flatMap((v: unknown) => {
              const { tier, description: text } = (v ?? {}) as Record<string, unknown>;
              return typeof tier === "string" && typeof text === "string" && text.trim()
                ? [[tier, text.slice(0, 200)]]
                : [];
            }),
          ),
        )
      : undefined;
    if (
      typeof modelId !== "string" ||
      !modelId.trim() ||
      typeof displayLabel !== "string" ||
      !displayLabel.trim() ||
      (description != null && typeof description !== "string") ||
      (providerId != null && (typeof providerId !== "string" || !providerId.trim())) ||
      (profileId != null && typeof profileId !== "string") ||
      ids.has(JSON.stringify([providerId ?? null, profileId ?? null, modelId]))
    ) {
      throw new Error("malformed or duplicate model/list row");
    }
    ids.add(JSON.stringify([providerId ?? null, profileId ?? null, modelId]));
    return Object.freeze({
      id: modelId,
      name: displayLabel,
      ...(typeof providerId === "string" ? { providerId } : {}),
      ...(profileId !== undefined ? { profileId: profileId as string | null } : {}),
      ...(typeof isDefault === "boolean" ? { isDefault } : {}),
      ...(typeof description === "string" ? { description } : {}),
      ...(efforts ? { efforts } : {}),
      ...(typeof defaultReasoningEffort === "string"
        ? { defaultEffort: defaultReasoningEffort }
        : {}),
      ...(effortDescriptions && Object.keys(effortDescriptions).length
        ? { effortDescriptions }
        : {}),
    });
  });
  return Object.freeze({ status: "available", models: Object.freeze(result), source });
}

const pendingCatalogs = new WeakMap<Connection, Promise<ModelDiscoveryResult>>();

/** Coalesce on the owned connection; cancelling a waiter never closes that host. */
export async function readModelCatalog(
  connection: Connection,
  signal?: AbortSignal,
): Promise<ModelDiscoveryResult> {
  if (signal?.aborted) return fallback("Model discovery cancelled");
  let pending = pendingCatalogs.get(connection);
  if (!pending) {
    pending = queryModelCatalog(connection).finally(() => pendingCatalogs.delete(connection));
    pendingCatalogs.set(connection, pending);
  }
  if (!signal) return pending;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<ModelDiscoveryResult>((resolve) => {
        abort = () => resolve(fallback("Model discovery cancelled"));
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

async function queryModelCatalog(connection: Connection): Promise<ModelDiscoveryResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return parseCatalog(
      await Promise.race([
        connection.request("model/list", {}),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("catalog deadline")), 5000);
        }),
      ]),
    );
  } catch {
    return fallback("Muse model discovery unavailable or malformed");
  } finally {
    clearTimeout(timer);
  }
}

/** Per-agent bounded discovery cache. Keys contain only hashes, never credentials. */
export class MuseModelDiscovery {
  private readonly cache = new Map<string, { until: number; result: ModelDiscoveryResult }>();
  private readonly pending = new Map<string, Promise<ModelDiscoveryResult>>();
  private readonly closers = new Set<() => Promise<void>>();
  private disposed = false;
  private disposal?: Promise<void>;
  private readonly capacity: number;

  constructor(private readonly options: ModelDiscoveryOptions) {
    this.capacity = Math.max(1, Math.min(32, options.maxEntries ?? 4));
  }

  peek(cwd: string, env = this.options.env): ModelDiscoveryResult {
    try {
      const key = museHostIdentity(cwd, env, this.options.museBinary, true).identity;
      const entry = this.cache.get(key);
      if (!this.disposed && entry && entry.until > Date.now()) return entry.result;
    } catch {
      /* An unresolved context has no usable catalog. */
    }
    return fallback("Model catalog not loaded; use /models to refresh before a turn");
  }

  remember(
    cwd: string,
    env: Record<string, string | undefined>,
    result: ModelDiscoveryResult,
  ): void {
    if (this.disposed) return;
    try {
      const key = museHostIdentity(cwd, env, this.options.museBinary, true).identity;
      this.store(key, result);
    } catch {
      /* Do not reuse a catalog with an unresolved context. */
    }
  }

  async discover(
    cwd: string,
    overrideEnv?: Record<string, string | undefined>,
  ): Promise<ModelDiscoveryResult> {
    if (this.disposed) return fallback("Model discovery is disposed");
    try {
      const env = { ...(overrideEnv ?? this.options.env) };
      const {
        binary,
        cwd: workspace,
        identity: key,
      } = museHostIdentity(cwd, env, this.options.museBinary, true);
      const cached = this.cache.get(key);
      if (cached && cached.until > Date.now()) {
        this.cache.delete(key);
        this.cache.set(key, cached);
        return cached.result;
      }
      this.cache.delete(key);
      const inFlight = this.pending.get(key);
      if (inFlight) return inFlight;
      if (this.pending.size >= this.capacity)
        return fallback("Model discovery concurrency limit reached");
      const work = this.query(binary, workspace, env)
        .then((result) => {
          this.store(key, result);
          return result;
        })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, work);
      return work;
    } catch {
      return fallback("Model discovery could not resolve the Muse host or workspace");
    }
  }

  private store(key: string, result: ModelDiscoveryResult): void {
    if (this.disposed) return;
    this.cache.delete(key);
    while (this.cache.size >= this.capacity) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { until: Date.now() + (this.options.ttlMs ?? 30_000), result });
  }

  dispose(): Promise<void> {
    if (!this.disposal) {
      this.disposed = true;
      this.cache.clear();
      this.disposal = (async () => {
        await Promise.allSettled([...this.closers].map((close) => close()));
        await Promise.allSettled([...this.pending.values()]);
      })();
    }
    return this.disposal;
  }

  private async query(
    binary: string,
    cwd: string,
    env: Record<string, string | undefined>,
  ): Promise<ModelDiscoveryResult> {
    try {
      const handshake = spawnMspConnection({
        command: binary,
        args: ["serve"],
        cwd,
        env: env as Record<string, string>,
        shutdownTimeoutMs: 1000,
      });
      const close = async () => {
        await handshake.close().catch(() => {});
      };
      this.closers.add(close);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("model discovery timed out")),
            this.options.timeoutMs ?? 5000,
          );
        });
        const query = (async () => {
          const host = await handshake.initialize({
            clientInfo: { name: "muse_code_acp", version: packageJson.version },
          });
          return parseCatalog(await host.connection.request("model/list", {}));
        })();
        return await Promise.race([query, timeout]);
      } finally {
        clearTimeout(timer);
        await close();
        this.closers.delete(close);
      }
    } catch (error) {
      // Avoid exposing host errors, which may contain provider credentials.
      const reason =
        error instanceof Error && error.message === "model discovery timed out"
          ? "Muse model discovery timed out"
          : "Muse model discovery unavailable or malformed";
      this.options.logger.log(reason);
      return fallback(reason);
    }
  }
}
