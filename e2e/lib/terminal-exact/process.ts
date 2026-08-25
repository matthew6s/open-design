import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Json, workspaceRoot } from "./support.js";

export class ExactProcessScope {
  readonly children: ChildProcess[] = [];
  readonly roots: string[] = [];

  async temporaryRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    this.roots.push(root);
    return root;
  }

  track(child: ChildProcess): ChildProcess {
    this.children.push(child);
    return child;
  }

  async dispose(): Promise<void> {
    for (const child of this.children.splice(0)) child.kill();
    await Promise.all(this.roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  }
}

export async function startJsonProcess<T extends Json>(
  scope: ExactProcessScope,
  input: Readonly<{
    command: string;
    args: readonly string[];
    label: string;
    timeoutMs: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  }>,
): Promise<Readonly<{ child: ChildProcess; value: T }>> {
  const child = scope.track(spawn(input.command, [...input.args], {
    cwd: input.cwd ?? workspaceRoot,
    env: input.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  }));
  return new Promise((resolveStart, rejectStart) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectStart(error);
    };
    const timeout = setTimeout(() => fail(new Error(`${input.label} timed out: ${stderr}`)), input.timeoutMs);
    child.stderr?.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.stdout?.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith("{"));
      if (line == null || settled) return;
      try {
        const value = JSON.parse(line) as T;
        settled = true;
        clearTimeout(timeout);
        resolveStart({ child, value });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.once("error", (error) => fail(error));
    child.once("exit", (code) => fail(new Error(`${input.label} exited ${code}: ${stderr}`)));
  });
}
