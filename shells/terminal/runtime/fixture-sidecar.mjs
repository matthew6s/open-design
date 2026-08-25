import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
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
  transitionLeaseDurationMs: Number.parseInt(process.env.OD_FIXTURE_TRANSITION_LEASE_MS ?? "30000", 10),
});
const transitions = new Map();
const capabilityPath = join(storeRoot, "fixture-sidecar-capabilities.json");
const capabilities = await readFile(capabilityPath, "utf8").then(JSON.parse).catch((error) => {
  if (error?.code === "ENOENT") return {};
  throw error;
});
let capabilitySequence = 0;

const capabilityKey = (scope, attachmentId) => `${scope.channel}/${scope.namespace}/${attachmentId}`;
const capabilityDigest = (token) => createHash("sha256").update(token).digest("hex");
async function persistCapabilities() {
  await mkdir(dirname(capabilityPath), { recursive: true });
  const temporary = `${capabilityPath}.${process.pid}.${capabilitySequence++}.tmp`;
  await writeFile(temporary, `${JSON.stringify(capabilities)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, capabilityPath);
}
function assertCapability(scope, attachmentId, token) {
  const expected = capabilities[capabilityKey(scope, attachmentId)];
  if (expected == null || typeof token !== "string" || capabilityDigest(token) !== expected) {
    const error = new Error("fixture Sidecar attachment capability is invalid");
    error.code = "attachment-capability-required";
    throw error;
  }
}
async function clearScopeCapabilities(scope) {
  const prefix = `${scope.channel}/${scope.namespace}/`;
  for (const key of Object.keys(capabilities)) if (key.startsWith(prefix)) delete capabilities[key];
  await persistCapabilities();
}

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
    if (existing) assertCapability(scope, message.attachment.id, message.attachmentCapability);
    const token = existing ? message.attachmentCapability : randomBytes(32).toString("hex");
    const started = await lifecycle.start(scope, message.generation, message.attachment);
    capabilities[capabilityKey(scope, message.attachment.id)] = capabilityDigest(token);
    await persistCapabilities();
    return { ...started, attachmentCapability: token };
  }
  if (message.operation === "heartbeat") {
    assertCapability(scope, message.attachment.id, message.attachmentCapability);
    return lifecycle.heartbeat(scope, message.attachment);
  }
  if (message.operation === "release") {
    assertCapability(scope, message.attachmentId, message.attachmentCapability);
    const status = await lifecycle.release(scope, message.attachmentId);
    delete capabilities[capabilityKey(scope, message.attachmentId)];
    await persistCapabilities();
    return status;
  }
  if (message.operation === "status") return lifecycle.status(scope);
  if (message.operation === "stop") {
    const status = await lifecycle.stop(scope, message.fence);
    await clearScopeCapabilities(scope);
    return status;
  }
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
    if (message.action === "release") await transition.release();
    else if (message.action === "force-stop") {
      await transition.forceStop();
      await clearScopeCapabilities(held.scope);
    }
    else throw new Error("fixture Sidecar transition action is invalid");
    transitions.delete(message.token);
    return { released: true };
  }
  throw new Error(`unsupported fixture Sidecar lifecycle operation: ${message.operation}`);
}

async function updaterRequest(message) {
  const trustedKeys = new Map((message.options.trustedKeys ?? []).map(({ keyId, publicKey }) => [keyId, publicKey]));
  const updater = new FixtureShellUpdaterPort(storeRoot, message.scope, lifecycle, {
    ...message.options,
    standalone,
    trustedKeys,
  });
  if (message.operation === "read") return updater.readSnapshot();
  if (message.operation === "wait") return updater.waitForChange(message.afterRevision, message.timeoutMs);
  if (message.operation === "invoke") return updater.invoke(message.action);
  throw new Error(`unsupported fixture Sidecar updater operation: ${message.operation}`);
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
