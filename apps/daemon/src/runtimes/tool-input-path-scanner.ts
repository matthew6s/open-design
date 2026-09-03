/**
 * Pull the file path out of a tool call's arguments **while they are still
 * streaming**, without ever holding or forwarding the arguments themselves.
 *
 * Claude streams a tool call's JSON arguments as `input_json_delta` fragments
 * that split at arbitrary byte offsets — a real recording splits one path
 * across four fragments and closes it inside a fifth that has already started
 * on `"content"`:
 *
 *   '{"file_path": "/private/tmp/claude-501'
 *   '/-Users-elian-Documents-open-design/bff58f5e-18'
 *   'bb-4b58-96e7-8180846e980a/'
 *   'scratchpad/w107/cwd/alpha.html'
 *   '", "content": "<!doctype html><html><body'
 *
 * `file_path` is normally the first key, so the answer is complete after a few
 * dozen bytes even when `content` runs to tens of kilobytes. This scanner
 * exists to spend exactly those bytes.
 *
 * ## Why not `JSON.parse` in a try/catch
 *
 * A truncated fragment is not a JSON document, so the retry-until-it-parses
 * shape would re-parse a growing buffer on every fragment — quadratic in the
 * argument size, and it cannot answer at all until the LAST byte arrives, which
 * is the exact moment this scanner is trying to beat.
 *
 * This is instead a resumable character scanner: each fragment advances a small
 * state machine over the new bytes only, so the whole stream costs one linear
 * pass and the answer lands the instant the path's closing quote does.
 *
 * ## When it deliberately yields nothing
 *
 * By contract it returns a path only when that path is **provably complete**.
 * It stays silent when:
 *
 *  - the closing quote never arrives (model stopped mid-path, run aborted);
 *  - the path key is absent, nested deeper than the top-level argument object,
 *    or holds a non-string value;
 *  - the tool is not a file-writing tool (`Bash`, `Grep`, … are never scanned);
 *  - the arguments exceed {@link SCAN_BUDGET_BYTES} without yielding a path.
 *
 * A key that appears late still resolves correctly — just late enough that the
 * head start is small or gone. Silence is the designed outcome, never a guess:
 * a half-read path must never reach the UI.
 */

/** Tools whose arguments name a file this call is about to write. */
const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'write_file',
  'replace',
]);

/**
 * Argument keys that hold that file's path, most specific first.
 *
 * `path` is only consulted for the tools above. It is a search ROOT on `Grep`
 * and `Glob`, and those tools never reach this scanner — which is the whole
 * reason the tool gate comes before the key gate.
 */
const PATH_KEYS: readonly string[] = ['file_path', 'notebook_path', 'filePath', 'path'];

/** Longest plausible path; a longer value is not a path and is abandoned. */
const MAX_PATH_CHARS = 4096;
/** Longest plausible argument key. */
const MAX_KEY_CHARS = 64;
/** Give up rather than scan an unbounded argument blob. */
const SCAN_BUDGET_BYTES = 1 << 18;

export function isFileWriteToolName(name: unknown): name is string {
  return typeof name === 'string' && FILE_WRITE_TOOLS.has(name);
}

type Capture = 'none' | 'key' | 'path';

export interface ToolInputPathScanner {
  /**
   * Feed the next raw argument fragment.
   *
   * Returns the decoded path the first time one is provably complete, and
   * `null` every other time — including every call after the first hit, so a
   * caller that emits on a non-null return emits exactly once.
   */
  push(fragment: string): string | null;
}

/**
 * A scanner for `toolName`, or `null` when that tool does not name a file.
 *
 * A `null` return is the caller's signal to not scan at all, so non-file tools
 * cost nothing beyond one set lookup for the whole call.
 */
export function createToolInputPathScanner(toolName: unknown): ToolInputPathScanner | null {
  if (!isFileWriteToolName(toolName)) return null;
  return new JsonPathScanner();
}

/**
 * Reads top-level string values out of a JSON object as it arrives.
 *
 * Only depth-1 keys are considered: a `file_path` buried inside a nested object
 * is not this call's target. Whether a quote opens a key or a value is decided
 * by the last significant character — `{` or `,` means a key follows — which is
 * what keeps a `content` value containing `{`, `}` or `"file_path"` from being
 * mistaken for structure.
 */
class JsonPathScanner implements ToolInputPathScanner {
  private done = false;
  private scanned = 0;
  private depth = 0;
  /** Set once the top-level object has closed; nothing more can arrive. */
  private closed = false;

  private inString = false;
  private capture: Capture = 'none';
  private buf = '';
  private overflowed = false;

  /** Pending backslash escape, possibly split across fragments. */
  private escaping = false;
  private unicode: string | null = null;

  private lastSignificant = '';
  private pendingKey: string | null = null;
  private expectColon = false;
  private expectPathValue = false;

  push(fragment: string): string | null {
    if (this.done || this.closed) return null;
    this.scanned += fragment.length;
    if (this.scanned > SCAN_BUDGET_BYTES) {
      this.closed = true;
      return null;
    }

    for (let i = 0; i < fragment.length; i += 1) {
      const found = this.step(fragment.charAt(i));
      if (found !== null) {
        this.done = true;
        return found;
      }
      if (this.closed) return null;
    }
    return null;
  }

  /** Consume one character; returns the path when this character completed it. */
  private step(ch: string): string | null {
    if (this.inString) return this.stepInString(ch);

    if (ch === '"') {
      this.inString = true;
      this.buf = '';
      this.overflowed = false;
      // A quote right after `{` or `,` opens a key; anything else opens a value.
      if (this.depth === 1 && (this.lastSignificant === '{' || this.lastSignificant === ',')) {
        this.capture = 'key';
      } else if (this.expectPathValue) {
        this.capture = 'path';
      } else {
        this.capture = 'none';
      }
      this.expectPathValue = false;
      return null;
    }

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') return null;

    if (ch === '{' || ch === '[') {
      this.depth += 1;
    } else if (ch === '}' || ch === ']') {
      this.depth -= 1;
      if (this.depth <= 0) this.closed = true;
    } else if (ch === ':' && this.expectColon) {
      this.expectColon = false;
      // Only a path key at the top level opens a value we care about. Anything
      // else (including a non-string value for a path key) falls through and is
      // skipped by ordinary depth tracking.
      this.expectPathValue = this.pendingKey !== null && PATH_KEYS.includes(this.pendingKey);
      this.pendingKey = null;
    }

    if (ch !== ':') {
      this.expectColon = false;
      this.pendingKey = null;
    }
    // A path key followed by a non-string value is not a path.
    if (ch !== ':' && ch !== '"') this.expectPathValue = false;

    this.lastSignificant = ch;
    return null;
  }

  /** Consume one character inside a JSON string, honouring split escapes. */
  private stepInString(ch: string): string | null {
    if (this.unicode !== null) {
      this.unicode += ch;
      if (this.unicode.length === 4) {
        const code = Number.parseInt(this.unicode, 16);
        this.unicode = null;
        // A malformed `\uXXXX` means this is not a string we can read.
        if (!Number.isFinite(code)) return this.abandon();
        this.append(String.fromCharCode(code));
      }
      return null;
    }

    if (this.escaping) {
      this.escaping = false;
      if (ch === 'u') {
        this.unicode = '';
        return null;
      }
      this.append(UNESCAPE[ch] ?? ch);
      return null;
    }

    if (ch === '\\') {
      this.escaping = true;
      return null;
    }

    if (ch !== '"') {
      this.append(ch);
      return null;
    }

    // Closing quote: the string is now provably complete.
    this.inString = false;
    const captured = this.capture;
    const value = this.buf;
    const overflowed = this.overflowed;
    this.capture = 'none';
    this.buf = '';
    this.overflowed = false;
    this.lastSignificant = '"';

    if (captured === 'key' && !overflowed) {
      this.pendingKey = value;
      this.expectColon = true;
      return null;
    }
    if (captured === 'path' && !overflowed && value.length > 0) return value;
    return null;
  }

  /** Stop reading the current string without producing anything. */
  private abandon(): null {
    this.capture = 'none';
    this.buf = '';
    this.overflowed = true;
    return null;
  }

  private append(ch: string): void {
    if (this.capture === 'none' || this.overflowed) return;
    const limit = this.capture === 'key' ? MAX_KEY_CHARS : MAX_PATH_CHARS;
    if (this.buf.length >= limit) {
      // Too long to be what we are looking for — stop buffering, keep scanning
      // structure so the rest of the document still parses correctly.
      this.buf = '';
      this.overflowed = true;
      return;
    }
    this.buf += ch;
  }
}

const UNESCAPE: Readonly<Record<string, string>> = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
};
