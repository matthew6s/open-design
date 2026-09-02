// Which identity a chat card speaks for, by artifact kind.
//
// PRODUCT RULING (not re-litigated here):
//
//   image  -> the card shows THAT TURN's exact bytes. A later `hero.png`
//             cannot rewrite an older message's card.
//   html / prototype / slide / document
//          -> the card shows a FROZEN static cover of that turn.
//
// CLICKING IS NOT A DECISION THIS FILE MAKES. Every card, of every kind, opens
// the workspace's latest file (user ruling 2026-09-02: "html 和图片都是,产物缩略
// 是快照,但跳过去产物永远指向最新的"). Cover and click therefore disagree, on
// purpose, for both kinds: the card is evidence of what the turn produced, the
// click is a door into the live workspace. There is no per-kind open policy to
// return — the ref's `workspaceArtifactId` already names the one target.

import type { ChatArtifactDisplayPolicy } from './types.js';

export interface ChatArtifactPolicy {
  displayPolicy: ChatArtifactDisplayPolicy;
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
      capturesContent: true,
      wantsStaticCover: false,
    };
  }
  return {
    displayPolicy: 'latest_with_static_preview',
    capturesContent: false,
    wantsStaticCover: true,
  };
}
