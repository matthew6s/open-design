import { createHash, randomBytes, randomUUID } from "node:crypto";

import type * as Standalone from "@open-design/standalone";

import { FileFixtureLifecyclePort } from "../../../../shells/terminal/runtime/fixture-lifecycle.mjs";
import { FixtureShellUpdaterPort } from "../../../../shells/terminal/runtime/fixture-shell-updater.mjs";

type StandaloneRuntime = typeof Standalone;
type JsonObject = Record<string, any>;
type FixtureTransition = Omit<Standalone.StandaloneLifecycleTransition, "completeStart"> & {
  completeStart(
    generation: Standalone.GenerationRecord,
    attachment: Standalone.LifecycleAttachment,
    capabilityHash?: string,
  ): Promise<Standalone.LifecycleStatus>;
};

const capabilityDigest = (token: string): string => createHash("sha256").update(token).digest("hex");

/**
 * Pure fake business surface for the Terminal exact Sidecar acceptance host.
 * It deliberately owns no transport, process discovery, endpoint, or shutdown
 * policy so a real @open-design/sidecar host can consume the same handlers.
 */
export class TerminalExactSidecarHandlers {
  readonly #lifecycle: FileFixtureLifecyclePort;
  readonly #standalone: StandaloneRuntime;
  readonly #storeRoot: string;
  readonly #transitions = new Map<string, {
    scope: Standalone.LifecycleScope;
    transition: FixtureTransition;
  }>();
  readonly #updaterQueues = new Map<string, Promise<unknown>>();

  constructor(
    storeRoot: string,
    standalone: StandaloneRuntime,
    options: { transitionLeaseDurationMs: number },
  ) {
    this.#storeRoot = storeRoot;
    this.#standalone = standalone;
    this.#lifecycle = new FileFixtureLifecyclePort(storeRoot, {
      algebra: standalone.SHARED_LIFECYCLE_ALGEBRA,
      transitionLeaseDurationMs: options.transitionLeaseDurationMs,
    });
  }

  async request(message: JsonObject): Promise<unknown> {
    if (message?.schemaVersion !== 1) throw new Error("unsupported fixture Sidecar request schema");
    if (message.domain === "lifecycle") return await this.#lifecycleRequest(message);
    if (message.domain === "shell-updater") return await this.#updaterRequest(message);
    if (message.domain === "maintenance") return await this.#maintenanceRequest(message);
    throw new Error("invalid fixture Sidecar domain");
  }

  async #lifecycleRequest(message: JsonObject): Promise<unknown> {
    const scope = message.scope as Standalone.LifecycleScope;
    if (message.operation === "start") {
      const status = await this.#lifecycle.status(scope);
      const existing = status.occupants.some(({ attachmentId }) => attachmentId === message.attachment.id);
      const token = existing ? message.attachmentCapability : randomBytes(32).toString("hex");
      if (typeof token !== "string") {
        throw Object.assign(new Error("fixture Sidecar attachment capability is invalid"), {
          code: "attachment-capability-required",
        });
      }
      const started = await this.#lifecycle.startWithCapability(scope, message.generation, message.attachment, {
        candidateHash: capabilityDigest(token),
        presentedHash: message.attachmentCapability == null ? null : capabilityDigest(message.attachmentCapability),
      });
      return { ...started, attachmentCapability: token };
    }
    if (message.operation === "heartbeat") {
      return await this.#lifecycle.heartbeatWithCapability(
        scope,
        message.attachment,
        capabilityDigest(message.attachmentCapability ?? ""),
      );
    }
    if (message.operation === "ready") return await this.#lifecycle.awaitReady(scope, message.readiness);
    if (message.operation === "release") {
      return await this.#lifecycle.releaseWithCapability(
        scope,
        message.attachmentId,
        capabilityDigest(message.attachmentCapability ?? ""),
      );
    }
    if (message.operation === "status") return await this.#lifecycle.status(scope);
    if (message.operation === "stop") return await this.#lifecycle.stop(scope, message.fence);
    if (message.operation === "occupants") return await this.#lifecycle.occupants(scope);
    if (message.operation === "begin-transition") {
      const result = await this.#lifecycle.beginTransition(scope, message.kind, message.options);
      if (result.state === "blocked") return result;
      const token = randomUUID();
      this.#transitions.set(token, { scope, transition: result.transition as FixtureTransition });
      return { state: "acquired", transition: this.#transitionDescriptor(token, result.transition) };
    }
    if (message.operation === "transition") {
      const held = this.#transitions.get(message.token);
      if (held == null) throw new Error("fixture Sidecar transition is unavailable");
      if (held.scope.channel !== scope.channel || held.scope.namespace !== scope.namespace) {
        throw new Error("fixture Sidecar transition scope mismatch");
      }
      const transition = held.transition;
      if (message.action === "renew") {
        await transition.renew();
        return this.#transitionDescriptor(message.token, transition);
      }
      if (message.action === "release") {
        await transition.release();
        this.#transitions.delete(message.token);
        return { released: true };
      }
      if (message.action === "force-stop") {
        await transition.forceStop();
        return this.#transitionDescriptor(message.token, transition);
      }
      if (message.action === "complete-start") {
        const capability = randomBytes(32).toString("hex");
        const status = await transition.completeStart(message.generation, message.attachment, capabilityDigest(capability));
        this.#transitions.delete(message.token);
        return { ...status, attachmentCapability: capability };
      }
      throw new Error("fixture Sidecar transition action is invalid");
    }
    throw new Error(`unsupported fixture Sidecar lifecycle operation: ${message.operation}`);
  }

  async #updaterRequest(message: JsonObject): Promise<unknown> {
    const trustedKeys = new Map((message.options.trustedKeys ?? []).map(
      ({ keyId, publicKey }: { keyId: string; publicKey: string }) => [keyId, publicKey],
    ));
    const updater = new FixtureShellUpdaterPort(this.#storeRoot, message.scope, this.#lifecycle, {
      ...message.options,
      algebra: this.#standalone.SHELL_UPDATE_ALGEBRA,
      standalone: this.#standalone,
      trustedKeys,
    });
    if (message.operation === "read") return await updater.readSnapshot();
    if (message.operation === "wait") return await updater.waitForChange(message.afterRevision, message.timeoutMs);
    const key = `${message.scope.channel}/${message.scope.namespace}/${message.options.shellType ?? "electron"}`;
    const previous = this.#updaterQueues.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      if (message.operation === "invoke") return await updater.invoke(message.action);
      if (message.operation === "confirm-installed") return await updater.confirmInstalled(message.proof);
      throw new Error(`unsupported fixture Sidecar updater operation: ${message.operation}`);
    });
    this.#updaterQueues.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.#updaterQueues.get(key) === operation) this.#updaterQueues.delete(key);
    }
  }

  async #maintenanceRequest(message: JsonObject): Promise<unknown> {
    if (message.operation !== "sweep-if-idle") {
      throw new Error(`unsupported fixture Sidecar maintenance operation: ${message.operation}`);
    }
    const status = await this.#lifecycle.status(message.scope);
    if (status.references !== 0) {
      return { status: "deferred", reason: "occupied", occupants: status.occupants };
    }
    const sweep = await this.#standalone.sweepStandaloneStore(this.#storeRoot);
    const cleanup = await this.#standalone.cleanupStandaloneTrash(this.#storeRoot, message.options ?? {});
    return { status: "complete", sweep, cleanup };
  }

  #transitionDescriptor(token: string, transition: Standalone.StandaloneLifecycleTransition): JsonObject {
    return {
      token,
      fence: transition.fence,
      expiresAt: transition.expiresAt,
      heartbeatIntervalMs: transition.heartbeatIntervalMs,
      occupants: transition.occupants,
    };
  }
}
