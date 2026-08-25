import { describe, expect, it } from "vitest";

import {
  INITIAL_GENERATION_STATE,
  reduceGenerationState,
  validateGenerationState,
  type GenerationState,
  type GenerationStateCommand,
  type RuntimeBinding,
} from "../src/index.js";

const generations = ["a".repeat(64), "b".repeat(64)] as const;
const shells = [
  { type: "terminal", version: "0.1.0", digest: "c".repeat(64) },
  { type: "electron", version: "1.0.0", digest: "d".repeat(64) },
] as const;
const now = "2026-08-25T00:00:00.000Z";

function key(state: GenerationState): string {
  return JSON.stringify({ ...state, revision: 0, activationIntent: state.activationIntent == null ? null : { ...state.activationIntent, authorizedAt: now } });
}

function commands(state: GenerationState): GenerationStateCommand[] {
  const result: GenerationStateCommand[] = generations.map((generationId) => ({
    type: "prepare",
    expectedRevision: state.revision,
    generationId,
  }));
  if (state.prepared != null) {
    for (const source of ["initial-bootstrap", "repair", "silent-policy", "user-restart"] as const) {
      result.push({ type: "authorize", expectedRevision: state.revision, generationId: state.prepared, source, authorizedAt: now });
    }
    result.push({ type: "revoke-silent", expectedRevision: state.revision, generationId: state.prepared });
    if (state.activationIntent?.generationId === state.prepared) {
      for (const shell of shells) result.push({ type: "activate", expectedRevision: state.revision, generationId: state.prepared, shell });
    }
  }
  if (state.active != null) {
    for (const shell of shells) {
      result.push({
        type: "begin-attempt",
        expectedRevision: state.revision,
        binding: { generationId: state.active.generationId, shell },
      });
    }
  }
  if (state.attempt != null) {
    result.push({ type: "confirm", expectedRevision: state.revision, binding: state.attempt });
    result.push({ type: "rollback", expectedRevision: state.revision, binding: state.attempt });
  }
  return result;
}

function assertSafety(state: GenerationState): void {
  expect(() => validateGenerationState(state)).not.toThrow();
  if (state.activationIntent != null) expect(state.activationIntent.generationId).toBe(state.prepared);
  if (state.attempt != null) expect(state.attempt).toEqual(state.active);
  if (state.attempt == null && state.active != null) expect(state.active).toEqual(state.lastSuccessful);
}

describe("Standalone generation state algebra", () => {
  it("exhausts every finite control state while preserving safety invariants", () => {
    const pending: GenerationState[] = [INITIAL_GENERATION_STATE];
    const reached = new Map<string, GenerationState>();
    while (pending.length > 0) {
      const state = pending.shift()!;
      const stateKey = key(state);
      if (reached.has(stateKey)) continue;
      reached.set(stateKey, state);
      assertSafety(state);
      for (const command of commands(state)) {
        let next: GenerationState;
        try { next = reduceGenerationState(state, command); }
        catch { continue; }
        assertSafety(next);
        if (!reached.has(key(next))) pending.push(next);
      }
    }
    expect(reached.size).toBeGreaterThan(30);
  });

  it("rejects stale and wrong-generation commands instead of retargeting them", () => {
    const prepared = reduceGenerationState(INITIAL_GENERATION_STATE, {
      type: "prepare",
      expectedRevision: 0,
      generationId: generations[0],
    });
    expect(() => reduceGenerationState(prepared, {
      type: "authorize",
      expectedRevision: 0,
      generationId: generations[0],
      source: "silent-policy",
      authorizedAt: now,
    })).toThrow("stale generation state revision");
    expect(() => reduceGenerationState(prepared, {
      type: "authorize",
      expectedRevision: prepared.revision,
      generationId: generations[1],
      source: "silent-policy",
      authorizedAt: now,
    })).toThrow("prepared generation changed concurrently");
  });

  it("makes user authority absorbing for background grants and revocation", () => {
    let state = reduceGenerationState(INITIAL_GENERATION_STATE, { type: "prepare", expectedRevision: 0, generationId: generations[0] });
    state = reduceGenerationState(state, { type: "authorize", expectedRevision: state.revision, generationId: generations[0], source: "user-restart", authorizedAt: now });
    for (const source of ["initial-bootstrap", "repair", "silent-policy"] as const) {
      state = reduceGenerationState(state, { type: "authorize", expectedRevision: state.revision, generationId: generations[0], source, authorizedAt: now });
    }
    state = reduceGenerationState(state, { type: "prepare", expectedRevision: state.revision, generationId: generations[0] });
    state = reduceGenerationState(state, { type: "revoke-silent", expectedRevision: state.revision, generationId: generations[0] });
    expect(state.activationIntent?.source).toBe("user-restart");
  });

  it("rolls every unfinished attempt back only to its last health-proved binding", () => {
    const oldBinding: RuntimeBinding = { generationId: generations[0], shell: shells[0] };
    let state = reduceGenerationState(INITIAL_GENERATION_STATE, { type: "prepare", expectedRevision: 0, generationId: generations[0] });
    state = reduceGenerationState(state, { type: "authorize", expectedRevision: state.revision, generationId: generations[0], source: "initial-bootstrap", authorizedAt: now });
    state = reduceGenerationState(state, { type: "activate", expectedRevision: state.revision, generationId: generations[0], shell: shells[0] });
    state = reduceGenerationState(state, { type: "begin-attempt", expectedRevision: state.revision, binding: oldBinding });
    state = reduceGenerationState(state, { type: "confirm", expectedRevision: state.revision, binding: oldBinding });
    state = reduceGenerationState(state, { type: "prepare", expectedRevision: state.revision, generationId: generations[1] });
    state = reduceGenerationState(state, { type: "authorize", expectedRevision: state.revision, generationId: generations[1], source: "silent-policy", authorizedAt: now });
    state = reduceGenerationState(state, { type: "activate", expectedRevision: state.revision, generationId: generations[1], shell: shells[0] });
    const failed = state.attempt!;
    state = reduceGenerationState(state, { type: "rollback", expectedRevision: state.revision, binding: failed });
    expect(state).toMatchObject({ active: oldBinding, attempt: null, lastSuccessful: oldBinding, prepared: null, activationIntent: null });
  });

  it("permits exactly one recovery launch before the attempt budget is exhausted", () => {
    const candidate: RuntimeBinding = { generationId: generations[0], shell: shells[0] };
    let state = reduceGenerationState(INITIAL_GENERATION_STATE, { type: "prepare", expectedRevision: 0, generationId: generations[0] });
    state = reduceGenerationState(state, { type: "authorize", expectedRevision: state.revision, generationId: generations[0], source: "initial-bootstrap", authorizedAt: now });
    state = reduceGenerationState(state, { type: "activate", expectedRevision: state.revision, generationId: generations[0], shell: shells[0] });
    state = reduceGenerationState(state, { type: "begin-attempt", expectedRevision: state.revision, binding: candidate });
    expect(state.attemptLaunches).toBe(1);
    state = reduceGenerationState(state, { type: "begin-attempt", expectedRevision: state.revision, binding: candidate });
    expect(state.attemptLaunches).toBe(2);
    expect(() => reduceGenerationState(state, { type: "begin-attempt", expectedRevision: state.revision, binding: candidate }))
      .toThrow("activation attempt retry budget is exhausted");
  });
});
