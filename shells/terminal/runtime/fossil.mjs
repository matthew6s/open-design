import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, normalize, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const requestPath = process.env.OD_TERMINAL_FOSSIL_REQUEST_V1;
const resultPath = process.env.OD_TERMINAL_FOSSIL_RESULT_V1;
const fixtureSidecarUrl = process.env.OD_TERMINAL_FIXTURE_SIDECAR_URL;
if (!requestPath || !resultPath) throw new Error("Terminal fossil exchange environment is incomplete");
if (fixtureSidecarUrl != null && !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(fixtureSidecarUrl)) throw new Error("Terminal fixture Sidecar URL must use localhost HTTP");

const digestPattern = /^[a-f0-9]{64}$/;
const versionPattern = /^\d+\.\d+\.\d+$/;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const inside = (root, path) => {
  const value = relative(root, path);
  return value !== "" && !value.startsWith("..") && !isAbsolute(value);
};

function validateRequest(value) {
  if (value?.schemaVersion !== 1) throw new Error("unsupported fossil request schema");
  const operations = new Set(["probe", "start", "heartbeat", "release", "stop", "status", "prepare-update", "apply-update", "apply-update-force", "shell-update-status", "shell-update-check", "shell-update-download", "shell-update-install", "shell-update-later", "shell-update-force", "shell-update-confirm", "shell-update-abandon"]);
  if (!operations.has(value.operation)) throw new Error("unsupported fossil operation");
  if (!/^[a-z0-9]{1,12}$/.test(value.channel) || value.channel === "local") throw new Error("invalid exact channel");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.namespace)) throw new Error("invalid namespace");
  if (typeof value.carrierResolutionFile !== "string" || !isAbsolute(value.carrierResolutionFile)) throw new Error("invalid carrier resolution path");
  if (value.feedbackFile != null && (typeof value.feedbackFile !== "string" || !isAbsolute(value.feedbackFile))) throw new Error("invalid feedback path");
  if (value.operation !== "probe" && (typeof value.storeRoot !== "string" || !isAbsolute(value.storeRoot))) throw new Error("lifecycle operation requires an absolute Store root");
  if (new Set(["start", "heartbeat", "release"]).has(value.operation) && !/^[A-Za-z0-9._-]{1,128}$/.test(value.attachmentId)) throw new Error(`${value.operation} requires an attachment id`);
  if (value.attachmentCapability != null && !/^[a-f0-9]{64}$/.test(value.attachmentCapability)) throw new Error("invalid attachment capability");
  if (value.operation === "prepare-update" && (typeof value.channelHeadUrl !== "string" || !/^(https?:|file:)\/\//.test(value.channelHeadUrl))) throw new Error("prepare-update requires a channel head URL");
  if (new Set(["prepare-update", "apply-update", "apply-update-force"]).has(value.operation) && value.updateProtocolVersion !== 3) throw new Error("unsupported Standalone updater protocol");
  if (value.operation === "prepare-update" && !new Set(["observe", "authorize-silent", "authorize-user", "revoke-silent"]).has(value.activationPolicy)) throw new Error("prepare-update requires an explicit activation policy");
  return value;
}

async function validateInstallation(value) {
  if (value?.schemaVersion !== 1 || value.shell?.type !== "terminal" || !versionPattern.test(value.shell?.version) || !digestPattern.test(value.shell?.digest)) throw new Error("invalid Shell identity");
  if (value.runtime?.name !== "node" || !versionPattern.test(value.runtime?.version) || !digestPattern.test(value.runtime?.digest)) throw new Error("invalid carrier runtime identity");
  const root = resolve(value.installRoot);
  const manifestPath = resolve(value.manifestFile);
  const executablePath = resolve(value.runtime.executablePath);
  if (!inside(root, manifestPath) || !inside(root, executablePath)) throw new Error("carrier resolution escaped install root");
  const manifestBytes = await readFile(manifestPath);
  if (sha256(manifestBytes) !== value.shell.digest) throw new Error("Shell manifest binding failed");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest?.schemaVersion !== 1 || manifest.shell?.type !== "terminal" || manifest.shell?.version !== value.shell.version || !digestPattern.test(manifest.shell?.buildHash) || manifest.target !== value.target) throw new Error("installed manifest identity mismatch");
  if (manifest.runtime?.name !== "node" || manifest.runtime?.version !== value.runtime.version || manifest.runtime?.sha256 !== value.runtime.digest) throw new Error("installed runtime binding mismatch");
  const descriptorPath = (descriptor) => descriptor?.file ?? descriptor?.entrypoint;
  const descriptors = [manifest.carrierLock, manifest.contracts, manifest.fossil, manifest.fixtureLifecycle, manifest.fixtureShellUpdater, manifest.standalone, manifest.seed?.closure, manifest.releaseDocuments?.content, manifest.trust,
    manifest.shellFiles?.sh?.terminal, manifest.shellFiles?.sh?.install, manifest.shellFiles?.ps1?.terminal, manifest.shellFiles?.ps1?.install];
  for (const descriptor of descriptors) {
    const entrypoint = descriptorPath(descriptor);
    if (typeof entrypoint !== "string" || !digestPattern.test(descriptor?.sha256)) throw new Error("invalid installed artifact descriptor");
    const path = resolve(root, normalize(entrypoint));
    if (!inside(root, path) || sha256(await readFile(path)) !== descriptor.sha256) throw new Error(`installed artifact failed verification: ${entrypoint}`);
  }
  const contractIndex = await readJson(resolve(root, manifest.contracts.file));
  if (contractIndex?.schemaVersion !== 1 || !Array.isArray(contractIndex.files) || contractIndex.files.length === 0) throw new Error("invalid contract index");
  for (const descriptor of contractIndex.files) {
    const path = resolve(root, normalize(descriptor?.file));
    if (typeof descriptor?.file !== "string" || !digestPattern.test(descriptor?.sha256) || !inside(root, path) || sha256(await readFile(path)) !== descriptor.sha256) throw new Error("installed contract bundle failed verification");
  }
  const standalonePath = resolve(root, manifest.standalone.entrypoint);
  const standalone = await import(pathToFileURL(standalonePath).href);
  if (typeof standalone.canonicalJson !== "function" || typeof standalone.StandaloneStore !== "function" || typeof standalone.StandaloneUpdater !== "function") throw new Error("installed Standalone public API is incomplete");
  const closure = await import(pathToFileURL(resolve(root, manifest.seed.closure.file)).href);
  if (typeof closure.prepareClosureShellUpdate !== "function") throw new Error("installed Closure public API is incomplete");
  return { root, manifest, manifestBytes, standalone, closure };
}

async function readUrl(url) {
  if (url.startsWith("file://")) return new Uint8Array(await readFile(new URL(url)));
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) throw new Error(`artifact request failed: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function sidecarRequest(message) {
  const response = await fetch(`${fixtureSidecarUrl}/v1/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, ...message }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) {
    const error = new Error(payload?.error?.message ?? `fixture Sidecar request failed: ${response.status}`);
    error.code = payload?.error?.code;
    throw error;
  }
  return payload.result;
}

function sidecarLifecycle(requestAttachmentCapability) {
  const call = (operation, scope, input = {}) => sidecarRequest({ domain: "lifecycle", operation, scope, ...input });
  return {
    start: (scope, generation, attachment) => call("start", scope, { generation, attachment, attachmentCapability: requestAttachmentCapability }),
    awaitReady: (scope, readiness) => call("ready", scope, { readiness }),
    heartbeat: (scope, attachment) => call("heartbeat", scope, { attachment, attachmentCapability: requestAttachmentCapability }),
    release: (scope, attachmentId) => call("release", scope, { attachmentId, attachmentCapability: requestAttachmentCapability }),
    status: (scope) => call("status", scope),
    stop: (scope, fence) => call("stop", scope, { fence }),
    occupants: (scope) => call("occupants", scope),
    async beginTransition(scope, kind, options) {
      const result = await call("begin-transition", scope, { kind, options });
      if (result.state === "blocked") return result;
      const descriptor = result.transition;
      const transitionCall = (action, input = {}) => call("transition", scope, { action, token: descriptor.token, ...input });
      return {
        state: "acquired",
        transition: {
          attemptId: descriptor.attemptId ?? descriptor.token,
          fence: descriptor.fence,
          expiresAt: descriptor.expiresAt,
          heartbeatIntervalMs: descriptor.heartbeatIntervalMs,
          occupants: descriptor.occupants,
          phase: descriptor.phase ?? "reserved",
          renew: () => transitionCall("renew"),
          release: () => transitionCall("release"),
          forceStop: () => transitionCall("force-stop"),
          completeStart: (generation, attachment) => transitionCall("complete-start", { generation, attachment }),
        },
      };
    },
  };
}

function sidecarShellUpdater(scope, options) {
  const request = (operation, input = {}) => sidecarRequest({ domain: "shell-updater", operation, scope, options, ...input });
  return {
    shellType: options.shellType,
    readSnapshot: () => request("read"),
    waitForChange: (afterRevision, timeoutMs) => request("wait", { afterRevision, timeoutMs }),
    invoke: (action) => request("invoke", { action }),
    confirmInstalled: (proof) => request("confirm-installed", { proof }),
  };
}

async function trustedKeys(installation) {
  const value = await readJson(resolve(installation.root, installation.manifest.trust.file));
  if (value?.schemaVersion !== 1 || !Array.isArray(value.keys) || value.keys.length === 0) throw new Error("invalid trusted key document");
  const keys = new Map();
  for (const entry of value.keys) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(entry?.keyId) || typeof entry?.publicKey !== "string" || keys.has(entry.keyId)) throw new Error("invalid trusted key entry");
    keys.set(entry.keyId, entry.publicKey);
  }
  return keys;
}

async function ensureInstalledSeed(request, installation, store, keys, feedback) {
  const envelope = await readJson(resolve(installation.root, installation.manifest.releaseDocuments.content.file));
  installation.standalone.verifyStandaloneMetadata(envelope, keys);
  if (envelope.metadata.channel !== request.channel) throw new Error("installed seed belongs to another channel");
  const expectedId = installation.standalone.sha256Hex(installation.standalone.canonicalJson(envelope.metadata));
  let state = await store.readState();
  if (state.lastHealthy == null && state.activationAttempt != null && state.activationAttempt.generationId !== expectedId) {
    await store.recoverInterruptedAttempt();
    state = await store.readState();
  }
  if (state.lastHealthy == null && state.active == null && state.prepared !== expectedId) {
    const seedBytes = new Uint8Array(await readFile(resolve(installation.root, installation.manifest.seed.closure.file)));
    const digest = installation.manifest.seed.closure.sha256;
    const declared = envelope.metadata.blobs?.[digest];
    if (declared == null || declared.size !== seedBytes.byteLength) {
      const error = new Error("required installed seed is incomplete");
      error.code = "resource-unavailable";
      throw error;
    }
    await store.prepare(envelope, keys, { candidates: { [digest]: [{ path: resolve(installation.root, installation.manifest.seed.closure.file), source: "shell" }] }, feedback });
    state = await store.readState();
  }
  if (state.active == null && state.prepared === expectedId && state.activationIntent?.generationId !== expectedId) {
    await store.authorizePrepared(expectedId, "silent", "installed-seed", state.revision);
  }
}

async function execute(request, installation) {
  if (request.operation === "probe") return { capabilities: installation.manifest.capabilities, channel: request.channel, namespace: request.namespace };
  const { standalone } = installation;
  const keys = await trustedKeys(installation);
  const storeRoot = resolve(request.storeRoot);
  const store = new standalone.StandaloneStore(storeRoot, { channel: request.channel, namespace: request.namespace });
  const { FileFixtureLifecyclePort } = await import(pathToFileURL(resolve(installation.root, installation.manifest.fixtureLifecycle.entrypoint)).href);
  const lifecycle = fixtureSidecarUrl == null
    ? new FileFixtureLifecyclePort(storeRoot, { algebra: standalone.SHARED_LIFECYCLE_ALGEBRA })
    : sidecarLifecycle(request.attachmentCapability);
  const shell = {
    type: "terminal",
    version: installation.manifest.shell.version,
    buildHash: installation.manifest.shell.buildHash,
    digest: sha256(installation.manifestBytes),
  };
  const feedback = request.feedbackFile == null ? undefined : async (event) => appendFile(request.feedbackFile, `${JSON.stringify(event)}\n`, "utf8");
  const launcher = new standalone.VersionedLauncher(store, lifecycle, shell, request.attachmentId ?? "terminal-control", feedback);
  if (request.operation.startsWith("shell-update-")) {
    const { FixtureShellUpdaterPort } = await import(pathToFileURL(resolve(installation.root, installation.manifest.fixtureShellUpdater.entrypoint)).href);
    const updaterOptions = { algebra: standalone.SHELL_UPDATE_ALGEBRA, attachmentId: request.attachmentId ?? "electron-updater", shellType: "electron" };
    const updater = fixtureSidecarUrl == null
      ? new FixtureShellUpdaterPort(storeRoot, { channel: request.channel, namespace: request.namespace }, lifecycle, updaterOptions)
      : sidecarShellUpdater({ channel: request.channel, namespace: request.namespace }, updaterOptions);
    const action = ({
      "shell-update-check": "check",
      "shell-update-download": "download",
      "shell-update-install": "install",
      "shell-update-later": "later",
      "shell-update-force": "force-stop-and-install",
      "shell-update-abandon": "abandon",
    })[request.operation];
    if (request.operation === "shell-update-confirm") {
      return updater.confirmInstalled(shell);
    }
    return action == null ? updater.readSnapshot() : updater.invoke(action);
  }
  if (request.operation === "start") {
    await ensureInstalledSeed(request, installation, store, keys, feedback);
    return new standalone.FossilBootloader(store, shell, async () => launcher).start();
  }
  if (request.operation === "heartbeat") return launcher.heartbeat();
  if (request.operation === "release") return launcher.release();
  if (request.operation === "status") return launcher.status();
  if (request.operation === "stop") return launcher.stop();
  const source = request.operation === "prepare-update"
      ? {
        readChannelHead: async () => JSON.parse(Buffer.from(await readUrl(request.channelHeadUrl)).toString("utf8")),
        readDocument: readUrl,
        prepare: { fetch: globalThis.fetch },
      }
      : {
        readChannelHead: async () => { throw new Error("unused update source"); },
        readDocument: async () => { throw new Error("unused update source"); },
      };
  const updater = new standalone.StandaloneUpdater(request.channel, "content", shell, keys, store, source, feedback);
  if (request.operation === "prepare-update") {
    const preparation = await updater.prepareLatest(request.activationPolicy);
    if (preparation.status !== "shell-reinstall-required") return preparation;
    const { FixtureShellUpdaterPort } = await import(pathToFileURL(resolve(installation.root, installation.manifest.fixtureShellUpdater.entrypoint)).href);
    const updaterOptions = {
      algebra: standalone.SHELL_UPDATE_ALGEBRA,
      attachmentId: request.attachmentId ?? `${shell.type}-updater`,
      channelHeadUrl: request.channelHeadUrl,
      shellType: shell.type,
      target: installation.manifest.target,
      trustedKeys: [...keys].map(([keyId, publicKey]) => ({ keyId, publicKey })),
    };
    const shellUpdater = fixtureSidecarUrl == null
      ? new FixtureShellUpdaterPort(storeRoot, { channel: request.channel, namespace: request.namespace }, lifecycle, { ...updaterOptions, standalone, trustedKeys: keys })
      : sidecarShellUpdater({ channel: request.channel, namespace: request.namespace }, updaterOptions);
    return installation.closure.prepareClosureShellUpdate({ requirement: preparation.requirement, shell, updater: shellUpdater });
  }
  return updater.applyNow(launcher, { force: request.operation === "apply-update-force" });
}

let operation = "unknown";
let phase = "request";
try {
  const request = validateRequest(await readJson(requestPath));
  operation = request.operation;
  phase = "installation";
  const resolution = await readJson(request.carrierResolutionFile);
  const installation = await validateInstallation(resolution);
  phase = "operation";
  const result = await execute(request, installation);
  await writeFile(resultPath, `${JSON.stringify({ schemaVersion: 1, outcome: "ready", operation, shell: resolution.shell, result })}\n`, "utf8");
} catch (error) {
  const allowed = new Set(["installer-required", "no-generation", "resource-unavailable", "standalone-occupied", "standalone-start-failed"]);
  const code = allowed.has(error?.code) ? error.code : phase === "request" ? "invalid-request" : phase === "installation" ? "invalid-installation" : "operation-failed";
  await writeFile(resultPath, `${JSON.stringify({ schemaVersion: 1, outcome: "rejected", operation, error: { code, message: error instanceof Error ? error.message : String(error) } })}\n`, "utf8");
  process.exitCode = 1;
}
