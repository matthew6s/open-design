import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export async function withStandaloneMaintenanceLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const lockRoot = join(root, "locks");
  const lockPath = join(lockRoot, "maintenance.lock");
  await mkdir(lockRoot, { recursive: true });
  const owner = `${JSON.stringify({ pid: process.pid, token: randomUUID() })}\n`;
  let handle: FileHandle | undefined;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(owner);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await stat(lockPath).catch(() => null);
      if (info != null && Date.now() - info.mtimeMs > 120_000) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      await delay(20);
    }
  }
  if (handle == null) throw new Error("Standalone maintenance transaction timed out");
  try {
    return await operation();
  } finally {
    await handle.close();
    const current = await readFile(lockPath, "utf8").catch(() => null);
    if (current === owner) await unlink(lockPath).catch(() => undefined);
  }
}
