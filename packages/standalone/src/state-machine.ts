import { validateShellIdentity, type StandaloneShellIdentity } from "./protocol.js";

export const STANDALONE_GENERATION_STATE_SCHEMA = 3 as const;

export type RuntimeBinding = Readonly<{ generationId: string; shell: StandaloneShellIdentity }>;
export type ActivationSource = "initial-bootstrap" | "repair" | "silent-policy" | "user-restart";
export type UpdateActivationPolicy = "observe" | "authorize-silent" | "authorize-user" | "revoke-silent";
export type ActivationIntent = Readonly<{ generationId: string; source: ActivationSource; authorizedAt: string }>;
export type GenerationState = Readonly<{
  schemaVersion: typeof STANDALONE_GENERATION_STATE_SCHEMA;
  revision: number;
  prepared: string | null;
  activationIntent: ActivationIntent | null;
  attempt: RuntimeBinding | null;
  attemptLaunches: number | null;
  active: RuntimeBinding | null;
  lastSuccessful: RuntimeBinding | null;
}>;

export type GenerationStateCommand =
  | Readonly<{ type: "prepare"; expectedRevision: number; generationId: string }>
  | Readonly<{ type: "authorize"; expectedRevision: number; generationId: string; source: ActivationSource; authorizedAt: string }>
  | Readonly<{ type: "revoke-silent"; expectedRevision: number; generationId: string }>
  | Readonly<{ type: "activate"; expectedRevision: number; generationId: string; shell: StandaloneShellIdentity }>
  | Readonly<{ type: "begin-attempt"; expectedRevision: number; binding: RuntimeBinding }>
  | Readonly<{ type: "confirm"; expectedRevision: number; binding: RuntimeBinding }>
  | Readonly<{ type: "rollback"; expectedRevision: number; binding?: RuntimeBinding }>;

export const INITIAL_GENERATION_STATE: GenerationState = Object.freeze({
  schemaVersion: STANDALONE_GENERATION_STATE_SCHEMA,
  revision: 0,
  prepared: null,
  activationIntent: null,
  attempt: null,
  attemptLaunches: null,
  active: null,
  lastSuccessful: null,
});

const GENERATION_PATTERN = /^[a-f0-9]{64}$/;

function assertGenerationId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !GENERATION_PATTERN.test(value)) throw new Error(`invalid ${label}`);
}

function sameShell(left: StandaloneShellIdentity, right: StandaloneShellIdentity): boolean {
  return left.type === right.type && left.version === right.version && left.digest === right.digest;
}

export function sameRuntimeBinding(left: RuntimeBinding | null, right: RuntimeBinding | null): boolean {
  return left === null || right === null
    ? left === right
    : left.generationId === right.generationId && sameShell(left.shell, right.shell);
}

function binding(value: unknown, label: string): RuntimeBinding | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid ${label}`);
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !== "generationId,shell") throw new Error(`invalid ${label}`);
  assertGenerationId(input.generationId, `${label} generation`);
  validateShellIdentity(input.shell as StandaloneShellIdentity);
  return { generationId: input.generationId, shell: { ...(input.shell as StandaloneShellIdentity) } };
}

export function validateGenerationState(value: unknown): GenerationState {
  if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid generation state");
  const input = value as Record<string, unknown>;
  const keys = ["activationIntent", "active", "attempt", "attemptLaunches", "lastSuccessful", "prepared", "revision", "schemaVersion"];
  if (Object.keys(input).sort().join(",") !== keys.sort().join(",")) throw new Error("invalid generation state fields");
  if (input.schemaVersion !== STANDALONE_GENERATION_STATE_SCHEMA) throw new Error("unsupported generation state schema");
  if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 0) throw new Error("invalid generation state revision");
  if (input.prepared != null) assertGenerationId(input.prepared, "prepared generation");
  const active = binding(input.active, "active binding");
  const attempt = binding(input.attempt, "attempt binding");
  const attemptLaunches = input.attemptLaunches;
  const lastSuccessful = binding(input.lastSuccessful, "last successful binding");
  let activationIntent: ActivationIntent | null = null;
  if (input.activationIntent != null) {
    if (typeof input.activationIntent !== "object" || Array.isArray(input.activationIntent)) throw new Error("invalid activation intent");
    const intent = input.activationIntent as Record<string, unknown>;
    if (Object.keys(intent).sort().join(",") !== "authorizedAt,generationId,source") throw new Error("invalid activation intent");
    assertGenerationId(intent.generationId, "activation intent generation");
    if (!["initial-bootstrap", "repair", "silent-policy", "user-restart"].includes(String(intent.source))) throw new Error("invalid activation intent source");
    if (typeof intent.authorizedAt !== "string" || !Number.isFinite(Date.parse(intent.authorizedAt))) throw new Error("invalid activation intent time");
    activationIntent = intent as unknown as ActivationIntent;
  }
  if (activationIntent != null && activationIntent.generationId !== input.prepared) throw new Error("activation intent is not bound to prepared generation");
  if (attempt != null && !sameRuntimeBinding(attempt, active)) throw new Error("attempt is not the active binding");
  if ((attempt == null) !== (attemptLaunches == null) || (attemptLaunches != null && (!Number.isSafeInteger(attemptLaunches) || (attemptLaunches as number) < 0 || (attemptLaunches as number) > 2))) {
    throw new Error("attempt launch count is not bound to the attempt");
  }
  if (attempt == null && active != null && !sameRuntimeBinding(active, lastSuccessful)) throw new Error("settled active binding is not last successful");
  if (active == null && lastSuccessful != null) throw new Error("last successful binding is detached from active");
  return {
    schemaVersion: STANDALONE_GENERATION_STATE_SCHEMA,
    revision: input.revision as number,
    prepared: input.prepared as string | null,
    activationIntent,
    attempt,
    attemptLaunches: attemptLaunches as number | null,
    active,
    lastSuccessful,
  };
}

function assertExpected(state: GenerationState, expectedRevision: number): void {
  if (state.revision !== expectedRevision) throw new Error(`stale generation state revision: expected ${expectedRevision}, current ${state.revision}`);
}

function next(state: GenerationState, patch: Partial<GenerationState>): GenerationState {
  return validateGenerationState({ ...state, ...patch, revision: state.revision + 1 });
}

function expectPrepared(state: GenerationState, generationId: string): void {
  assertGenerationId(generationId, "expected generation");
  if (state.prepared !== generationId) throw new Error("prepared generation changed concurrently");
}

export function reduceGenerationState(stateInput: GenerationState, command: GenerationStateCommand): GenerationState {
  const state = validateGenerationState(stateInput);
  assertExpected(state, command.expectedRevision);
  if (command.type === "prepare") {
    assertGenerationId(command.generationId, "prepared generation");
    if (state.attempt != null) throw new Error("cannot replace prepared generation during an unfinished activation attempt");
    if (state.prepared === command.generationId) return state;
    return next(state, { prepared: command.generationId, activationIntent: null });
  }
  if (command.type === "authorize") {
    expectPrepared(state, command.generationId);
    const existing = state.activationIntent;
    const source = existing?.generationId === command.generationId && existing.source === "user-restart" && command.source !== "user-restart"
      ? "user-restart"
      : command.source;
    if (existing?.generationId === command.generationId && existing.source === source) return state;
    return next(state, { activationIntent: { generationId: command.generationId, source, authorizedAt: command.authorizedAt } });
  }
  if (command.type === "revoke-silent") {
    expectPrepared(state, command.generationId);
    if (state.activationIntent?.source !== "silent-policy") return state;
    return next(state, { activationIntent: null });
  }
  if (command.type === "activate") {
    expectPrepared(state, command.generationId);
    if (state.attempt != null) throw new Error("cannot activate while another attempt is unfinished");
    if (state.activationIntent?.generationId !== command.generationId) throw new Error("prepared generation is not authorized for activation");
    validateShellIdentity(command.shell);
    const activated = { generationId: command.generationId, shell: { ...command.shell } };
    return next(state, { prepared: null, activationIntent: null, attempt: activated, attemptLaunches: 0, active: activated });
  }
  if (command.type === "begin-attempt") {
    assertGenerationId(command.binding.generationId, "attempt generation");
    validateShellIdentity(command.binding.shell);
    if (state.active?.generationId !== command.binding.generationId) throw new Error("active generation changed concurrently");
    if (state.attempt != null) {
      if (!sameRuntimeBinding(state.attempt, command.binding)) throw new Error("another activation attempt is unfinished");
      if (state.attemptLaunches == null || state.attemptLaunches >= 2) throw new Error("activation attempt retry budget is exhausted");
      return next(state, { attemptLaunches: state.attemptLaunches + 1 });
    }
    if (sameRuntimeBinding(state.lastSuccessful, command.binding)) return state;
    return next(state, { active: command.binding, attempt: command.binding, attemptLaunches: 1 });
  }
  if (command.type === "confirm") {
    if (!sameRuntimeBinding(state.attempt, command.binding) || !sameRuntimeBinding(state.active, command.binding)) throw new Error("runtime binding is not the active attempt");
    if (state.attemptLaunches == null || state.attemptLaunches < 1) throw new Error("runtime attempt has not launched");
    return next(state, { attempt: null, attemptLaunches: null, lastSuccessful: command.binding });
  }
  if (command.binding != null && !sameRuntimeBinding(state.attempt, command.binding)) throw new Error("activation attempt changed concurrently");
  if (state.attempt == null) return state;
  return next(state, { active: state.lastSuccessful, attempt: null, attemptLaunches: null, prepared: null, activationIntent: null });
}

export function activationPolicyCommand(
  state: GenerationState,
  generationId: string,
  policy: UpdateActivationPolicy,
  now = new Date().toISOString(),
): Extract<GenerationStateCommand, { type: "authorize" | "revoke-silent" }> | null {
  if (policy === "observe") return null;
  if (policy === "revoke-silent") return { type: "revoke-silent", expectedRevision: state.revision, generationId };
  return {
    type: "authorize",
    expectedRevision: state.revision,
    generationId,
    source: policy === "authorize-user" ? "user-restart" : "silent-policy",
    authorizedAt: now,
  };
}
