import type {
  LifecyclePort,
  LifecycleScope,
  StandaloneLifecycleTransitionPort,
  StandaloneShellUpdaterPort,
} from "@open-design/standalone";

export class FixtureShellUpdaterPort implements StandaloneShellUpdaterPort {
  readonly shellType: string;
  constructor(root: string, scope: LifecycleScope, lifecycle: LifecyclePort & StandaloneLifecycleTransitionPort, options?: { attachmentId?: string; shellType?: string });
  readSnapshot(): ReturnType<StandaloneShellUpdaterPort["readSnapshot"]>;
  waitForChange(afterRevision: number, timeoutMs: number): ReturnType<StandaloneShellUpdaterPort["waitForChange"]>;
  invoke(action: Parameters<StandaloneShellUpdaterPort["invoke"]>[0]): ReturnType<StandaloneShellUpdaterPort["invoke"]>;
}
