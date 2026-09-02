// Which identity a chat card speaks for, by artifact kind.
//
// PRODUCT RULING (not re-litigated here):
//
//   image  -> the card shows THAT TURN's exact bytes and clicking opens those
//             same bytes. A later `hero.png` cannot rewrite an older message.
//   html / prototype / slide / document
//          -> the card shows a FROZEN static cover of that turn, but clicking
//             opens today's latest file.
//
// Cover and click therefore disagree for HTML, deliberately. That is the
// ruling, not a defect: the card is evidence of what the turn produced, the
// click is a door into the live workspace.

import type { ChatArtifactDisplayPolicy, ChatArtifactOpenPolicy } from './types.js';

export interface ChatArtifactPolicy {
  displayPolicy: ChatArtifactDisplayPolicy;
  openPolicy: ChatArtifactOpenPolicy;
  /** Whether the original bytes are copied into the immutable blob store. */
  capturesContent: boolean;
  /** Whether the card wants a separately rendered static cover image. */
  wantsStaticCover: boolean;
}

/**
 * Kinds whose ORIGINAL bytes are the message evidence. These are the ones the
 * overwrite bug actually destroys today, so they are the ones that get frozen.
 *
 * `sketch` covers `.svg` and `sketch-*.png` (see `projects.ts#kindFor`).
 *
 * OPEN PRODUCT QUESTION: video / audio are included because they are binary
 * originals with exactly the same overwrite exposure as images, but the ruling
 * only named images explicitly and spec §15.5 leaves their retention budget
 * undecided. If product wants them excluded, remove them from this set — the
 * data model needs no other change.
 */
const IMMUTABLE_ORIGINAL_KINDS: ReadonlySet<string> = new Set([
  'image',
  'sketch',
  'video',
  'audio',
]);

export function chatArtifactPolicyForKind(kind: string): ChatArtifactPolicy {
  if (IMMUTABLE_ORIGINAL_KINDS.has(kind)) {
    return {
      displayPolicy: 'immutable_snapshot',
      openPolicy: 'snapshot',
      capturesContent: true,
      wantsStaticCover: false,
    };
  }
  return {
    displayPolicy: 'latest_with_static_preview',
    openPolicy: 'workspace_latest',
    capturesContent: false,
    wantsStaticCover: true,
  };
}
