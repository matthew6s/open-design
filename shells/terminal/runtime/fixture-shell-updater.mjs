import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const canonical = (value) => `${JSON.stringify(value)}\n`;

function initial(shellType) {
  return { schemaVersion: 1, revision: 0, shellType, state: "idle", actions: [{ id: "check", emphasis: "primary" }], blockedBy: [] };
}

export class FixtureShellUpdaterPort {
  constructor(root, scope, lifecycle, options = {}) {
    this.path = join(root, "channels", scope.channel, "namespaces", scope.namespace, "fixture", "shell-updater.json");
    this.scope = scope;
    this.lifecycle = lifecycle;
    this.shellType = options.shellType ?? "electron";
    this.attachmentId = options.attachmentId ?? `${this.shellType}-updater`;
  }

  async readSnapshot() {
    try { return JSON.parse(await readFile(this.path, "utf8")); }
    catch (error) { if (error?.code === "ENOENT") return initial(this.shellType); throw error; }
  }

  async write(snapshot) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, canonical(snapshot), { flag: "wx" });
    try { await rename(temporary, this.path); }
    catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
    return snapshot;
  }

  async update(value) {
    const current = await this.readSnapshot();
    return this.write({ ...current, ...value, revision: current.revision + 1 });
  }

  async waitForChange(afterRevision, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    do {
      const snapshot = await this.readSnapshot();
      if (snapshot.revision > afterRevision) return snapshot;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    } while (Date.now() < deadline);
    return this.readSnapshot();
  }

  async invoke(action) {
    if (action === "check") return { outcome: "accepted", snapshot: await this.update({ state: "available", actions: [{ id: "download", emphasis: "primary" }], blockedBy: [] }) };
    if (action === "download") {
      await this.update({ state: "downloading", progress: { completed: 1, total: 2 }, actions: [], blockedBy: [] });
      return { outcome: "accepted", snapshot: await this.update({ state: "ready", progress: { completed: 2, total: 2 }, actions: [{ id: "install", emphasis: "primary" }, { id: "later", emphasis: "secondary" }], blockedBy: [] }) };
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
    try {
      await this.update({ state: "applying", actions: [], blockedBy: transition.transition.occupants });
      await transition.transition.forceStop();
      return { outcome: "accepted", snapshot: await this.update({ state: "handed-off", actions: [], blockedBy: [] }) };
    } catch (error) {
      await transition.transition.release();
      throw error;
    }
  }
}
