import type {
  LifecyclePort,
  LifecycleScope,
  StandaloneLifecycleTransitionPort,
  StandaloneShellUpdaterPort,
} from "@open-design/standalone";

export function requireCompleteStandaloneRetirement(
  result: Readonly<{ remainingPids: readonly number[] }> | null,
): void;

export class FixtureShellUpdaterPort implements StandaloneShellUpdaterPort {
  readonly shellType: string;
  constructor(root: string, scope: LifecycleScope, lifecycle: LifecyclePort & StandaloneLifecycleTransitionPort, options?: {
    algebra: typeof import("@open-design/standalone").SHELL_UPDATE_ALGEBRA;
    attachmentId?: string;
    channelHeadUrl?: string;
    faultAt?: "after-transition" | "before-handoff-persist";
    installDelayMs?: number;
    withRetiredStandalone?: <T>(input: Readonly<{
      scope: LifecycleScope;
      kind: "shell-install";
      attemptId: string;
      fence: number;
      occupants: readonly import("@open-design/standalone").StandaloneLifecycleOccupant[];
    }>, commit: () => Promise<T>) => Promise<T>;
    /** @deprecated Compatibility for the unchanged legacy E2E host only. */
    retireStandalone?: (input: Readonly<{
      scope: LifecycleScope;
      kind: "shell-install";
      fence: number;
      occupants: readonly import("@open-design/standalone").StandaloneLifecycleOccupant[];
    }>) => Promise<Readonly<{ remainingPids: readonly number[] }>>;
    shellType?: string;
    standalone?: typeof import("@open-design/standalone");
    target?: string;
    trustedKeys?: import("@open-design/standalone").StandaloneTrustedKeyRing;
  });
  readSnapshot(): ReturnType<StandaloneShellUpdaterPort["readSnapshot"]>;
  waitForChange(afterRevision: number, timeoutMs: number): ReturnType<StandaloneShellUpdaterPort["waitForChange"]>;
  invoke(action: Parameters<StandaloneShellUpdaterPort["invoke"]>[0]): ReturnType<StandaloneShellUpdaterPort["invoke"]>;
  confirmInstalled(...input: Parameters<StandaloneShellUpdaterPort["confirmInstalled"]>): ReturnType<StandaloneShellUpdaterPort["confirmInstalled"]>;
}
