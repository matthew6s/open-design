import { describe, expect, it } from 'vitest';

import {
  PublicSkillDiscoveryStateV1Schema,
  SKILL_DISCOVERY_MAX_SUPERSEDED_V1,
  SkillDiscoveryPreparedResourceV1Schema,
  SkillDiscoveryToolLoadCommitRequestV1Schema,
} from '../src/index.js';

const digest = `sha256:${'a'.repeat(64)}`;

function loadedRef(index: number) {
  return {
    id: `skill-${index}`,
    kind: 'functional' as const,
    role: 'auxiliary' as const,
    version: '1',
    candidateDigest: digest,
    contentDigest: digest,
    catalogRevision: digest,
    purposeDigest: digest,
    loadedAt: index,
    runId: 'run-1',
  };
}

describe('Skill discovery two-phase contracts', () => {
  it('accepts bounded base64 resources and strict commit receipts', () => {
    expect(SkillDiscoveryPreparedResourceV1Schema.parse({
      relativePath: 'device-frames/iphone.html',
      digest,
      size: 5,
      mode: 0o644,
      bytesBase64: 'ZnJhbWU=',
    })).toMatchObject({ relativePath: 'device-frames/iphone.html', size: 5 });

    expect(SkillDiscoveryToolLoadCommitRequestV1Schema.safeParse({
      pendingToken: `odsp_${'A'.repeat(43)}`,
      expectedStateRevision: 1,
      materialization: {
        materializedRoot: '.od-skills/discovered-prototype-aaaaaaaaaaaa',
        resources: [{ relativePath: 'device-frames/iphone.html', digest, size: 5 }],
      },
      cwd: '/forbidden/request/path',
    }).success).toBe(false);
  });

  it('caps public superseded history at the exported limit', () => {
    const state = {
      schemaVersion: 1,
      status: 'pending' as const,
      catalogRevision: digest,
      activePrimary: null,
      activeAuxiliaries: [],
      superseded: Array.from(
        { length: SKILL_DISCOVERY_MAX_SUPERSEDED_V1 },
        (_, index) => loadedRef(index),
      ),
      lastResolution: null,
      revision: 1,
    };

    expect(PublicSkillDiscoveryStateV1Schema.safeParse(state).success).toBe(true);
    expect(PublicSkillDiscoveryStateV1Schema.safeParse({
      ...state,
      superseded: [...state.superseded, loadedRef(SKILL_DISCOVERY_MAX_SUPERSEDED_V1)],
    }).success).toBe(false);
  });
});
