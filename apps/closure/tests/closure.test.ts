import { describe, expect, it } from "vitest";

import { CLOSURE_FIXTURE_COMPONENT, createClosureFixtureContribution, prepareClosureShellUpdate } from "../src/index.js";
import closureFixture from "../src/fixture.js";

describe("Closure cold-start fixture", () => {
  it("declares an intentionally Web/daemon-free content slot", () => {
    expect(closureFixture).toEqual({ schemaVersion: 1, capability: "cold-start-lifecycle-fixture", web: false, daemon: false });
    const bytes = Buffer.from("fixture");
    expect(createClosureFixtureContribution({ artifactUrl: "https://example.invalid/fixture.mjs", artifactBytes: bytes })).toMatchObject({
      id: CLOSURE_FIXTURE_COMPONENT,
      sync: true,
      blob: { size: bytes.byteLength, mediaType: "text/javascript" },
      materialization: { type: "file", entrypoint: "fixture.mjs" },
    });
  });

  it("drives a Shell-owned updater through check and download when the Closure floor is not met", async () => {
    let revision = 0;
    let state: "idle" | "available" | "ready" = "idle";
    const snapshots: string[] = [];
    const updater = {
      shellType: "electron",
      readSnapshot: async () => ({ schemaVersion: 2 as const, revision, shellType: "electron", state, actions: [], blockedBy: [] }),
      waitForChange: async () => ({ schemaVersion: 2 as const, revision, shellType: "electron", state, actions: [], blockedBy: [] }),
      invoke: async (action: string) => {
        revision += 1;
        state = action === "check" ? "available" : "ready";
        return { outcome: "accepted" as const, snapshot: { schemaVersion: 2 as const, revision, shellType: "electron", state, actions: [], blockedBy: [], ...(state === "ready" ? { progress: { completed: 2, total: 2 } } : {}) } };
      },
      confirmInstalled: async () => ({ outcome: "unsupported" as const, snapshot: { schemaVersion: 2 as const, revision, shellType: "electron", state, actions: [], blockedBy: [] } }),
    };
    await expect(prepareClosureShellUpdate({
      requirement: { type: "electron", minVersion: "2.0.0", buildHash: "b".repeat(64) },
      shell: { type: "electron", version: "1.0.0", digest: "a".repeat(64) },
      updater,
      onSnapshot: (snapshot) => { snapshots.push(snapshot.state); },
    })).resolves.toMatchObject({ state: "update-required", minimumVersion: "2.0.0", snapshot: { state: "ready", progress: { completed: 2, total: 2 } } });
    expect(snapshots).toEqual(["idle", "available", "ready"]);
  });
});
