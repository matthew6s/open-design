import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { json, runCommand, sha256, type Json, workspaceRoot } from "./support.js";

export const terminalRoot = join(workspaceRoot, "shells/terminal");

export type TerminalNodeArchive = Readonly<{ file: string; sha256: string; version: string }>;
export type TerminalInvokeOptions = Readonly<{
  activationPolicy?: string;
  attachmentCapability?: string;
  attachmentId?: string;
  channelHeadUrl?: string;
  feedbackFile?: string;
}>;

export async function ensureTerminalNodeArchive(target: string): Promise<TerminalNodeArchive> {
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

export class TerminalCarrier {
  constructor(
    readonly installRoot: string,
    readonly storeRoot: string,
    private sidecarEndpointUrl: string,
  ) {}

  useSidecar(endpointUrl: string): void {
    this.sidecarEndpointUrl = endpointUrl;
  }

  async invoke(
    channel: string,
    namespace: string,
    operation: string,
    options: TerminalInvokeOptions = {},
  ): Promise<Json> {
    const args = [
      join(this.installRoot, "sh/terminal.sh"),
      "--root", this.installRoot,
      "--store-root", this.storeRoot,
      "--channel", channel,
      "--namespace", namespace,
      "--operation", operation,
      ...(options.attachmentId == null ? [] : ["--attachment-id", options.attachmentId]),
      ...(options.attachmentCapability == null ? [] : ["--attachment-capability", options.attachmentCapability]),
      ...(options.channelHeadUrl == null ? [] : ["--channel-head-url", options.channelHeadUrl]),
      ...(options.activationPolicy == null ? [] : ["--activation-policy", options.activationPolicy]),
      ...(options.feedbackFile == null ? [] : ["--feedback", options.feedbackFile]),
    ];
    return JSON.parse(await runCommand("sh", args, {
      env: { ...process.env, OD_TERMINAL_FIXTURE_SIDECAR_URL: this.sidecarEndpointUrl },
    }));
  }
}
