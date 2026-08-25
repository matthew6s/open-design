import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { FileFixtureLifecyclePort } from "./fixture-lifecycle.mjs";
import { FixtureShellUpdaterPort } from "./fixture-shell-updater.mjs";

const argumentsMap = new Map();
for (let index = 2; index < process.argv.length; index += 2) argumentsMap.set(process.argv[index], process.argv[index + 1]);
const storeRoot = resolve(argumentsMap.get("--store-root") ?? "");
const standalonePath = resolve(argumentsMap.get("--standalone") ?? "");
const port = Number.parseInt(argumentsMap.get("--port") ?? "0", 10);
if (!storeRoot || !standalonePath || !Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("fixture Sidecar arguments are invalid");

const standalone = await import(pathToFileURL(standalonePath).href);
const lifecycle = new FileFixtureLifecyclePort(storeRoot, {
  algebra: standalone.SHARED_LIFECYCLE_ALGEBRA,
  transitionLeaseDurationMs: Number.parseInt(process.env.OD_FIXTURE_TRANSITION_LEASE_MS ?? "30000", 10),
});
const transitions = new Map();
const updaterQueues = new Map();
const capabilityDigest = (token) => createHash("sha256").update(token).digest("hex");

function errorPayload(error) {
  return { code: error?.code ?? "fixture-sidecar-error", message: error instanceof Error ? error.message : String(error) };
}

function transitionDescriptor(token, transition) {
  return {
    token,
    fence: transition.fence,
    expiresAt: transition.expiresAt,
    heartbeatIntervalMs: transition.heartbeatIntervalMs,
    occupants: transition.occupants,
  };
}

async function lifecycleRequest(message) {
  const scope = message.scope;
  if (message.operation === "start") {
    const status = await lifecycle.status(scope);
    const existing = status.occupants.some(({ attachmentId }) => attachmentId === message.attachment.id);
    const token = existing ? message.attachmentCapability : randomBytes(32).toString("hex");
    if (typeof token !== "string") {
      const error = new Error("fixture Sidecar attachment capability is invalid");
      error.code = "attachment-capability-required";
      throw error;
    }
    const started = await lifecycle.startWithCapability(scope, message.generation, message.attachment, {
      candidateHash: capabilityDigest(token),
      presentedHash: message.attachmentCapability == null ? null : capabilityDigest(message.attachmentCapability),
    });
    return { ...started, attachmentCapability: token };
  }
  if (message.operation === "heartbeat") {
    return lifecycle.heartbeatWithCapability(scope, message.attachment, capabilityDigest(message.attachmentCapability ?? ""));
  }
  if (message.operation === "ready") return lifecycle.awaitReady(scope, message.readiness);
  if (message.operation === "release") {
    return lifecycle.releaseWithCapability(scope, message.attachmentId, capabilityDigest(message.attachmentCapability ?? ""));
  }
  if (message.operation === "status") return lifecycle.status(scope);
  if (message.operation === "stop") return lifecycle.stop(scope, message.fence);
  if (message.operation === "occupants") return lifecycle.occupants(scope);
  if (message.operation === "begin-transition") {
    const result = await lifecycle.beginTransition(scope, message.kind, message.options);
    if (result.state === "blocked") return result;
    const token = randomUUID();
    transitions.set(token, { scope, transition: result.transition });
    return { state: "acquired", transition: transitionDescriptor(token, result.transition) };
  }
  if (message.operation === "transition") {
    const held = transitions.get(message.token);
    if (held == null) throw new Error("fixture Sidecar transition is unavailable");
    const transition = held.transition;
    if (message.action === "renew") {
      await transition.renew();
      return transitionDescriptor(message.token, transition);
    }
    if (message.action === "release") {
      await transition.release();
      transitions.delete(message.token);
      return { released: true };
    }
    else if (message.action === "force-stop") {
      await transition.forceStop();
      return transitionDescriptor(message.token, transition);
    } else if (message.action === "complete-start") {
      const capability = randomBytes(32).toString("hex");
      const status = await transition.completeStart(message.generation, message.attachment, capabilityDigest(capability));
      transitions.delete(message.token);
      return { ...status, attachmentCapability: capability };
    }
    else throw new Error("fixture Sidecar transition action is invalid");
  }
  throw new Error(`unsupported fixture Sidecar lifecycle operation: ${message.operation}`);
}

async function updaterRequest(message) {
  const trustedKeys = new Map((message.options.trustedKeys ?? []).map(({ keyId, publicKey }) => [keyId, publicKey]));
  const updater = new FixtureShellUpdaterPort(storeRoot, message.scope, lifecycle, {
    ...message.options,
    algebra: standalone.SHELL_UPDATE_ALGEBRA,
    standalone,
    trustedKeys,
  });
  if (message.operation === "read") return updater.readSnapshot();
  if (message.operation === "wait") return updater.waitForChange(message.afterRevision, message.timeoutMs);
  const key = `${message.scope.channel}/${message.scope.namespace}/${message.options.shellType ?? "electron"}`;
  const previous = updaterQueues.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(() => {
    if (message.operation === "invoke") return updater.invoke(message.action);
    if (message.operation === "confirm-installed") return updater.confirmInstalled(message.proof);
    throw new Error(`unsupported fixture Sidecar updater operation: ${message.operation}`);
  });
  updaterQueues.set(key, operation);
  try { return await operation; }
  finally { if (updaterQueues.get(key) === operation) updaterQueues.delete(key); }
}

async function maintenanceRequest(message) {
  if (message.operation !== "sweep-if-idle") throw new Error(`unsupported fixture Sidecar maintenance operation: ${message.operation}`);
  const status = await lifecycle.status(message.scope);
  if (status.references !== 0) return { status: "deferred", reason: "occupied", occupants: status.occupants };
  const sweep = await standalone.sweepStandaloneStore(storeRoot);
  const cleanup = await standalone.cleanupStandaloneTrash(storeRoot, message.options ?? {});
  return { status: "complete", sweep, cleanup };
}

const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/request") {
    response.writeHead(404).end();
    return;
  }
  let body = "";
  request.setEncoding("utf8");
  for await (const chunk of request) body += chunk;
  try {
    const message = JSON.parse(body);
    if (message?.schemaVersion !== 1) throw new Error("unsupported fixture Sidecar request schema");
    if (message.fault === "crash") {
      response.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      setImmediate(() => process.exit(73));
      return;
    }
    const result = message.domain === "lifecycle"
      ? await lifecycleRequest(message)
      : message.domain === "shell-updater"
        ? await updaterRequest(message)
        : message.domain === "maintenance"
          ? await maintenanceRequest(message)
          : (() => { throw new Error("invalid fixture Sidecar domain"); })();
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result }));
  } catch (error) {
    response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: errorPayload(error) }));
  }
});

await new Promise((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(port, "127.0.0.1", () => { server.off("error", rejectListen); resolveListen(); });
});
const address = server.address();
if (address == null || typeof address === "string") throw new Error("fixture Sidecar did not bind TCP");
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, endpointUrl: `http://127.0.0.1:${address.port}` })}\n`);

for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close(() => process.exit(0)));
