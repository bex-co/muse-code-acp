import { randomUUID } from "node:crypto";
import { RequestError, type SessionNotification } from "@agentclientprotocol/sdk";
import { cancelWorkflow } from "./async-tasks.js";
import { isLegacyAutoReviewRefusal, LEGACY_AUTO_REVIEW_MESSAGE } from "./legacy-profile.js";
import type { MuseSdkTranslator } from "./muse-sdk-events.js";
import { foldedProgress, type ProgressFacts } from "./session-progress.js";
import {
  MuseClient,
  MspError,
  readSessionDurability,
  spawnMspConnection,
  type Session,
  type Connection,
} from "@muse-code/sdk";
import { DEFAULT_SAFETY, safetyArgs } from "./safety-settings.js";
import { realpathSync } from "node:fs";
import packageJson from "../package.json" with { type: "json" };
import type { MuseSdkOptions } from "./muse-sdk.js";
import { museCliPath } from "./muse-cli.js";
import { assertSdkHostSupport, assertSdkSafetySupport, sdkHostExitMessage } from "./muse-host.js";
import { parseGoalObservation, type GoalObservation } from "./goal-state.js";
import { SessionStateObserver, type SessionStateObservation } from "./session-state-observer.js";
import {
  hostCompatibility,
  servedFingerprint,
  type HostCompatibility,
} from "./host-compatibility.js";

type HostOptions = Pick<
  MuseSdkOptions,
  | "sessionId"
  | "cwd"
  | "model"
  | "readOnly"
  | "env"
  | "museBinary"
  | "logger"
  | "checkHost"
  | "safety"
  | "providerId"
  | "profileId"
> & {
  idleTimeoutMs?: number;
  maxTurns?: number;
  onClose?: () => void | Promise<void>;
  onCatalogConnection?: (connection: Connection) => void;
  onGoal?: (goal: GoalObservation) => void | Promise<void>;
  initialGoal?: GoalObservation;
  onProgress?: (facts: ProgressFacts) => Promise<void>;
  onTaskUpdate?: (notification: SessionNotification) => Promise<void>;
  onSessionState?: (state: SessionStateObservation) => Promise<void>;
};
type InitializedHost = Awaited<ReturnType<ReturnType<typeof spawnMspConnection>["initialize"]>>;
interface HostLease {
  host: InitializedHost;
  client: MuseClient;
  session: Session;
}

/** Hosts whose public workflow/cancel was verified against a real observed run. */
const WORKFLOW_CANCEL_HOSTS = ["1.2.1", "1.3.0"];

/** A single ACP session owns this process and its spawn-time configuration. */
export class MuseSdkHost {
  readonly generation = randomUUID();
  private retained = new Map<string, MuseSdkTranslator>();
  private taskDelivery = Promise.resolve();
  get workflowCancellationSupported() {
    const version = this.lease?.host.initializeResult.serverInfo?.version;
    return version !== undefined && WORKFLOW_CANCEL_HOSTS.includes(version);
  }
  retainProgress(turnId: string, translator: MuseSdkTranslator) {
    this.retained.set(turnId, translator);
  }
  async controlTask(target: string) {
    if (
      this.stopped ||
      !target.startsWith(`${this.generation}:`) ||
      !this.lease ||
      !this.workflowCancellationSupported
    )
      throw RequestError.invalidRequest(
        undefined,
        "Task target is stale or workflow cancellation is unavailable on this host",
      );
    const item = this.lease.session.fold.items.get(target.slice(this.generation.length + 1));
    if (
      !this.lease.session.fold.current ||
      item?.kind !== "workflow" ||
      item.status !== "inProgress" ||
      !item.workflowRunId
    )
      throw RequestError.invalidRequest(undefined, "Task is not a current running workflow");
    return cancelWorkflow(this.lease.host.connection, this.options.sessionId, item.workflowRunId);
  }
  private observeTasks() {
    if (!this.lease?.session.fold.current || this.stopped) return;
    const store = this.lease.session.fold.items;
    const updates = store.list().flatMap((item) => {
      const translator = this.retained.get(item.turnId ?? "");
      if (!translator) return [];
      return [
        ...translator.fromItem(item),
        ...store
          .accumulatedFields(item.itemId)
          .toSorted((a, b) => a.localeCompare(b, "en", { numeric: true }))
          .flatMap((field) =>
            translator.fromAccumulated(
              item.itemId,
              field,
              store.accumulated(item.itemId, field) ?? "",
            ),
          ),
      ];
    });
    this.taskDelivery = this.taskDelivery
      .then(async () => {
        for (const update of updates) if (!this.stopped) await this.options.onTaskUpdate?.(update);
      })
      .catch(() => this.options.logger.log("Background task observation delivery failed"));
  }
  private handshake?: ReturnType<typeof spawnMspConnection>;
  private initialized?: Promise<HostLease>;
  private lease?: HostLease;
  private closing?: Promise<void>;
  private stopped = false;
  private busy = false;
  private completedTurns = 0;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private finalStderr = "";
  private failActive?: (error: unknown) => void;
  private goalTimer?: ReturnType<typeof setInterval>;
  private goalDelivery?: Promise<void>;
  private lastGoal?: string;
  private lastGoalState?: unknown;
  private compatibility?: HostCompatibility;
  private compatibilityAnnounced = false;
  private readonly stateObserver?: SessionStateObserver;

  /**
   * The host/SDK comparison, once per host. Announced on the first turn of a
   * lease and not repeated for reused hosts, which would be noise.
   */
  takeCompatibilityAnnouncement(): HostCompatibility | undefined {
    if (!this.compatibility || this.compatibilityAnnounced) return undefined;
    this.compatibilityAnnounced = true;
    return this.compatibility;
  }

  get hasActiveTurn(): boolean {
    return !!this.lease?.session.fold.activeTurnId;
  }

  get catalogConnection(): Connection | undefined {
    return this.stopped ? undefined : this.lease?.host.connection;
  }

  constructor(private readonly options: HostOptions) {
    if (options.onSessionState)
      this.stateObserver = new SessionStateObserver(
        options.sessionId,
        options.onSessionState,
        (message) => options.logger.log(message),
      );
  }

  watchPolicyPersistence(approvalId: string, cursor?: string): void {
    this.stateObserver?.watchPolicy(approvalId, cursor);
  }

  async observeSessionState(): Promise<void> {
    if (this.lease) {
      await this.stateObserver?.poll(this.lease.session.fold, this.lease.host.connection);
      await this.options.onProgress?.(foldedProgress(this.lease.session.fold));
      this.observeTasks();
    }
  }
  get closed(): boolean {
    return this.stopped;
  }
  get reusable(): boolean {
    return !this.stopped && !this.busy;
  }
  get stderr(): string {
    return this.handshake?.child.stderrTail.join("\n").trim() ?? this.finalStderr;
  }

  async acquire(
    options: MuseSdkOptions,
    fail: (error: unknown) => void,
    preparing: () => void = () => {},
  ): Promise<HostLease> {
    if (!this.reusable) throw new Error("Muse SDK host is closed or already serving a turn");
    if (
      options.sessionId !== this.options.sessionId ||
      realpathSync(options.cwd) !== realpathSync(this.options.cwd) ||
      options.model !== this.options.model ||
      options.providerId !== this.options.providerId ||
      options.profileId !== this.options.profileId ||
      options.readOnly !== this.options.readOnly ||
      JSON.stringify(options.safety ?? DEFAULT_SAFETY) !==
        JSON.stringify(this.options.safety ?? DEFAULT_SAFETY)
    ) {
      throw new Error("Muse SDK host configuration is incompatible with this turn");
    }
    this.busy = true;
    this.failActive = fail;
    clearTimeout(this.idleTimer);
    const reusing = !!this.initialized;
    this.initialized ??= this.open(preparing);
    const lease = await this.initialized;
    if (this.stopped) throw new Error("Muse SDK host closed during startup");
    if (reusing) {
      preparing();
      if (
        lease.session.fold.activeTurnId ||
        lease.session.fold.pendingApprovals().length ||
        lease.session.fold.pendingUserInputs().length
      )
        throw new Error(
          "Muse SDK host has unfinished native work; wait before reconfiguring or prompting",
        );
      await this.applyPolicy(lease.host);
    }
    return lease;
  }

  async release(keepAlive: boolean): Promise<void> {
    this.busy = false;
    this.failActive = undefined;
    if (this.lease) {
      this.lease.session.onApproval(async () => {
        throw new Error("No active ACP turn accepts permissions");
      });
      this.lease.session.onApprovalError(() => {});
      this.lease.session.onGapError(() => {});
    }
    if (keepAlive) this.completedTurns++;
    const fold = this.lease?.session.fold;
    const goalState = fold?.sessionState.get("session/goalChanged");
    const goal =
      goalState === undefined
        ? this.options.initialGoal
        : parseGoalObservation(goalState === null ? null : goalState.goal);
    const safeToReuse =
      fold?.current &&
      ((!fold.activeTurnId &&
        fold.pendingApprovals().length === 0 &&
        fold.pendingUserInputs().length === 0) ||
        (!!this.options.onGoal && goal?.status === "known" && goal.goal?.status === "active") ||
        (!!this.options.onTaskUpdate &&
          fold.items
            .list()
            .some(
              (i) =>
                i.status === "inProgress" &&
                ["toolCall", "workflow", "subagent", "userShell"].includes(String(i.kind)),
            )));
    if (
      !keepAlive ||
      !safeToReuse ||
      this.stopped ||
      this.completedTurns >= (this.options.maxTurns ?? 32)
    ) {
      await this.close();
      return;
    }
    // Bound retention after foreground release even when Muse continues goal work.
    this.idleTimer = setTimeout(() => void this.close(), this.options.idleTimeoutMs ?? 60_000);
    this.idleTimer.unref();
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.stopped = true;
      clearTimeout(this.idleTimer);
      clearInterval(this.goalTimer);
      this.stateObserver?.stop();
      this.closing = Promise.resolve().then(async () => {
        try {
          if (this.lease) await this.lease.client.close().catch(() => {});
          else await this.handshake?.close().catch(() => {});
          await this.initialized?.catch(() => {});
          await this.goalDelivery;
          await this.taskDelivery;
          for (const translator of this.retained.values())
            for (const update of translator.lostWork()) await this.options.onTaskUpdate?.(update);
          this.retained.clear();
        } finally {
          this.failActive = undefined;
          this.finalStderr = this.stderr;
          this.lease = undefined;
          this.initialized = undefined;
          this.handshake = undefined;
          await this.options.onClose?.();
        }
      });
      this.failActive?.(new Error("Muse SDK host closed during the turn"));
    }
    return this.closing;
  }

  private ensureOpen() {
    if (this.stopped) throw new Error("Muse SDK host closed during startup");
  }

  private async open(preparing: () => void): Promise<HostLease> {
    const options = this.options;
    if (options.profileId != null)
      throw new Error(
        "Named model profile routing is unverified on supported Muse hosts; choose a provider model without a named profile. No turn was started",
      );
    // Only probed when the host check runs: spawning the real binary for a
    // version string is exactly what `checkHost: false` exists to avoid.
    const hostVersion =
      options.checkHost !== false
        ? assertSdkHostSupport(options.env, options.museBinary).version
        : null;
    const binary = options.museBinary ?? museCliPath(options.env);
    if (options.checkHost !== false)
      assertSdkSafetySupport(options.safety, options.env, options.museBinary);
    const args = ["serve", ...safetyArgs(options.safety, options.readOnly)];
    options.logger.log(`muse-sdk spawn: ${binary} ${args.join(" ")}`);
    const handshake = (this.handshake = spawnMspConnection({
      command: binary,
      args,
      cwd: options.cwd,
      env: options.env as Record<string, string>,
      shutdownTimeoutMs: 1000,
      onStderr: (chunk) => options.logger.log(`muse-sdk stderr: ${chunk.trimEnd()}`),
    }));
    void handshake.child.exit.then((exit) => {
      if (!this.stopped) {
        this.failActive?.(
          new Error(
            sdkHostExitMessage(handshake.child.stderrTail.join("\n")) ??
              `Muse SDK host exited (${exit.kind})`,
          ),
        );
        void this.close();
      }
    });
    const host = await handshake.initialize({
      clientInfo: { name: "muse_code_acp", version: packageJson.version },
    });
    this.ensureOpen();
    preparing();
    options.onCatalogConnection?.(host.connection);
    if (host.fingerprintWarning) options.logger.log(`muse-sdk: ${host.fingerprintWarning.message}`);
    this.compatibility = hostCompatibility({
      hostVersion,
      ...(servedFingerprint(host.initializeResult) === undefined
        ? {}
        : { served: servedFingerprint(host.initializeResult)! }),
      ...(host.fingerprintWarning ? { fingerprintWarning: host.fingerprintWarning } : {}),
    });
    const client = new MuseClient(host.connection, {
      durability: readSessionDurability(host.initializeResult),
      host,
    });
    let session: Session;
    const requestedPolicy = options.safety?.nativeApprovalPolicy ?? "onRequest";
    try {
      session = await client.resumeSession({ sessionId: options.sessionId, excludeItems: true });
    } catch (error) {
      if (isLegacyAutoReviewRefusal(error))
        throw new Error(LEGACY_AUTO_REVIEW_MESSAGE, { cause: error });
      this.ensureOpen();
      if (!(error instanceof MspError) || error.code !== -32020) throw error;
      session = await client.startSession({
        sessionId: options.sessionId,
        workspaceRoot: options.cwd,
        modelId: options.model,
        ...(options.providerId ? { providerId: options.providerId } : {}),
        approvalMode: requestedPolicy,
      });
    }
    this.ensureOpen();
    const opening = session.opening;
    const saved =
      opening?.verb === "session/resume"
        ? opening.result.session
        : opening?.verb === "session/start"
          ? opening.result.session
          : undefined;
    if (!saved || saved.sessionId !== options.sessionId)
      throw new Error("Muse SDK returned a different session ID");
    if (saved.workspaceRoot && realpathSync(saved.workspaceRoot) !== realpathSync(options.cwd))
      throw new Error("Muse SDK cannot switch a saved session to a different workspace");
    const pending =
      opening?.verb === "session/resume" ? (opening.result.pendingRequests ?? []) : [];
    if (saved.activeTurnId || pending.length)
      throw new Error(
        "The saved Muse session has an unfinished turn or pending input; resolve it in Muse before continuing",
      );
    await this.applyPolicy(host);
    this.ensureOpen();
    // Resume metadata can reflect startup settings while execution still uses
    // the previous model. An explicit public setter is required even if equal.
    {
      try {
        await host.connection.command("session/setModel", {
          sessionId: options.sessionId,
          model: {
            modelId: options.model,
            providerId: options.providerId ?? saved.providerId,
            ...(options.profileId ? { profileId: options.profileId } : {}),
          },
        });
      } catch (error) {
        if (!(error instanceof MspError)) throw error;
        throw new Error(
          "Muse rejected the requested model/provider. Choose a supported provider-qualified catalog option before retrying; no turn was started",
          { cause: error },
        );
      }
      this.ensureOpen();
      const observed = await host.connection.request("session/read", {
        sessionId: options.sessionId,
        includeTurns: false,
      });
      if (
        !observed.session ||
        typeof observed.session !== "object" ||
        !("modelId" in observed.session) ||
        observed.session.modelId !== options.model ||
        (options.providerId &&
          (!("providerId" in observed.session) ||
            observed.session.providerId !== options.providerId))
      )
        throw new Error("Muse did not confirm the requested model/provider; no turn was started");
    }
    if (this.stopped) {
      await client.close().catch(() => {});
      throw new Error("Muse SDK host closed during startup");
    }
    this.lease = { host, client, session };
    if (options.onGoal || this.stateObserver || options.onProgress || options.onTaskUpdate) {
      this.goalTimer = setInterval(() => {
        if (options.onGoal) this.observeGoal();
        void this.observeSessionState().catch(() =>
          options.logger.log("Session observation delivery failed"),
        );
      }, 100);
      this.goalTimer.unref();
      if (options.onGoal) this.observeGoal();
      await this.observeSessionState();
    }
    return this.lease;
  }

  private async applyPolicy(host: InitializedHost): Promise<void> {
    const options = this.options;
    const requestedPolicy = options.safety?.nativeApprovalPolicy ?? "onRequest";
    const policy = await host.connection.command("session/setApprovalMode", {
      sessionId: options.sessionId,
      mode: requestedPolicy,
    });
    options.logger.log(
      `muse-sdk approval policy: requested=${requestedPolicy} effective=${JSON.stringify(policy.effectiveMode)}`,
    );
    this.ensureOpen();
    const effective = policy.effectiveMode;
    if (
      effective &&
      typeof effective === "object" &&
      "mode" in effective &&
      typeof effective.mode === "string"
    )
      await options.onSessionState?.({
        approvalMode: {
          mode: effective.mode,
          ...("source" in effective && typeof effective.source === "string"
            ? { source: effective.source }
            : {}),
        },
      });
  }

  private observeGoal(): void {
    if (this.stopped || this.goalDelivery || !this.lease?.session.fold.current) return;
    const state = this.lease.session.fold.sessionState.get("session/goalChanged");
    if (state === undefined || state === this.lastGoalState) return;
    this.lastGoalState = state;
    const goal = parseGoalObservation(state === null ? null : state.goal);
    const key = JSON.stringify(goal);
    if (key === this.lastGoal) return;
    this.lastGoal = key;
    this.goalDelivery = Promise.resolve()
      .then(() => this.options.onGoal?.(goal))
      .catch(() => {
        this.options.logger.log("goal update delivery failed");
        void this.close();
      })
      .finally(() => {
        this.goalDelivery = undefined;
      });
  }
}
