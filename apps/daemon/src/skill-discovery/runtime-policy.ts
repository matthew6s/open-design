import {
  isSkillDiscoveryWrapperBlocked,
  renderSkillDiscoveryLifecycleCapsule,
  type SkillDiscoveryState,
} from './state.js';

const BLOCKED_BEFORE_RESOLUTION = new Set([
  'connectors:execute',
  'library:apply',
  'live-artifacts:create',
  'live-artifacts:refresh',
  'live-artifacts:update',
  'media:generate',
  'media:scaffold',
  'project:export',
]);

/**
 * The daemon can enforce discovery ordering only for its run-scoped wrapper
 * capabilities. Native Agent filesystem and shell tools remain outside this
 * boundary; this module neither blocks nor observes those native operations.
 */
export function skillDiscoveryBlocksToolOperation(
  state: Pick<SkillDiscoveryState, 'status'> | null | undefined,
  operation: string,
): boolean {
  return BLOCKED_BEFORE_RESOLUTION.has(operation)
    && isSkillDiscoveryWrapperBlocked(state);
}

/** Fail closed when a wrapper grant no longer owns the persisted active run. */
export function scopeSkillDiscoveryStateForRun(
  state: SkillDiscoveryState | null | undefined,
  scope: { runId: string; projectId: string },
): SkillDiscoveryState | { status: 'pending' } {
  if (
    !state
    || state.activeRunId !== scope.runId
    || state.projectId !== scope.projectId
  ) {
    return { status: 'pending' };
  }
  return state;
}

export type SkillDiscoveryLifecyclePrompt =
  | { discoveryBootstrapMarkdown: string }
  | { compactLifecycleCapsuleMarkdown: string }
  | Record<string, never>;

/**
 * `isResuming` is the only host-provided continuity signal available here, so
 * this function adds no lifecycle text on that path. A non-resumed physical
 * attempt gets the complete candidate metadata catalog plus either the one
 * full policy bootstrap (the first bootstrap-Run attempt) or a compact durable
 * state capsule on an observed retry/later Run. This does not claim that the
 * host can detect native context compaction.
 */
export function resolveSkillDiscoveryLifecyclePrompt(input: {
  state: SkillDiscoveryState | null | undefined;
  runId: string;
  bootstrapMarkdown: string;
  catalogMarkdown: string;
  catalogRevisionChanged?: boolean;
  isResuming: boolean;
  retryAttemptCount?: number | null;
  manualResumeAttemptCount?: number | null;
}): SkillDiscoveryLifecyclePrompt {
  if (!input.state || (input.isResuming && input.catalogRevisionChanged !== true)) return {};
  const catalog = input.catalogMarkdown.trim();
  if (!catalog) throw new TypeError('Skill discovery catalog metadata must not be empty.');
  if (input.catalogRevisionChanged === true) {
    return {
      compactLifecycleCapsuleMarkdown: [
        renderSkillDiscoveryLifecycleCapsule(input.state),
        catalog,
      ].join('\n\n---\n\n'),
    };
  }
  const isFirstPhysicalAttempt = input.state.bootstrapRunId === input.runId
    && (input.retryAttemptCount ?? 0) === 0
    && (input.manualResumeAttemptCount ?? 0) === 0;
  if (isFirstPhysicalAttempt) {
    const bootstrap = input.bootstrapMarkdown.trim();
    if (!bootstrap) throw new TypeError('Skill discovery bootstrap must not be empty.');
    return { discoveryBootstrapMarkdown: `${bootstrap}\n\n---\n\n${catalog}` };
  }
  return {
    compactLifecycleCapsuleMarkdown: [
      renderSkillDiscoveryLifecycleCapsule(input.state),
      catalog,
    ].join('\n\n---\n\n'),
  };
}
