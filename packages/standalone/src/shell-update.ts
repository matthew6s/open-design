import { compareVersions, type StandaloneShellIdentity, type StandaloneShellRequirement } from "./protocol.js";

export const STANDALONE_SHELL_UPDATER_SCHEMA = 1 as const;

export type StandaloneLifecycleOccupant = Readonly<{
  attachmentId: string;
  generationId: string;
  shell: StandaloneShellIdentity;
}>;

export type StandaloneLifecycleTransition = Readonly<{
  fence: number;
  occupants: readonly StandaloneLifecycleOccupant[];
  release(): Promise<void>;
  forceStop(): Promise<void>;
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
    kind: "shell-install",
    options?: Readonly<{ ownerShellType?: string; force?: boolean }>,
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
