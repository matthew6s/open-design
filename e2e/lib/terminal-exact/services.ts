import type { ChildProcess } from "node:child_process";
import { join } from "node:path";

import { ExactProcessScope, startJsonProcess } from "./process.js";
import { type Json, workspaceRoot } from "./support.js";

export type ReleaseStorage = Readonly<{ bucket: string; endpointUrl: string }>;

export async function startReleaseStorage(scope: ExactProcessScope): Promise<ReleaseStorage> {
  const started = await startJsonProcess<ReleaseStorage & Json>(scope, {
    command: "pnpm",
    args: ["--silent", "--filter", "@open-design/tools-serve", "dev", "start", "release-storage", "--json", "--port", "0"],
    label: "tools-serve release-storage",
    timeoutMs: 15_000,
  });
  return started.value;
}

export async function startFixtureSidecar(
  scope: ExactProcessScope,
  installRoot: string,
  storeRoot: string,
): Promise<Readonly<{ child: ChildProcess; endpointUrl: string }>> {
  const started = await startJsonProcess<{ endpointUrl: string } & Json>(scope, {
    command: join(installRoot, "carrier/node/bin/node"),
    args: [
      join(installRoot, "runtime/fixture-sidecar.mjs"),
      "--store-root", storeRoot,
      "--standalone", join(installRoot, "runtime/standalone/index.mjs"),
      "--port", "0",
    ],
    label: "fixture Sidecar",
    timeoutMs: 10_000,
    cwd: workspaceRoot,
    env: { ...process.env, OD_FIXTURE_TRANSITION_LEASE_MS: "120" },
  });
  return { child: started.child, endpointUrl: started.value.endpointUrl };
}

export async function fixtureSidecarRequest(endpointUrl: string, message: Json): Promise<Json> {
  const response = await fetch(`${endpointUrl}/v1/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, ...message }),
  });
  const payload = await response.json() as Json;
  if (!response.ok || payload.ok !== true) throw new Error(payload.error?.message ?? `fixture Sidecar request failed: ${response.status}`);
  return payload.result;
}
