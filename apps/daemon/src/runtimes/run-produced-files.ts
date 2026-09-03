// Run-terminal produced-file association.
//
// THE INVARIANT: a run that succeeded and touched artifacts leaves that
// association on its assistant message, whether or not a browser was watching.
//
// `produced_files_json` has only ever had one writer — the web client, from a
// closure inside `ProjectView`'s SSE `onDone`. Detach that stream and the
// column is never written: leaving the project mid-run (or merely switching
// conversations) aborts the controller, `streamViaDaemon` swallows the
// `AbortError` without calling any handler, and the turn's deliverable is never
// attached to the turn. The daemon meanwhile promotes the same row to
// `succeeded` (`reconcileAssistantMessageOnRunEnd`) — publishing a terminal
// state while withholding the artifact association that terminal state was
// supposed to carry. On the user's return the client's own repair is refused,
// because a succeeded row with prose is past
// `DESIGN_DELIVERY_RECONCILIATION_WINDOW_MS`. The card is then unreachable
// forever. (Plane OPEND-2598, OPEND-2608.)
//
// This closes the hole at the same terminal chokepoint that already freezes the
// turn's artifact bytes, where the run's own filesystem diff is in hand.
//
// A FLOOR, NOT A VERDICT. The client sees the pre-turn snapshot and the daemon
// does not, so the client's list stays authoritative: this only ever fills a
// column that is still NULL, in one idempotent statement. A client write —
// before or after — wins by construction, and re-running this is a no-op.

import path from 'node:path';
import { promises as fsp } from 'node:fs';

import type Database from 'better-sqlite3';

import { kindForArtifactPath, mimeForArtifactPath } from '../chat-artifacts/mime.js';

/**
 * One entry of the message's produced-file list, shaped exactly like the
 * `ProjectFile` the file listing hands the web (`projects.ts` `collectFiles`).
 *
 * The shape is load-bearing, not decorative: the chat card picks the image
 * card vs. the audio capsule from `kind`/the extension, builds its preview URL
 * from `name`, and shows `size`. A list of bare filenames would persist and
 * then render as nothing.
 */
export interface RunProducedFile {
  name: string;
  path: string;
  localPath: string;
  type: 'file';
  size: number;
  mtime: number;
  kind: string;
  mime: string;
}

export interface AssociateRunProducedFilesInput {
  /** Assistant message that carries the turn. */
  messageId: string;
  /** Absolute project directory the run wrote into. */
  projectRoot: string;
  /** Absolute paths the run created or modified (the run's artifact diff). */
  touchedPaths: readonly string[];
  /** Cap so a pathological run cannot flood the column. */
  maxFiles?: number;
}

export type AssociateRunProducedFilesOutcome =
  | { written: false; reason: 'no-paths' | 'unreadable' | 'client-owned' }
  | { written: true; files: RunProducedFile[] };

/** Mirrors `captureRunChatArtifactSnapshots`' ref cap — same list, same bound. */
const DEFAULT_MAX_FILES = 64;

/**
 * Project-relative key for a touched path, or null when the path escapes the
 * project root.
 *
 * Only positive evidence counts: every consumer downstream treats this string
 * as a project file key (`/raw/<project-relative path>`, tab identity, card
 * dedupe), so a path we cannot place inside the project must be dropped rather
 * than guessed at by basename — pointing a card at the wrong file is worse
 * than showing no card.
 */
function projectRelativeKey(projectRoot: string, absolutePath: string): string | null {
  const rel = path.relative(projectRoot, absolutePath).replaceAll('\\', '/');
  if (!rel || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) return null;
  return rel;
}

async function describeTouchedFile(
  projectRoot: string,
  absolutePath: string,
): Promise<RunProducedFile | null> {
  const rel = projectRelativeKey(projectRoot, absolutePath);
  if (!rel) return null;
  let stat;
  try {
    stat = await fsp.stat(absolutePath);
  } catch {
    // The file was touched during the run and is gone by the terminal snapshot
    // (a temp write, or the next turn already moved it). A card for a file that
    // is not there is a lie; drop it.
    return null;
  }
  if (!stat.isFile()) return null;
  return {
    name: rel,
    path: rel,
    localPath: path.resolve(absolutePath),
    type: 'file',
    size: stat.size,
    mtime: stat.mtimeMs,
    kind: kindForArtifactPath(rel),
    mime: mimeForArtifactPath(rel) ?? 'application/octet-stream',
  };
}

/**
 * Fill this message's produced-file list from the run's touched paths, but only
 * while it is still empty.
 *
 * Never throws: a missed association costs one card, it must not fail the run.
 */
export async function associateRunProducedFiles(
  db: Database.Database,
  input: AssociateRunProducedFilesInput,
): Promise<AssociateRunProducedFilesOutcome> {
  if (input.touchedPaths.length === 0) return { written: false, reason: 'no-paths' };

  const described = await Promise.all(
    input.touchedPaths
      .slice(0, input.maxFiles ?? DEFAULT_MAX_FILES)
      .map((absolutePath) => describeTouchedFile(input.projectRoot, absolutePath)),
  );
  const files = described
    .filter((file): file is RunProducedFile => file !== null)
    // Newest first, matching the order `listFiles` gives the web so the card
    // strip does not reorder itself once the client's own list replaces this.
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) return { written: false, reason: 'unreadable' };

  const result = db
    .prepare(
      `UPDATE messages
          SET produced_files_json = ?
        WHERE id = ? AND produced_files_json IS NULL`,
    )
    .run(JSON.stringify(files), input.messageId);
  if (result.changes === 0) return { written: false, reason: 'client-owned' };
  return { written: true, files };
}
