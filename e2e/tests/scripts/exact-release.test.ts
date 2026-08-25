import { execFile, spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const workspaceRoot = resolve(import.meta.dirname, "../../..");
const packScript = join(workspaceRoot, ".github/scripts/pack.py");
const releaseScript = join(workspaceRoot, ".github/scripts/release.py");
const roots: string[] = [];
const processes: ChildProcess[] = [];

function canonical(value: unknown): Buffer {
  const normalized = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalized);
    if (input != null && typeof input === "object") {
      return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, normalized(child)]));
    }
    return input;
  };
  return Buffer.from(`${JSON.stringify(normalized(value))}\n`);
}

async function json(path: string): Promise<any> { return JSON.parse(await readFile(path, "utf8")); }
async function writeJson(path: string, value: unknown): Promise<void> { await writeFile(path, canonical(value)); }

afterEach(async () => {
  for (const process of processes.splice(0)) process.kill();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function startReleaseStorage(): Promise<{ bucket: string; endpointUrl: string }> {
  const child = spawn("pnpm", ["--silent", "--filter", "@open-design/tools-serve", "dev", "start", "release-storage", "--json", "--port", "0"], { cwd: workspaceRoot, stdio: ["ignore", "pipe", "pipe"] });
  processes.push(child);
  return new Promise((resolveStart, rejectStart) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => rejectStart(new Error(`tools-serve release storage timed out: ${stderr}`)), 10_000);
    child.stderr?.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.stdout?.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith("{"));
      if (line == null) return;
      clearTimeout(timeout);
      resolveStart(JSON.parse(line));
    });
    child.once("exit", (code) => { clearTimeout(timeout); rejectStart(new Error(`tools-serve release storage exited ${code}: ${stderr}`)); });
  });
}

describe("exact release scripts", () => {
  it("prepares signed content, derives the Shell floor, and finalizes native sidecars", async () => {
    const root = await mkdtemp(join(tmpdir(), "exact-pack-")); roots.push(root);
    const keys = generateKeyPairSync("ed25519");
    const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const env = { ...process.env, OD_EXACT_SIGNING_KEY_ID: "fixture", OD_EXACT_ED25519_PRIVATE_KEY: privateKey };
    const closure = join(root, "closure.mjs");
    await writeFile(closure, "export default 'closure';\n");
    const closureDigest = (await import("node:crypto")).createHash("sha256").update(await readFile(closure)).digest("hex");
    const scenes = [];
    for (const [target, buildHash] of [["darwin-arm64", "a".repeat(64)], ["win32-x64", "b".repeat(64)]] as const) {
      const directory = join(root, `scene-${target}`);
      await mkdir(directory);
      const manifest = { schemaVersion: 1, target, shellVersion: "0.1.0", shellBuildHash: buildHash, closure: { sha256: closureDigest } };
      const manifestFile = join(directory, "scene.json");
      await writeJson(manifestFile, manifest);
      const digest = (await import("node:crypto")).createHash("sha256").update(await readFile(manifestFile)).digest("hex");
      scenes.push({ target, sceneDirectory: directory, sceneManifestSha256: digest });
    }
    const prepareRequest = join(root, "prepare-request.json");
    const prepareReceipt = join(root, "prepare-receipt.json");
    await writeJson(prepareRequest, {
      schemaVersion: 1,
      operation: "exact.prepare",
      channel: "betahyx",
      releaseVersion: "0.1.0-betahyx.1",
      sourceCommit: "1".repeat(40),
      publishedAt: "2026-08-24T00:00:00.000Z",
      standaloneVersion: "0.1.0",
      shellVersion: "0.1.0",
      artifactBaseUrl: "https://releases.invalid/betahyx/0.1.0-betahyx.1",
      closureArtifactFile: closure,
      scenes,
      outputDirectory: join(root, "prepared"),
    });
    await execFileAsync("python3", [packScript, "--request", prepareRequest, "--receipt", prepareReceipt], { cwd: workspaceRoot, env });
    const prepared = await json(prepareReceipt);
    expect(prepared).toMatchObject({ operation: "exact.prepare", minimumShellVersion: "0.1.0", scenes: [{ target: "darwin-arm64" }, { target: "win32-x64" }] });
    const content = await json(prepared.contentMetadata.file);
    expect(content.metadata.shellRequirements).toEqual([{ type: "terminal", minVersion: "0.1.0", buildHash: prepared.shellBuildHash }]);
    expect(content.signatures).toHaveLength(1);
    expect(verify(null, canonical(content.metadata), keys.publicKey, Buffer.from(content.signatures[0].value, "base64"))).toBe(true);

    const distributions = [];
    for (const target of ["darwin-arm64", "win32-x64"]) {
      const archive = join(root, `nexu-terminal-${target}-0.1.0-betahyx.1.${target.startsWith("win32") ? "zip" : "tar.gz"}`);
      await writeFile(archive, `distribution:${target}`);
      const bytes = await readFile(archive);
      const receipt = join(root, `${target}-distribution.json`);
      await writeJson(receipt, {
        schemaVersion: 1,
        operation: "terminal.distribution.build",
        target,
        manifestSha256: "c".repeat(64),
        archive: {
          file: archive,
          sha256: (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex"),
          size: bytes.byteLength,
          mediaType: target.startsWith("win32") ? "application/zip" : "application/gzip",
        },
      });
      distributions.push({ receipt });
    }
    const finalizeRequest = join(root, "finalize-request.json");
    const packReceipt = join(root, "pack-receipt.json");
    await writeJson(finalizeRequest, { schemaVersion: 1, operation: "exact.finalize", prepareReceipt, distributions, outputDirectory: join(root, "final") });
    await execFileAsync("python3", [packScript, "--request", finalizeRequest, "--receipt", packReceipt], { cwd: workspaceRoot, env });
    const packed = await json(packReceipt);
    const shell = await json(packed.terminalMetadataFile);
    const head = await json(packed.channelHeadFile);
    expect(shell.document.distributions).toEqual([
      expect.objectContaining({ target: "darwin-arm64", updater: { protocol: "standalone-shell-updater-v2", handler: "fixture-v2", interaction: "restart-and-install" } }),
      expect.objectContaining({ target: "win32-x64" }),
    ]);
    expect(head.head).toMatchObject({ channel: "betahyx", lanes: { content: { releaseVersion: "0.1.0-betahyx.1" }, terminal: { releaseVersion: "0.1.0-betahyx.1" } } });
    expect(verify(null, canonical(shell.document), keys.publicKey, Buffer.from(shell.signatures[0].value, "base64"))).toBe(true);
    expect(verify(null, canonical(head.head), keys.publicKey, Buffer.from(head.signatures[0].value, "base64"))).toBe(true);

    const storage = await startReleaseStorage();
    const releaseRequest = join(root, "release-request.json");
    const releaseReceipt = join(root, "release-receipt.json");
    await writeJson(releaseRequest, { schemaVersion: 1, operation: "exact.release", packReceipt, endpointUrl: storage.endpointUrl, bucket: storage.bucket });
    await execFileAsync("python3", [releaseScript, "--request", releaseRequest, "--receipt", releaseReceipt], { cwd: workspaceRoot });
    expect(await json(releaseReceipt)).toMatchObject({ operation: "exact.release", channel: "betahyx", releaseVersion: "0.1.0-betahyx.1", replayed: false });
    const latest = await fetch(`${storage.endpointUrl}/${storage.bucket}/betahyx/latest/channel-head.json`);
    expect(latest.ok).toBe(true);
    expect(await latest.json()).toMatchObject({ head: { channel: "betahyx", lanes: { content: {}, terminal: {} } } });
    await execFileAsync("python3", [releaseScript, "--request", releaseRequest, "--receipt", releaseReceipt], { cwd: workspaceRoot });
    expect(await json(releaseReceipt)).toMatchObject({ replayed: true });
  });
});
