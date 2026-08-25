import { compareVersions, type StandaloneShellIdentity, type StandaloneShellRequirement } from "./protocol.js";
import type { GenerationRecord } from "./store.js";
import type { LifecycleAttachment, LifecycleStatus } from "./launcher.js";

export const STANDALONE_SHELL_UPDATER_SCHEMA = 2 as const;

export type StandaloneLifecycleOccupant = Readonly<{
  attachmentId: string;
  generationId: string;
  shell: StandaloneShellIdentity;
}>;

export type StandaloneLifecycleTransition = Readonly<{
  fence: number;
  expiresAt: string;
  heartbeatIntervalMs: number;
  occupants: readonly StandaloneLifecycleOccupant[];
  renew(): Promise<void>;
  release(): Promise<void>;
  forceStop(): Promise<void>;
  completeStart(generation: GenerationRecord, attachment: LifecycleAttachment): Promise<LifecycleStatus>;
}>;

export type StandaloneLifecycleTransitionResult =
  | Readonly<{ state: "acquired"; transition: StandaloneLifecycleTransition }>
  | Readonly<{
      state: "blocked";
      reason: "occupied" | "transition-active" | "unavailable";
      occupants: readonly StandaloneLifecycleOccupant[];
    }>;

export interface StandaloneLifecycleTransitionPort {
  occupants(scope: Readonly<{ channel: string; namespace: string }>): Promise<readonly StandaloneLifecycleOccupant[]>;
  beginTransition(
    scope: Readonly<{ channel: string; namespace: string }>,
    kind: "content-restart" | "shell-install",
    options?: Readonly<{ ownerAttachmentId?: string; ownerShellType?: string; force?: boolean }>,
  ): Promise<StandaloneLifecycleTransitionResult>;
}

export type StandaloneShellUpdaterState =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "applying"
  | "handed-off"
  | "installed"
  | "failed";

export type StandaloneShellUpdaterAction = Readonly<{
  id: "check" | "download" | "install" | "later" | "force-stop-and-install";
  emphasis: "primary" | "secondary" | "danger";
}>;

export type StandaloneShellUpdaterSnapshot = Readonly<{
  schemaVersion: typeof STANDALONE_SHELL_UPDATER_SCHEMA;
  revision: number;
  shellType: string;
  state: StandaloneShellUpdaterState;
  progress?: Readonly<{ completed: number; total: number }>;
  actions: readonly StandaloneShellUpdaterAction[];
  blockedBy: readonly StandaloneLifecycleOccupant[];
  handoff?: Readonly<{
    interaction: "restart-and-install";
    releaseVersion: string;
    target: string;
    artifact: Readonly<{ path: string; sha256: string; size: number; mediaType: string }>;
    shell: Readonly<{ type: string; version: string; buildHash: string }>;
  }>;
  error?: Readonly<{ code: string; message: string }>;
}>;

export type StandaloneShellUpdaterActionResult = Readonly<{
  outcome: "accepted" | "blocked" | "unsupported" | "failed";
  snapshot: StandaloneShellUpdaterSnapshot;
}>;

/** Shell-owned implementation exposed to Closure through the Standalone handoff. */
export interface StandaloneShellUpdaterPort {
  readonly shellType: string;
  readSnapshot(): Promise<StandaloneShellUpdaterSnapshot>;
  waitForChange(afterRevision: number, timeoutMs: number): Promise<StandaloneShellUpdaterSnapshot>;
  invoke(action: StandaloneShellUpdaterAction["id"]): Promise<StandaloneShellUpdaterActionResult>;
  confirmInstalled(proof: Readonly<{ shell: StandaloneShellIdentity; buildHash: string }>): Promise<StandaloneShellUpdaterActionResult>;
}

export type StandaloneShellCompatibilityResult =
  | Readonly<{ state: "compatible" }>
  | Readonly<{
      state: "update-required";
      shellType: string;
      currentVersion: string;
      minimumVersion: string | null;
      updater: StandaloneShellUpdaterPort | null;
    }>;

export function resolveStandaloneShellCompatibility(input: Readonly<{
  requirement: StandaloneShellRequirement | null;
  shell: StandaloneShellIdentity;
  updater?: StandaloneShellUpdaterPort | null;
}>): StandaloneShellCompatibilityResult {
  if (input.requirement != null && compareVersions(input.shell.version, input.requirement.minVersion) >= 0) {
    return { state: "compatible" };
  }
  return {
    state: "update-required",
    shellType: input.shell.type,
    currentVersion: input.shell.version,
    minimumVersion: input.requirement?.minVersion ?? null,
    updater: input.updater ?? null,
  };
}
