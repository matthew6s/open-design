import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const workspaceRoot = resolve(import.meta.dirname, "../../..");

export type Json = Record<string, any>;

export function canonical(value: unknown): Buffer {
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

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function json(path: string): Promise<Json> {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, canonical(value));
}

export async function runCommand(
  commandName: string,
  args: readonly string[],
  options: Readonly<{ cwd?: string; env?: NodeJS.ProcessEnv }> = {},
): Promise<string> {
  const result = await execFileAsync(commandName, [...args], {
    cwd: options.cwd ?? workspaceRoot,
    env: options.env ?? process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout;
}
