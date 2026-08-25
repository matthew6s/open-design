import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as standalone from "@open-design/standalone";
import { afterEach, describe, expect, it } from "vitest";

import { TerminalExactSidecarHandlers } from "@/terminal-exact/sidecar/handlers";
import { ExactProcessScope, fixtureSidecarRequest, startFixtureSidecar, workspaceRoot } from "@/terminal-exact/index";

const roots: string[] = [];
const processScopes: ExactProcessScope[] = [];

afterEach(async () => {
  await Promise.all(processScopes.splice(0).map(async (scope) => await scope.dispose()));
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { force: true, recursive: true })));
});

async function fixture(): Promise<TerminalExactSidecarHandlers> {
  const root = await mkdtemp(join(tmpdir(), "terminal-exact-sidecar-handlers-"));
  roots.push(root);
  return new TerminalExactSidecarHandlers(root, standalone, { transitionLeaseDurationMs: 30_000 });
}

const scope = { channel: "betahyx", namespace: "shared" } as const;
const generation = { id: "a".repeat(64) };
const terminal = {
  type: "terminal",
  version: "0.1.0",
  buildHash: "b".repeat(64),
  digest: "c".repeat(64),
};

describe("Terminal exact Sidecar business handlers", () => {
  it("shares one logical instance while keeping attachment capabilities private", async () => {
    const handlers = await fixture();
    const first = await handlers.request({
      schemaVersion: 1,
      domain: "lifecycle",
      operation: "start",
      scope,
      generation,
      attachment: { id: "terminal-a", shell: terminal },
    }) as Record<string, any>;
    const second = await handlers.request({
      schemaVersion: 1,
      domain: "lifecycle",
      operation: "start",
      scope,
      generation,
      attachment: { id: "terminal-b", shell: terminal },
    }) as Record<string, any>;

    expect(first).toMatchObject({ state: "running", references: 1, attachmentCapability: expect.any(String) });
    expect(second).toMatchObject({ instanceId: first.instanceId, references: 2, attachmentCapability: expect.any(String) });
    await expect(handlers.request({
      schemaVersion: 1,
      domain: "lifecycle",
      operation: "heartbeat",
      scope,
      attachment: { id: "terminal-b", shell: terminal },
      attachmentCapability: first.attachmentCapability,
    })).rejects.toMatchObject({ code: "attachment-capability-required" });
    await expect(handlers.request({
      schemaVersion: 1,
      domain: "maintenance",
      operation: "sweep-if-idle",
      scope,
    })).resolves.toMatchObject({ status: "deferred", reason: "occupied" });
  });

  it("does not let a transition token cross its channel and namespace scope", async () => {
    const handlers = await fixture();
    const acquired = await handlers.request({
      schemaVersion: 1,
      domain: "lifecycle",
      operation: "begin-transition",
      scope,
      kind: "shell-install",
      options: { ownerShellType: "electron", force: true },
    }) as Record<string, any>;

    await expect(handlers.request({
      schemaVersion: 1,
      domain: "lifecycle",
      operation: "transition",
      scope: { channel: "previewhyx", namespace: "shared" },
      token: acquired.transition.token,
      action: "force-stop",
    })).rejects.toThrow("transition scope mismatch");
  });

  it("keeps the HTTP process host outside the Terminal distribution", async () => {
    const processes = new ExactProcessScope();
    processScopes.push(processes);
    const storeRoot = await processes.temporaryRoot("terminal-exact-sidecar-host-");
    const host = await startFixtureSidecar(processes, {
      standalonePath: join(workspaceRoot, "packages/standalone/src/index.ts"),
      storeRoot,
    });

    await expect(fixtureSidecarRequest(host.endpointUrl, {
      domain: "lifecycle",
      operation: "status",
      scope,
    })).resolves.toMatchObject({ state: "stopped", references: 0 });
  });
});
