import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const workspaceRoot = resolve(import.meta.dirname, "../../..");
const terminalRoot = join(workspaceRoot, "shells/terminal");
const packScript = join(workspaceRoot, ".github/scripts/pack.py");
const releaseScript = join(workspaceRoot, ".github/scripts/release.py");
const enabled = process.env.OD_EXACT_LOCAL_E2E === "1";
const roots: string[] = [];
const processes: ChildProcess[] = [];

type Json = Record<string, any>;
type Storage = { bucket: string; endpointUrl: string };
type PublishedRelease = {
  archive: string;
  channelHeadUrl: string;
  contentMetadataFile: string;
  releaseVersion: string;
};

function canonical(value: unknown): Buffer {
  const normalized = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalized);
    if (input != null && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalized(child)]),
      );
    }
    return input;
  };
  return Buffer.from(`${JSON.stringify(normalized(value))}\n`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function json(path: string): Promise<Json> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, canonical(value));
}

async function command(commandName: string, args: string[], cwd = workspaceRoot): Promise<string> {
  const result = await execFileAsync(commandName, args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return result.stdout;
}

async function startReleaseStorage(): Promise<Storage> {
  const child = spawn(
    "pnpm",
    ["--silent", "--filter", "@open-design/tools-serve", "dev", "start", "release-storage", "--json", "--port", "0"],
    { cwd: workspaceRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  processes.push(child);
  return new Promise((resolveStart, rejectStart) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => rejectStart(new Error(`tools-serve release-storage timed out: ${stderr}`)), 15_000);
    child.stderr?.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.stdout?.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith("{"));
      if (line == null) return;
      clearTimeout(timeout);
      resolveStart(JSON.parse(line));
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      rejectStart(new Error(`tools-serve release-storage exited ${code}: ${stderr}`));
    });
  });
}

async function ensureNodeArchive(target: string): Promise<{ file: string; sha256: string; version: string }> {
  const lock = await json(join(terminalRoot, "node-lock.json"));
  const entry = lock.targets[target] as { archive: string; sha256: string; url: string } | undefined;
  if (entry == null) throw new Error(`Terminal Node lock lacks ${target}`);
  const directory = join(workspaceRoot, ".tmp/terminal-e2e/node");
  const file = join(directory, entry.archive);
  await mkdir(directory, { recursive: true });
  const current = await readFile(file).catch(() => null);
  if (current == null || sha256(current) !== entry.sha256) {
    const response = await fetch(entry.url);
    if (!response.ok) throw new Error(`Node archive download failed: ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    if (sha256(body) !== entry.sha256) throw new Error("Node archive digest mismatch");
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, body, { flag: "wx" });
    await rename(temporary, file);
  }
  return { file, sha256: entry.sha256, version: lock.version as string };
}

async function terminal(
  installRoot: string,
  storeRoot: string,
  channel: string,
  namespace: string,
  operation: string,
  options: { activationSource?: string; attachmentId?: string; channelHeadUrl?: string; feedbackFile?: string } = {},
): Promise<Json> {
  const args = [
    join(installRoot, "sh/terminal.sh"),
    "--root", installRoot,
    "--store-root", storeRoot,
    "--channel", channel,
    "--namespace", namespace,
    "--operation", operation,
    ...(options.attachmentId == null ? [] : ["--attachment-id", options.attachmentId]),
    ...(options.channelHeadUrl == null ? [] : ["--channel-head-url", options.channelHeadUrl]),
    ...(options.activationSource == null ? [] : ["--activation-source", options.activationSource]),
    ...(options.feedbackFile == null ? [] : ["--feedback", options.feedbackFile]),
  ];
  return JSON.parse(await command("sh", args));
}

describe("local exact Terminal release line", () => {
  afterEach(async () => {
    for (const child of processes.splice(0)) child.kill();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it.skipIf(!enabled || process.platform !== "darwin" || !new Set(["arm64", "x64"]).has(process.arch))(
    "[P1] publishes and consumes isolated exact channels through one tools-serve instance",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "exact-terminal-local-"));
      roots.push(root);
      const target = `darwin-${process.arch}`;
      const node = await ensureNodeArchive(target);
      const storage = await startReleaseStorage();
      const publicOrigin = `${storage.endpointUrl}/${storage.bucket}`;
      const sourceCommit = (await command("git", ["rev-parse", "HEAD"])).trim();
      const keys = generateKeyPairSync("ed25519");
      const signingEnvironment = {
        ...process.env,
        OD_EXACT_SIGNING_KEY_ID: "local-exact-e2e",
        OD_EXACT_ED25519_PRIVATE_KEY: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      };

      await command("pnpm", ["--filter", "@open-design/standalone", "build"]);
      await command("pnpm", ["--filter", "@open-design/closure", "build"]);
      const baseClosure = await readFile(join(workspaceRoot, "apps/closure/dist/fixture.mjs"));

      const publish = async (input: {
        channel: "betahyx" | "previewhyx";
        releaseVersion: string;
        shellVersion: string;
        closure: Uint8Array;
        previousContentMetadataFile?: string;
      }): Promise<PublishedRelease> => {
        const releaseRoot = join(root, input.releaseVersion);
        const closureFile = join(releaseRoot, "closure.mjs");
        const scene = join(releaseRoot, "scene");
        const prepared = join(releaseRoot, "prepared");
        const distribution = join(releaseRoot, "distribution");
        const finalized = join(releaseRoot, "finalized");
        await mkdir(releaseRoot, { recursive: true });
        await writeFile(closureFile, input.closure);

        const sceneRequest = join(releaseRoot, "scene-request.json");
        const sceneReceipt = join(releaseRoot, "scene-receipt.json");
        await writeJson(sceneRequest, {
          schemaVersion: 1,
          operation: "terminal.scene.build",
          target,
          shellVersion: input.shellVersion,
          node: { version: node.version, archiveFile: node.file, archiveSha256: node.sha256 },
          closureArtifactFile: closureFile,
          standaloneDirectory: join(workspaceRoot, "packages/standalone/dist"),
          sceneDirectory: scene,
        });
        await command("sh", [join(terminalRoot, "sh/scene.sh"), "--request", sceneRequest, "--receipt", sceneReceipt]);
        const sceneManifest = join(scene, "scene.json");

        const prepareRequest = join(releaseRoot, "prepare-request.json");
        const prepareReceipt = join(prepared, "prepare-receipt.json");
        await writeJson(prepareRequest, {
          schemaVersion: 1,
          operation: "exact.prepare",
          channel: input.channel,
          releaseVersion: input.releaseVersion,
          sourceCommit,
          publishedAt: "2026-08-24T14:00:00.000Z",
          standaloneVersion: "0.1.0",
          shellVersion: input.shellVersion,
          artifactBaseUrl: `${publicOrigin}/${input.channel}/${input.releaseVersion}`,
          closureArtifactFile: closureFile,
          scenes: [{ target, sceneDirectory: scene, sceneManifestSha256: sha256(await readFile(sceneManifest)) }],
          outputDirectory: prepared,
          ...(input.previousContentMetadataFile == null ? {} : { previousContentMetadataFile: input.previousContentMetadataFile }),
        });
        await execFileAsync("python3", [packScript, "--request", prepareRequest, "--receipt", prepareReceipt], { cwd: workspaceRoot, env: signingEnvironment });
        const preparation = await json(prepareReceipt);

        const distributionRequest = join(releaseRoot, "distribution-request.json");
        const distributionReceipt = join(distribution, "distribution-receipt.json");
        await writeJson(distributionRequest, {
          schemaVersion: 1,
          operation: "terminal.distribution.build",
          target,
          sceneDirectory: scene,
          sceneManifestSha256: sha256(await readFile(sceneManifest)),
          releaseDocumentsDirectory: join(prepared, "documents"),
          trustFile: join(prepared, "trust/keys.json"),
          release: {
            channel: input.channel,
            releaseVersion: input.releaseVersion,
            sourceCommit: preparation.sourceCommit,
            publishedAt: preparation.publishedAt,
            artifactBaseUrl: preparation.artifactBaseUrl,
          },
          outputDirectory: distribution,
        });
        await command("sh", [join(terminalRoot, "sh/distribution.sh"), "--request", distributionRequest, "--receipt", distributionReceipt]);

        const finalizeRequest = join(releaseRoot, "finalize-request.json");
        const packReceipt = join(finalized, "pack-receipt.json");
        await writeJson(finalizeRequest, {
          schemaVersion: 1,
          operation: "exact.finalize",
          prepareReceipt,
          distributions: [{ receipt: distributionReceipt }],
          outputDirectory: finalized,
        });
        await execFileAsync("python3", [packScript, "--request", finalizeRequest, "--receipt", packReceipt], { cwd: workspaceRoot, env: signingEnvironment });

        const releaseRequest = join(releaseRoot, "release-request.json");
        const releaseReceipt = join(finalized, "release-receipt.json");
        await writeJson(releaseRequest, {
          schemaVersion: 1,
          operation: "exact.release",
          packReceipt,
          endpointUrl: storage.endpointUrl,
          bucket: storage.bucket,
        });
        await command("python3", [releaseScript, "--request", releaseRequest, "--receipt", releaseReceipt]);
        expect(await json(releaseReceipt)).toMatchObject({ channel: input.channel, releaseVersion: input.releaseVersion, replayed: false });
        const distributionDocument = await json(distributionReceipt);
        return {
          archive: distributionDocument.archive.file,
          channelHeadUrl: `${publicOrigin}/${input.channel}/latest/channel-head.json`,
          contentMetadataFile: join(prepared, "documents/content-metadata.json"),
          releaseVersion: input.releaseVersion,
        };
      };

      const beta1 = await publish({
        channel: "betahyx",
        releaseVersion: "0.1.0-betahyx.1",
        shellVersion: "0.1.0",
        closure: baseClosure,
      });
      const installed = join(root, "installed");
      await mkdir(installed);
      await command("tar", ["-xzf", beta1.archive, "-C", installed]);
      const installRoot = join(installed, "nexu-terminal");
      await chmod(join(installRoot, "sh/terminal.sh"), 0o755);
      const store = join(root, "store");
      const feedbackFile = join(root, "feedback.jsonl");

      const first = await terminal(installRoot, store, "betahyx", "shared", "start", { attachmentId: "terminal-a", feedbackFile });
      const second = await terminal(installRoot, store, "betahyx", "shared", "start", { attachmentId: "terminal-b" });
      expect(first.result).toMatchObject({ state: "running", references: 1 });
      expect(second.result).toMatchObject({ instanceId: first.result.instanceId, references: 2 });
      expect((await terminal(installRoot, store, "betahyx", "shared", "heartbeat", { attachmentId: "terminal-b" })).result.references).toBe(2);

      const beta2 = await publish({
        channel: "betahyx",
        releaseVersion: "0.1.0-betahyx.2",
        shellVersion: "0.1.0",
        closure: Buffer.concat([baseClosure, Buffer.from("\n// local exact beta 2\n")]),
        previousContentMetadataFile: beta1.contentMetadataFile,
      });
      const prepared = await terminal(installRoot, store, "betahyx", "shared", "prepare-update", {
        channelHeadUrl: beta2.channelHeadUrl,
        activationSource: "silent-policy",
        feedbackFile,
      });
      expect(prepared.result).toMatchObject({ status: "prepared", authorized: true });
      const applied = await terminal(installRoot, store, "betahyx", "shared", "apply-update");
      expect(applied.result.generationId).not.toBe(first.result.generationId);

      await terminal(installRoot, store, "betahyx", "shell-update", "start", { attachmentId: "terminal-active" });
      expect((await terminal(installRoot, store, "betahyx", "shell-update", "shell-update-check")).result.snapshot.state).toBe("available");
      expect((await terminal(installRoot, store, "betahyx", "shell-update", "shell-update-download")).result.snapshot.state).toBe("ready");
      expect((await terminal(installRoot, store, "betahyx", "shell-update", "shell-update-install")).result).toMatchObject({ outcome: "blocked" });
      expect((await terminal(installRoot, store, "betahyx", "shell-update", "shell-update-later")).result.snapshot.state).toBe("ready");
      expect((await terminal(installRoot, store, "betahyx", "shell-update", "shell-update-force")).result.snapshot.state).toBe("handed-off");

      const beta3 = await publish({
        channel: "betahyx",
        releaseVersion: "0.1.0-betahyx.3",
        shellVersion: "0.2.0",
        closure: Buffer.concat([baseClosure, Buffer.from("\n// local exact beta 3\n")]),
        previousContentMetadataFile: beta2.contentMetadataFile,
      });
      expect((await terminal(installRoot, store, "betahyx", "shared", "prepare-update", { channelHeadUrl: beta3.channelHeadUrl })).result).toMatchObject({
        status: "shell-reinstall-required",
        minimumVersion: "0.2.0",
      });

      const preview = await publish({
        channel: "previewhyx",
        releaseVersion: "0.1.0-previewhyx.1",
        shellVersion: "0.1.0",
        closure: Buffer.concat([baseClosure, Buffer.from("\n// local exact preview\n")]),
      });
      expect((await terminal(installRoot, store, "previewhyx", "shared", "prepare-update", {
        channelHeadUrl: preview.channelHeadUrl,
        activationSource: "user-restart",
        feedbackFile,
      })).result).toMatchObject({ status: "prepared", authorized: true });
      expect((await terminal(installRoot, store, "previewhyx", "shared", "apply-update")).result.scope).toMatchObject({ channel: "previewhyx", namespace: "shared" });

      const feedback = (await readFile(feedbackFile, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
      expect(feedback).toEqual(expect.arrayContaining([
        expect.objectContaining({ phase: "node-verification", state: "complete" }),
        expect.objectContaining({ phase: "sync-planning", state: "complete" }),
        expect.objectContaining({ phase: "blob-download", state: "progress" }),
        expect.objectContaining({ phase: "closure-ready", state: "complete" }),
      ]));

      const latest = await fetch(beta3.channelHeadUrl);
      expect(await latest.json()).toMatchObject({ head: { channel: "betahyx", lanes: { content: { releaseVersion: beta3.releaseVersion }, terminal: { releaseVersion: beta3.releaseVersion } } } });
      expect(basename(beta1.archive)).toContain("0.1.0-betahyx.1");
    },
    240_000,
  );
});
