import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ExactProcessScope,
  ExactReleasePublisher,
  TerminalCarrier,
  ensureTerminalNodeArchive,
  fixtureSidecarRequest,
  json,
  runCommand,
  sha256,
  startFixtureSidecar,
  startReleaseStorage,
  workspaceRoot,
} from "@/terminal-exact/index";

const enabled = process.env.OD_EXACT_LOCAL_E2E === "1";
let scope: ExactProcessScope | undefined;

describe("local exact Terminal release line", () => {
  afterEach(async () => {
    await scope?.dispose();
    scope = undefined;
  });

  it.skipIf(!enabled || process.platform !== "darwin" || !new Set(["arm64", "x64"]).has(process.arch))(
    "[P1] publishes and consumes isolated exact channels through one tools-serve instance",
    async () => {
      const processScope = new ExactProcessScope();
      scope = processScope;
      const root = await processScope.temporaryRoot("exact-terminal-local-");
      const target = `darwin-${process.arch}`;
      const node = await ensureTerminalNodeArchive(target);
      const storage = await startReleaseStorage(processScope);
      const sourceCommit = (await runCommand("git", ["rev-parse", "HEAD"])).trim();
      const keys = generateKeyPairSync("ed25519");
      const signingEnvironment = {
        ...process.env,
        OD_EXACT_SIGNING_KEY_ID: "local-exact-e2e",
        OD_EXACT_ED25519_PRIVATE_KEY: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      };

      await runCommand("pnpm", ["--filter", "@open-design/standalone", "build"]);
      await runCommand("pnpm", ["--filter", "@open-design/closure", "build"]);
      const baseClosure = await readFile(join(workspaceRoot, "apps/closure/dist/index.mjs"));
      const publisher = new ExactReleasePublisher({ root, target, node, storage, sourceCommit, signingEnvironment });

      const beta1 = await publisher.publish({
        channel: "betahyx",
        releaseVersion: "0.1.0-betahyx.1",
        shellVersion: "0.1.0",
        closure: baseClosure,
      });
      const installed = join(root, "installed");
      await mkdir(installed);
      await runCommand("tar", ["-xzf", beta1.archive, "-C", installed]);
      const installRoot = join(installed, "nexu-terminal");
      await chmod(join(installRoot, "sh/terminal.sh"), 0o755);
      const store = join(root, "store");
      const feedbackFile = join(root, "feedback.jsonl");
      const initialSidecar = await startFixtureSidecar(processScope, installRoot, store);
      let sidecarEndpointUrl = initialSidecar.endpointUrl;
      const carrier = new TerminalCarrier(installRoot, store, sidecarEndpointUrl);

      const beta2 = await publisher.publish({
        channel: "betahyx",
        releaseVersion: "0.1.0-betahyx.2",
        shellVersion: "0.1.0",
        closure: Buffer.concat([baseClosure, Buffer.from("\n// local exact beta 2\n")]),
        previousContentMetadataFile: beta1.contentMetadataFile,
      });
      const prebootPrepared = await carrier.invoke("betahyx", "shared", "prepare-update", {
        channelHeadUrl: beta2.channelHeadUrl,
        activationPolicy: "observe",
      });
      expect(prebootPrepared.result).toMatchObject({ status: "prepared", authorized: false });

      const first = await carrier.invoke("betahyx", "shared", "start", { attachmentId: "terminal-a", feedbackFile });
      const second = await carrier.invoke("betahyx", "shared", "start", { attachmentId: "terminal-b" });
      expect(first.result).toMatchObject({ state: "running", references: 1 });
      expect(second.result).toMatchObject({ instanceId: first.result.instanceId, references: 2 });
      expect(await json(join(store, "channels/betahyx/generations", `${first.result.generationId}.json`)))
        .toMatchObject({ releaseVersion: beta1.releaseVersion });
      await expect(carrier.invoke("betahyx", "shared", "heartbeat", { attachmentId: "terminal-b" })).rejects.toThrow();
      expect((await carrier.invoke("betahyx", "shared", "heartbeat", {
        attachmentId: "terminal-b",
        attachmentCapability: second.result.attachmentCapability,
      })).result.references).toBe(2);
      await Promise.all(Array.from(
        { length: 8 },
        () => carrier.invoke("betahyx", "updater-concurrency", "shell-update-check"),
      ));
      expect((await carrier.invoke("betahyx", "updater-concurrency", "shell-update-status")).result)
        .toMatchObject({ schemaVersion: 3, revision: 16, state: "available" });
      expect(await fixtureSidecarRequest(sidecarEndpointUrl, {
        domain: "maintenance",
        operation: "sweep-if-idle",
        scope: { channel: "betahyx", namespace: "shared" },
      })).toMatchObject({ status: "deferred", reason: "occupied" });

      const prepared = await carrier.invoke("betahyx", "shared", "prepare-update", {
        channelHeadUrl: beta2.channelHeadUrl,
        activationPolicy: "authorize-silent",
        feedbackFile,
      });
      expect(prepared.result).toMatchObject({ status: "prepared", authorized: true });
      const deferred = await carrier.invoke("betahyx", "shared", "apply-update");
      expect(deferred.result).toMatchObject({ status: "blocked", reason: "occupied" });
      const applied = await carrier.invoke("betahyx", "shared", "apply-update-force");
      expect(applied.result).toMatchObject({ status: "applied" });
      expect(applied.result.lifecycle.generationId).not.toBe(first.result.generationId);
      await carrier.invoke("betahyx", "shared", "release", {
        attachmentId: "terminal-control",
        attachmentCapability: applied.result.lifecycle.attachmentCapability,
      });
      const orphan = Buffer.from("orphaned exact fixture blob");
      const orphanDigest = sha256(orphan);
      await mkdir(join(store, "blobs/sha256"), { recursive: true });
      await writeFile(join(store, "blobs/sha256", orphanDigest), orphan);
      const maintenance = await fixtureSidecarRequest(sidecarEndpointUrl, {
        domain: "maintenance",
        operation: "sweep-if-idle",
        scope: { channel: "betahyx", namespace: "shared" },
        options: { maxDurationMs: 10_000, maxEntries: 10 },
      });
      expect(maintenance).toMatchObject({ status: "complete" });
      expect(maintenance.sweep.discardedBlobs).toBeGreaterThanOrEqual(1);
      expect(maintenance.cleanup.removed).toBeGreaterThanOrEqual(1);

      await carrier.invoke("betahyx", "shell-update", "start", { attachmentId: "terminal-active" });
      expect((await carrier.invoke("betahyx", "shell-update", "shell-update-check")).result.snapshot.state).toBe("available");
      expect((await carrier.invoke("betahyx", "shell-update", "shell-update-download")).result.snapshot.state).toBe("ready");
      expect((await carrier.invoke("betahyx", "shell-update", "shell-update-install")).result).toMatchObject({ outcome: "blocked" });
      expect((await carrier.invoke("betahyx", "shell-update", "shell-update-later")).result.snapshot.state).toBe("ready");
      expect((await carrier.invoke("betahyx", "shell-update", "shell-update-force")).result.snapshot.state).toBe("handed-off");

      await carrier.invoke("betahyx", "crash-recovery", "start", { attachmentId: "before-crash" });
      const abandoned = await fixtureSidecarRequest(sidecarEndpointUrl, {
        domain: "lifecycle",
        operation: "begin-transition",
        scope: { channel: "betahyx", namespace: "crash-recovery" },
        kind: "shell-install",
        options: { ownerShellType: "electron", force: true },
      });
      expect(abandoned.state).toBe("acquired");
      await fetch(`${sidecarEndpointUrl}/v1/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, fault: "crash" }),
      });
      await new Promise<void>((resolveExit) => initialSidecar.child.once("exit", () => resolveExit()));
      const recoveredSidecar = await startFixtureSidecar(processScope, installRoot, store);
      sidecarEndpointUrl = recoveredSidecar.endpointUrl;
      carrier.useSidecar(sidecarEndpointUrl);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 160));
      expect((await carrier.invoke("betahyx", "crash-recovery", "start", { attachmentId: "after-crash" })).result).toMatchObject({ state: "running", references: 2 });

      const beta3 = await publisher.publish({
        channel: "betahyx",
        releaseVersion: "0.1.0-betahyx.3",
        shellVersion: "0.2.0",
        closure: Buffer.concat([baseClosure, Buffer.from("\n// local exact beta 3\n")]),
        previousContentMetadataFile: beta2.contentMetadataFile,
      });
      const shellUpdate = (await carrier.invoke("betahyx", "shared", "prepare-update", { channelHeadUrl: beta3.channelHeadUrl, activationPolicy: "observe" })).result;
      expect(shellUpdate).toMatchObject({
        state: "update-required",
        minimumVersion: "0.2.0",
        snapshot: {
          state: "ready",
          progress: { completed: expect.any(Number), total: expect.any(Number) },
          handoff: { releaseVersion: beta3.releaseVersion, target, interaction: "restart-and-install" },
        },
      });
      expect(sha256(await readFile(shellUpdate.snapshot.handoff.artifact.path))).toBe(shellUpdate.snapshot.handoff.artifact.sha256);

      const handedOff = await carrier.invoke("betahyx", "shared", "shell-update-force");
      expect(handedOff.result).toMatchObject({ outcome: "accepted", snapshot: { state: "handed-off" } });
      const oldShellConfirmation = await carrier.invoke("betahyx", "shared", "shell-update-confirm");
      expect(oldShellConfirmation.result).toMatchObject({
        outcome: "failed",
        snapshot: { state: "handed-off", error: { code: "installed-shell-mismatch" } },
      });

      await new Promise((resolveDelay) => setTimeout(resolveDelay, 160));
      const beta3Installed = join(root, "installed-beta3");
      await mkdir(beta3Installed);
      await runCommand("tar", ["-xzf", shellUpdate.snapshot.handoff.artifact.path, "-C", beta3Installed]);
      const beta3InstallRoot = join(beta3Installed, "nexu-terminal");
      await chmod(join(beta3InstallRoot, "sh/terminal.sh"), 0o755);
      const replacementCarrier = new TerminalCarrier(beta3InstallRoot, store, sidecarEndpointUrl);
      const replacement = await replacementCarrier.invoke("betahyx", "shared", "start", { attachmentId: "terminal-v2" });
      expect(replacement.result).toMatchObject({ state: "running", references: 1 });
      const installedConfirmation = await replacementCarrier.invoke("betahyx", "shared", "shell-update-confirm");
      expect(installedConfirmation.result).toMatchObject({ outcome: "accepted", snapshot: { state: "installed" } });
      expect((await replacementCarrier.invoke("betahyx", "shared", "shell-update-confirm")).result)
        .toMatchObject({ outcome: "accepted", snapshot: { state: "installed", revision: installedConfirmation.result.snapshot.revision } });
      expect((await carrier.invoke("betahyx", "shared", "shell-update-confirm")).result)
        .toMatchObject({ outcome: "failed", snapshot: { state: "installed", revision: installedConfirmation.result.snapshot.revision } });
      await replacementCarrier.invoke("betahyx", "shared", "release", {
        attachmentId: "terminal-v2",
        attachmentCapability: replacement.result.attachmentCapability,
      });

      const preview = await publisher.publish({
        channel: "previewhyx",
        releaseVersion: "0.1.0-previewhyx.1",
        shellVersion: "0.1.0",
        closure: Buffer.concat([baseClosure, Buffer.from("\n// local exact preview\n")]),
      });
      expect((await carrier.invoke("previewhyx", "shared", "prepare-update", {
        channelHeadUrl: preview.channelHeadUrl,
        activationPolicy: "authorize-user",
        feedbackFile,
      })).result).toMatchObject({ status: "prepared", authorized: true });
      expect((await carrier.invoke("previewhyx", "shared", "apply-update")).result.lifecycle.scope).toMatchObject({ channel: "previewhyx", namespace: "shared" });

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
