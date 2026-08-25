import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const canonical = (value) => `${JSON.stringify(value)}\n`;
const sleep = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
let sequence = 0;

function initial(shellType) {
  return { schemaVersion: 2, revision: 0, shellType, state: "idle", actions: [{ id: "check", emphasis: "primary" }], blockedBy: [] };
}

async function replaceFile(from, to) {
  try { await rename(from, to); }
  catch (error) {
    if (process.platform !== "win32" || (error?.code !== "EPERM" && error?.code !== "EEXIST")) throw error;
    await unlink(to).catch((unlinkError) => { if (unlinkError?.code !== "ENOENT") throw unlinkError; });
    await rename(from, to);
  }
}

async function readUrl(url) {
  if (url.startsWith("file://")) return new Uint8Array(await readFile(new URL(url)));
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) throw new Error(`Shell updater request failed: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export class FixtureShellUpdaterPort {
  constructor(root, scope, lifecycle, options = {}) {
    const fixtureRoot = join(root, "channels", scope.channel, "namespaces", scope.namespace, "fixture");
    this.path = join(fixtureRoot, "shell-updater.json");
    this.candidatePath = join(fixtureRoot, "shell-candidate.json");
    this.root = root;
    this.scope = scope;
    this.lifecycle = lifecycle;
    this.shellType = options.shellType ?? "electron";
    this.attachmentId = options.attachmentId ?? `${this.shellType}-updater`;
    this.channelHeadUrl = options.channelHeadUrl;
    this.target = options.target;
    this.trustedKeys = options.trustedKeys;
    this.standalone = options.standalone;
    this.faultAt = options.faultAt;
    this.installDelayMs = options.installDelayMs ?? 0;
  }

  get configured() {
    return this.channelHeadUrl != null && this.target != null && this.trustedKeys != null && this.standalone != null;
  }

  async readSnapshot() {
    try { return JSON.parse(await readFile(this.path, "utf8")); }
    catch (error) { if (error?.code === "ENOENT") return initial(this.shellType); throw error; }
  }

  async writePath(path, value) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.${sequence++}.tmp`;
    await writeFile(temporary, canonical(value), { flag: "wx" });
    try { await replaceFile(temporary, path); }
    catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
    return value;
  }

  write(snapshot) { return this.writePath(this.path, snapshot); }

  async update(value) {
    const current = await this.readSnapshot();
    return this.write({ ...current, ...value, revision: current.revision + 1 });
  }

  async waitForChange(afterRevision, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    do {
      const snapshot = await this.readSnapshot();
      if (snapshot.revision > afterRevision) return snapshot;
      await sleep(10);
    } while (Date.now() < deadline);
    return this.readSnapshot();
  }

  async discover() {
    await this.update({ state: "checking", actions: [], blockedBy: [], progress: undefined, handoff: undefined, error: undefined });
    const headBytes = await readUrl(this.channelHeadUrl);
    const head = JSON.parse(Buffer.from(headBytes).toString("utf8"));
    this.standalone.verifyStandaloneChannelHead(head, this.trustedKeys);
    if (head.head.channel !== this.scope.channel) throw new Error("Shell sidecar escaped updater channel");
    const lane = head.head.lanes[this.shellType];
    if (lane == null) throw new Error(`channel head lacks Shell lane: ${this.shellType}`);
    const metadataBytes = await readUrl(lane.url);
    if (metadataBytes.byteLength !== lane.size || this.standalone.sha256Hex(metadataBytes) !== lane.sha256) {
      throw new Error("Shell sidecar metadata failed binding verification");
    }
    const envelope = JSON.parse(Buffer.from(metadataBytes).toString("utf8"));
    this.standalone.verifyStandaloneShellMetadata(envelope, this.trustedKeys);
    if (envelope.document.channel !== this.scope.channel || envelope.document.releaseVersion !== lane.releaseVersion) {
      throw new Error("Shell sidecar metadata identity mismatch");
    }
    const distribution = envelope.document.distributions.find(({ shell, target }) => shell.type === this.shellType && target === this.target);
    if (distribution == null) throw new Error(`Shell sidecar lacks target distribution: ${this.shellType}/${this.target}`);
    const candidate = { releaseVersion: lane.releaseVersion, distribution };
    await this.writePath(this.candidatePath, candidate);
    return this.update({ state: "available", actions: [{ id: "download", emphasis: "primary" }], blockedBy: [], progress: undefined, handoff: undefined, error: undefined });
  }

  async download() {
    const candidate = JSON.parse(await readFile(this.candidatePath, "utf8"));
    const artifact = candidate.distribution.artifact;
    await this.update({ state: "downloading", progress: { completed: 0, total: artifact.size }, actions: [], blockedBy: [], error: undefined });
    const downloaded = await this.standalone.ensureStandaloneBlob(this.root, {
      sha256: artifact.sha256,
      size: artifact.size,
      mediaType: artifact.mediaType,
      sources: [{ kind: "remote", url: artifact.url }],
    }, { resourceId: `${this.shellType}-distribution` });
    const handoff = {
      interaction: candidate.distribution.updater?.interaction ?? "restart-and-install",
      releaseVersion: candidate.releaseVersion,
      target: candidate.distribution.target,
      shell: candidate.distribution.shell,
      artifact: { path: downloaded.path, sha256: artifact.sha256, size: artifact.size, mediaType: artifact.mediaType },
    };
    return this.update({
      state: "ready",
      progress: { completed: artifact.size, total: artifact.size },
      actions: [{ id: "install", emphasis: "primary" }, { id: "later", emphasis: "secondary" }],
      blockedBy: [],
      handoff,
      error: undefined,
    });
  }

  async failed(error) {
    return this.update({
      state: "failed",
      actions: [{ id: "check", emphasis: "primary" }],
      blockedBy: [],
      error: { code: error?.code ?? "shell-update-failed", message: error instanceof Error ? error.message : String(error) },
    });
  }

  async confirmInstalled(proof) {
    const snapshot = await this.readSnapshot();
    const expected = snapshot.handoff?.shell;
    const matches = expected != null
      && proof?.shell?.type === expected.type
      && proof.shell.version === expected.version
      && proof.buildHash === expected.buildHash;
    if (snapshot.state === "installed") {
      return { outcome: matches ? "accepted" : "failed", snapshot };
    }
    if (snapshot.state !== "handed-off" || expected == null) {
      return { outcome: "failed", snapshot: await this.failed(new Error("Shell installation has no handed-off candidate")) };
    }
    if (!matches) {
      return {
        outcome: "failed",
        snapshot: await this.update({
          state: "handed-off",
          actions: [{ id: "install", emphasis: "primary" }],
          error: { code: "installed-shell-mismatch", message: "attached Shell does not match the handed-off distribution" },
        }),
      };
    }
    return {
      outcome: "accepted",
      snapshot: await this.update({ state: "installed", actions: [], blockedBy: [], error: undefined }),
    };
  }

  async invoke(action) {
    if (action === "check") {
      if (!this.configured) return { outcome: "accepted", snapshot: await this.update({ state: "available", actions: [{ id: "download", emphasis: "primary" }], blockedBy: [] }) };
      try { return { outcome: "accepted", snapshot: await this.discover() }; }
      catch (error) { return { outcome: "failed", snapshot: await this.failed(error) }; }
    }
    if (action === "download") {
      if (!this.configured) {
        await this.update({ state: "downloading", progress: { completed: 1, total: 2 }, actions: [], blockedBy: [] });
        return { outcome: "accepted", snapshot: await this.update({ state: "ready", progress: { completed: 2, total: 2 }, actions: [{ id: "install", emphasis: "primary" }, { id: "later", emphasis: "secondary" }], blockedBy: [] }) };
      }
      try { return { outcome: "accepted", snapshot: await this.download() }; }
      catch (error) { return { outcome: "failed", snapshot: await this.failed(error) }; }
    }
    if (action === "later") return { outcome: "accepted", snapshot: await this.update({ state: "ready", actions: [{ id: "install", emphasis: "primary" }], blockedBy: [] }) };
    if (action !== "install" && action !== "force-stop-and-install") return { outcome: "unsupported", snapshot: await this.readSnapshot() };
    const transition = await this.lifecycle.beginTransition(this.scope, "shell-install", { ownerShellType: this.shellType, force: action === "force-stop-and-install" });
    if (transition.state === "blocked") {
      const snapshot = await this.update({
        state: "ready",
        blockedBy: transition.occupants,
        actions: [{ id: "later", emphasis: "secondary" }, { id: "force-stop-and-install", emphasis: "danger" }],
      });
      return { outcome: "blocked", snapshot };
    }
    let heartbeat;
    try {
      await this.update({ state: "applying", actions: [], blockedBy: transition.transition.occupants });
      if (this.faultAt === "after-transition") {
        const error = new Error("injected Sidecar crash after transition acquisition");
        error.abandonedTransition = true;
        throw error;
      }
      heartbeat = setInterval(() => { void transition.transition.renew().catch(() => undefined); }, transition.transition.heartbeatIntervalMs);
      heartbeat.unref();
      if (this.installDelayMs > 0) await sleep(this.installDelayMs);
      await transition.transition.forceStop();
      return { outcome: "accepted", snapshot: await this.update({ state: "handed-off", actions: [], blockedBy: [] }) };
    } catch (error) {
      if (!error?.abandonedTransition) await transition.transition.release();
      throw error;
    } finally {
      if (heartbeat != null) clearInterval(heartbeat);
    }
  }
}
