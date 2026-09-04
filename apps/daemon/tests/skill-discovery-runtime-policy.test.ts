import { describe, expect, it } from 'vitest';

import {
  resolveSkillDiscoveryLifecyclePrompt,
  scopeSkillDiscoveryStateForRun,
  skillDiscoveryBlocksToolOperation,
} from '../src/skill-discovery/runtime-policy.js';
import type { SkillDiscoveryState } from '../src/skill-discovery/state.js';

function state(status: SkillDiscoveryState['status']): SkillDiscoveryState {
  return {
    schemaVersion: 1,
    conversationId: 'conversation-1',
    projectId: 'project-1',
    catalogRevision: `sha256:${'a'.repeat(64)}`,
    status,
    bootstrapRunId: 'run-1',
    activeRunId: 'run-1',
    activePrimary: null,
    activeAuxiliaries: [],
    superseded: [],
    lastResolution: null,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('Skill discovery runtime policy', () => {
  it('fails wrapper scope closed when another concurrent run owns the conversation', () => {
    const current = {
      ...state('resolved_skill'),
      activeRunId: 'run-b',
      projectId: 'project-1',
    };
    expect(scopeSkillDiscoveryStateForRun(current, {
      runId: 'run-a',
      projectId: 'project-1',
    })).toEqual({ status: 'pending' });
    expect(scopeSkillDiscoveryStateForRun(current, {
      runId: 'run-b',
      projectId: 'project-1',
    })).toBe(current);
  });
  it('blocks only mutation-capable Open Design wrappers while unresolved', () => {
    expect(skillDiscoveryBlocksToolOperation(state('pending'), 'live-artifacts:create')).toBe(true);
    expect(skillDiscoveryBlocksToolOperation(state('clarification'), 'connectors:execute')).toBe(true);
    expect(skillDiscoveryBlocksToolOperation(state('pending'), 'skills:search')).toBe(false);
    expect(skillDiscoveryBlocksToolOperation(state('pending'), 'library:search')).toBe(false);
    expect(skillDiscoveryBlocksToolOperation(state('resolved_none'), 'media:generate')).toBe(false);
    expect(skillDiscoveryBlocksToolOperation(state('resolved_skill'), 'project:export')).toBe(false);
  });

  it('uses the full policy once while retaining complete metadata on cold contexts', () => {
    const first = state('pending');
    expect(resolveSkillDiscoveryLifecyclePrompt({
      state: first,
      runId: 'run-1',
      bootstrapMarkdown: '# Discovery',
      catalogMarkdown: '# Catalog\n\nAll candidates.',
      isResuming: false,
    })).toEqual({
      discoveryBootstrapMarkdown: '# Discovery\n\n---\n\n# Catalog\n\nAll candidates.',
    });

    expect(resolveSkillDiscoveryLifecyclePrompt({
      state: first,
      runId: 'run-1',
      bootstrapMarkdown: '# Discovery',
      catalogMarkdown: '# Catalog\n\nAll candidates.',
      isResuming: false,
      retryAttemptCount: 1,
    })).toMatchObject({
      compactLifecycleCapsuleMarkdown: expect.stringContaining('Skill lifecycle capsule'),
    });

    expect(resolveSkillDiscoveryLifecyclePrompt({
      state: { ...first, activeRunId: 'run-2' },
      runId: 'run-2',
      bootstrapMarkdown: '# Discovery',
      catalogMarkdown: '# Catalog\n\nAll candidates.',
      isResuming: false,
    })).toMatchObject({
      compactLifecycleCapsuleMarkdown: expect.stringContaining('Decision state: `pending`'),
    });
  });

  it('makes a cold unresolved capsule actionable and preserves the last resolution evidence', () => {
    const unresolved = {
      ...state('clarification'),
      activeRunId: 'run-2',
      lastResolution: {
        kind: 'clarify' as const,
        runId: 'run-1',
        at: 123,
      },
    };
    const prompt = resolveSkillDiscoveryLifecyclePrompt({
      state: unresolved,
      runId: 'run-2',
      bootstrapMarkdown: '# Discovery',
      catalogMarkdown: '# Official Skill metadata catalog\n\nAll candidates.',
      isResuming: false,
    });

    expect(prompt).toMatchObject({
      compactLifecycleCapsuleMarkdown: expect.stringContaining(
        'Last resolution: clarify (run=run-1, at=123)',
      ),
    });
    const capsule = 'compactLifecycleCapsuleMarkdown' in prompt
      ? prompt.compactLifecycleCapsuleMarkdown
      : '';
    expect(capsule).toContain('tools skills status --rehydrate --json');
    expect(capsule).toContain('# Official Skill metadata catalog');
    expect(capsule).toContain('tools skills load --id <id>');
    expect(capsule).toContain('tools skills resolve --none');
    expect(capsule).toContain('tools skills resolve --clarify');
    expect(capsule).toContain('Wrong selection is more harmful than no selection');
    expect(capsule).toContain('Loading auxiliaries alone does not');
    expect(capsule).not.toContain('context compaction');
  });

  it('does not resend lifecycle text into a native resumed session', () => {
    expect(resolveSkillDiscoveryLifecyclePrompt({
      state: state('resolved_skill'),
      runId: 'run-2',
      bootstrapMarkdown: '# Discovery',
      catalogMarkdown: '# Catalog',
      isResuming: true,
    })).toEqual({});
  });

  it('forces refreshed metadata into a native resume after the catalog revision changes', () => {
    const refreshed = {
      ...state('pending'),
      catalogRevision: `sha256:${'b'.repeat(64)}`,
      activeRunId: 'run-2',
    };
    const prompt = resolveSkillDiscoveryLifecyclePrompt({
      state: refreshed,
      runId: 'run-2',
      bootstrapMarkdown: '# Discovery policy from the original context',
      catalogMarkdown: '# Catalog B\n\nAll current candidates.',
      catalogRevisionChanged: true,
      isResuming: true,
    });

    expect(prompt).toMatchObject({
      compactLifecycleCapsuleMarkdown: expect.stringContaining('# Catalog B'),
    });
    const capsule = 'compactLifecycleCapsuleMarkdown' in prompt
      ? prompt.compactLifecycleCapsuleMarkdown
      : '';
    expect(capsule).toContain(`Catalog revision: \`sha256:${'b'.repeat(64)}\``);
    expect(capsule).toContain('Decision state: `pending`');
    expect(capsule).not.toContain('original context');
  });
});
