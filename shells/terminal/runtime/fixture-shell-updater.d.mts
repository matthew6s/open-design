import type {
  LifecyclePort,
  LifecycleScope,
  StandaloneLifecycleTransitionPort,
  StandaloneShellUpdaterPort,
} from "@open-design/standalone";

export class FixtureShellUpdaterPort implements StandaloneShellUpdaterPort {
  readonly shellType: string;
  constructor(root: string, scope: LifecycleScope, lifecycle: LifecyclePort & StandaloneLifecycleTransitionPort, options?: {
    attachmentId?: string;
    channelHeadUrl?: string;
    faultAt?: "after-transition";
    installDelayMs?: number;
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
