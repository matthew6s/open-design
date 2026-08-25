import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { terminalRoot, type TerminalNodeArchive } from "./carrier.js";
import { type ReleaseStorage } from "./services.js";
import { json, runCommand, sha256, type Json, workspaceRoot, writeJson } from "./support.js";

const packScript = join(workspaceRoot, ".github/scripts/pack.py");
const releaseScript = join(workspaceRoot, ".github/scripts/release.py");

export type PublishedRelease = Readonly<{
  archive: string;
  channelHeadUrl: string;
  contentMetadataFile: string;
  releaseVersion: string;
}>;

export type ExactReleaseInput = Readonly<{
  channel: "betahyx" | "previewhyx";
  releaseVersion: string;
  shellVersion: string;
  closure: Uint8Array;
  previousContentMetadataFile?: string;
}>;

export type ExactSceneProduct = Readonly<{
  releaseRoot: string;
  closureFile: string;
  directory: string;
  manifestFile: string;
  receiptFile: string;
}>;

export type ExactPreparedProduct = Readonly<{
  directory: string;
  receiptFile: string;
  contentMetadataFile: string;
  document: Json;
}>;

export type ExactDistributionProduct = Readonly<{
  directory: string;
  receiptFile: string;
  document: Json;
}>;

export type ExactPackedProduct = Readonly<{
  directory: string;
  receiptFile: string;
}>;

export class ExactReleasePublisher {
  private readonly publicOrigin: string;

  constructor(private readonly options: Readonly<{
    root: string;
    target: string;
    node: TerminalNodeArchive;
    storage: ReleaseStorage;
    sourceCommit: string;
    signingEnvironment: NodeJS.ProcessEnv;
  }>) {
    this.publicOrigin = `${options.storage.endpointUrl}/${options.storage.bucket}`;
  }

  async buildScene(input: ExactReleaseInput): Promise<ExactSceneProduct> {
    const releaseRoot = join(this.options.root, input.releaseVersion);
    const closureFile = join(releaseRoot, "closure.mjs");
    const scene = join(releaseRoot, "scene");
    await mkdir(releaseRoot, { recursive: true });
    await writeFile(closureFile, input.closure);

    const sceneRequest = join(releaseRoot, "scene-request.json");
    const sceneReceipt = join(releaseRoot, "scene-receipt.json");
    await writeJson(sceneRequest, {
      schemaVersion: 1,
      operation: "terminal.scene.build",
      target: this.options.target,
      shellVersion: input.shellVersion,
      node: {
        version: this.options.node.version,
        archiveFile: this.options.node.file,
        archiveSha256: this.options.node.sha256,
      },
      closureArtifactFile: closureFile,
      standaloneDirectory: join(workspaceRoot, "packages/standalone/dist"),
      sceneDirectory: scene,
    });
    await runCommand("sh", [join(terminalRoot, "sh/scene.sh"), "--request", sceneRequest, "--receipt", sceneReceipt]);
    return { releaseRoot, closureFile, directory: scene, manifestFile: join(scene, "scene.json"), receiptFile: sceneReceipt };
  }

  async prepareRelease(input: ExactReleaseInput, scene: ExactSceneProduct): Promise<ExactPreparedProduct> {
    const prepared = join(scene.releaseRoot, "prepared");
    const prepareRequest = join(scene.releaseRoot, "prepare-request.json");
    const prepareReceipt = join(prepared, "prepare-receipt.json");
    await writeJson(prepareRequest, {
      schemaVersion: 1,
      operation: "exact.prepare",
      channel: input.channel,
      releaseVersion: input.releaseVersion,
      sourceCommit: this.options.sourceCommit,
      publishedAt: "2026-08-24T14:00:00.000Z",
      standaloneVersion: "0.1.0",
      shellVersion: input.shellVersion,
      artifactBaseUrl: `${this.publicOrigin}/${input.channel}/${input.releaseVersion}`,
      closureArtifactFile: scene.closureFile,
      scenes: [{ target: this.options.target, sceneDirectory: scene.directory, sceneManifestSha256: sha256(await readFile(scene.manifestFile)) }],
      outputDirectory: prepared,
      ...(input.previousContentMetadataFile == null ? {} : { previousContentMetadataFile: input.previousContentMetadataFile }),
    });
    await runCommand("python3", [packScript, "--request", prepareRequest, "--receipt", prepareReceipt], { env: this.options.signingEnvironment });
    return {
      directory: prepared,
      receiptFile: prepareReceipt,
      contentMetadataFile: join(prepared, "documents/content-metadata.json"),
      document: await json(prepareReceipt),
    };
  }

  async buildDistribution(
    input: ExactReleaseInput,
    scene: ExactSceneProduct,
    prepared: ExactPreparedProduct,
  ): Promise<ExactDistributionProduct> {
    const distribution = join(scene.releaseRoot, "distribution");
    const distributionRequest = join(scene.releaseRoot, "distribution-request.json");
    const distributionReceipt = join(distribution, "distribution-receipt.json");
    await writeJson(distributionRequest, {
      schemaVersion: 1,
      operation: "terminal.distribution.build",
      target: this.options.target,
      sceneDirectory: scene.directory,
      sceneManifestSha256: sha256(await readFile(scene.manifestFile)),
      releaseDocumentsDirectory: join(prepared.directory, "documents"),
      trustFile: join(prepared.directory, "trust/keys.json"),
      release: {
        channel: input.channel,
        releaseVersion: input.releaseVersion,
        sourceCommit: prepared.document.sourceCommit,
        publishedAt: prepared.document.publishedAt,
        artifactBaseUrl: prepared.document.artifactBaseUrl,
      },
      outputDirectory: distribution,
    });
    await runCommand("sh", [join(terminalRoot, "sh/distribution.sh"), "--request", distributionRequest, "--receipt", distributionReceipt]);
    return { directory: distribution, receiptFile: distributionReceipt, document: await json(distributionReceipt) };
  }

  async finalizeRelease(
    scene: ExactSceneProduct,
    prepared: ExactPreparedProduct,
    distribution: ExactDistributionProduct,
  ): Promise<ExactPackedProduct> {
    const finalized = join(scene.releaseRoot, "finalized");
    const finalizeRequest = join(scene.releaseRoot, "finalize-request.json");
    const packReceipt = join(finalized, "pack-receipt.json");
    await writeJson(finalizeRequest, {
      schemaVersion: 1,
      operation: "exact.finalize",
      prepareReceipt: prepared.receiptFile,
      distributions: [{ receipt: distribution.receiptFile }],
      outputDirectory: finalized,
    });
    await runCommand("python3", [packScript, "--request", finalizeRequest, "--receipt", packReceipt], { env: this.options.signingEnvironment });
    return { directory: finalized, receiptFile: packReceipt };
  }

  async publishPacked(input: ExactReleaseInput, scene: ExactSceneProduct, packed: ExactPackedProduct): Promise<Json> {
    const releaseRequest = join(scene.releaseRoot, "release-request.json");
    const releaseReceipt = join(packed.directory, "release-receipt.json");
    await writeJson(releaseRequest, {
      schemaVersion: 1,
      operation: "exact.release",
      packReceipt: packed.receiptFile,
      endpointUrl: this.options.storage.endpointUrl,
      bucket: this.options.storage.bucket,
    });
    await runCommand("python3", [releaseScript, "--request", releaseRequest, "--receipt", releaseReceipt]);
    const released = await json(releaseReceipt);
    if (released.channel !== input.channel || released.releaseVersion !== input.releaseVersion || released.replayed !== false) {
      throw new Error(`exact release receipt mismatch for ${input.releaseVersion}`);
    }
    return released;
  }

  async publish(input: ExactReleaseInput): Promise<PublishedRelease> {
    const scene = await this.buildScene(input);
    const prepared = await this.prepareRelease(input, scene);
    const distribution = await this.buildDistribution(input, scene, prepared);
    const packed = await this.finalizeRelease(scene, prepared, distribution);
    await this.publishPacked(input, scene, packed);
    return {
      archive: distribution.document.archive.file,
      channelHeadUrl: `${this.publicOrigin}/${input.channel}/latest/channel-head.json`,
      contentMetadataFile: prepared.contentMetadataFile,
      releaseVersion: input.releaseVersion,
    };
  }
}
