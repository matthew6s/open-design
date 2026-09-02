import { describe, expect, it } from 'vitest';

import {
  CHAT_ARTIFACT_DISPLAY_POLICIES,
  CHAT_ARTIFACT_OPEN_POLICIES,
  CHAT_ARTIFACT_SNAPSHOT_STATES,
  chatArtifactStaticCoverUrl,
  isChatArtifactStaticCoverReady,
  type ChatArtifactRef,
  type ChatMessage,
} from '../src/api/chat';

/** `undefined` here means "the daemon omitted this field", so the key is dropped
 *  rather than set to undefined — which is the shape a real JSON payload has. */
type RefOverrides = { [K in keyof ChatArtifactRef]?: ChatArtifactRef[K] | undefined };

function ref(overrides: RefOverrides = {}): ChatArtifactRef {
  const merged: Record<string, unknown> = {
    id: 'artifact-1',
    kind: 'html',
    label: 'Landing page',
    displayPolicy: 'latest_with_static_preview',
    openPolicy: 'workspace_latest',
    snapshotState: 'ready',
    thumbnailUrl: '/api/projects/p1/snapshots/s1/thumbnail.png',
    snapshotId: 's1',
    workspaceArtifactId: 'wa1',
    ...overrides,
  };
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) delete merged[key];
  }
  return merged as unknown as ChatArtifactRef;
}

describe('ChatArtifactRef policy vocabulary', () => {
  it('separates what the card DRAWS from what a click OPENS', () => {
    // The whole point of the ruling: the cover is the turn's frozen first
    // viewport, the click goes to the workspace's latest version. Folding both
    // into one flag is what made "card and click disagree" read as a bug
    // instead of the intended behaviour.
    expect(CHAT_ARTIFACT_DISPLAY_POLICIES).toEqual([
      'latest_with_static_preview',
      'immutable_snapshot',
    ]);
    expect(CHAT_ARTIFACT_OPEN_POLICIES).toEqual(['workspace_latest', 'snapshot']);
  });

  it('models the four snapshot outcomes the card has to draw', () => {
    // `legacy_unavailable` is not the same as `failed`: an old conversation
    // never had a capture attempted, so there is nothing to retry and nothing
    // to apologise for — it just falls back to the live iframe.
    expect(CHAT_ARTIFACT_SNAPSHOT_STATES).toEqual([
      'pending',
      'ready',
      'failed',
      'legacy_unavailable',
    ]);
  });
});

describe('isChatArtifactStaticCoverReady — the single fallback rule', () => {
  it('accepts a ready snapshot that actually has an image to draw', () => {
    expect(isChatArtifactStaticCoverReady(ref())).toBe(true);
    expect(chatArtifactStaticCoverUrl(ref())).toBe(
      '/api/projects/p1/snapshots/s1/thumbnail.png',
    );
  });

  it('refuses a "ready" ref with no thumbnail url', () => {
    // Ready-without-a-url is a daemon bug, not a cover. Returning true here
    // would paint an empty box where the live iframe should have been.
    expect(isChatArtifactStaticCoverReady(ref({ thumbnailUrl: undefined }))).toBe(false);
    expect(chatArtifactStaticCoverUrl(ref({ thumbnailUrl: undefined }))).toBeNull();
  });

  it('falls back to live for every non-ready state', () => {
    for (const snapshotState of ['pending', 'failed', 'legacy_unavailable'] as const) {
      expect(isChatArtifactStaticCoverReady(ref({ snapshotState }))).toBe(false);
      expect(chatArtifactStaticCoverUrl(ref({ snapshotState }))).toBeNull();
    }
  });

  it('never claims a cover for a ref that is missing entirely', () => {
    expect(isChatArtifactStaticCoverReady(undefined)).toBe(false);
    expect(isChatArtifactStaticCoverReady(null)).toBe(false);
    expect(chatArtifactStaticCoverUrl(undefined)).toBeNull();
  });

  it('draws an immutable snapshot from its own snapshot url', () => {
    // A snapshot-policy ref (a shared/published turn) opens the snapshot, so
    // the cover it draws is the snapshot's own render, not a workspace thumb.
    const immutable = ref({
      displayPolicy: 'immutable_snapshot',
      openPolicy: 'snapshot',
      thumbnailUrl: undefined,
      snapshotUrl: '/api/snapshots/s1/cover.png',
    });
    expect(isChatArtifactStaticCoverReady(immutable)).toBe(true);
    expect(chatArtifactStaticCoverUrl(immutable)).toBe('/api/snapshots/s1/cover.png');
  });
});

describe('ChatMessage.artifactRefs', () => {
  it('rides alongside producedFiles rather than replacing it', () => {
    // Purely additive: every existing reader of producedFiles keeps working,
    // and a daemon that has not learned artifactRefs yet simply omits it.
    const message: ChatMessage = {
      id: 'm1',
      role: 'assistant',
      content: 'done',
      producedFiles: [
        {
          name: 'index.html',
          size: 2048,
          mtime: 1787787535451,
          kind: 'html',
          mime: 'text/html',
        },
      ],
      artifactRefs: [ref()],
    };
    expect(message.producedFiles).toHaveLength(1);
    expect(message.artifactRefs?.[0]?.openPolicy).toBe('workspace_latest');
  });
});
