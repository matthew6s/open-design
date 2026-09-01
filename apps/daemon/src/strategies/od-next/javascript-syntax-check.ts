import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { TextDecoder } from 'node:util';

import { parse } from '@babel/parser';
import { load } from 'cheerio';

export const DEFAULT_OD_NEXT_JAVASCRIPT_SYNTAX_TIMEOUT_MS = 2_000;
export const MAX_OD_NEXT_JAVASCRIPT_ENTRY_BYTES = 2 * 1024 * 1024;
export const MAX_OD_NEXT_JAVASCRIPT_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_OD_NEXT_JAVASCRIPT_TOTAL_SOURCE_BYTES = 8 * 1024 * 1024;
export const MAX_OD_NEXT_JAVASCRIPT_SOURCES = 500;

export const OD_NEXT_JAVASCRIPT_SYNTAX_CHECKER_VERSION =
  'open-design.od-next-javascript-syntax-check/v1';
/**
 * SHA-256 of the v1 semantic identity: Babel browser ECMAScript parsing,
 * classic/module/event-handler coverage, the reachable local module graph,
 * realpath-based project-root containment, fail-open incomplete precedence,
 * stable checked-file attribution, strict UTF-8, and the exported limits.
 * Bump both version and hash whenever any of those semantics changes.
 */
export const OD_NEXT_JAVASCRIPT_SYNTAX_CHECKER_HASH =
  '97ccc1578d5422ce1edaa8962d3b46da8d30f45dc14f343257ee4bbfe5a5aa12';

export type OdNextJavaScriptKind = 'classic' | 'module' | 'event_handler';

export interface OdNextJavaScriptSyntaxDiagnostic {
  file: string;
  scriptKind: OdNextJavaScriptKind;
  line: number;
  column: number;
  errorType: 'SyntaxError';
  message: string;
  sourceExcerpt: string;
}

export type OdNextJavaScriptSyntaxCheckIncompleteReason =
  | 'entry_unsupported'
  | 'entry_unreadable'
  | 'invalid_encoding'
  | 'dependency_unreadable'
  | 'dependency_unsupported'
  | 'limit_exceeded'
  | 'parser_failure'
  | 'timeout'
  | 'unsupported_event_handler_mapping';

export type OdNextJavaScriptSyntaxCheckResult =
  | {
      status: 'no_syntax_error_found';
      checkedSources: number;
      checkedFiles: string[];
    }
  | {
      status: 'syntax_error';
      checkedSources: number;
      checkedFiles: string[];
      errors: OdNextJavaScriptSyntaxDiagnostic[];
    }
  | {
      status: 'check_incomplete';
      checkedSources: number;
      checkedFiles: string[];
      reason: OdNextJavaScriptSyntaxCheckIncompleteReason;
      /** Operational context only. Source text belongs exclusively in diagnostics. */
      detail: string;
    };

export interface CheckOdNextJavaScriptSyntaxInput {
  projectRoot: string;
  /** Canonical deliverable path, relative to projectRoot. */
  entryFile: string;
  timeoutMs?: number;
}

interface SourceLocation {
  startLine: number;
  startCol: number;
  startOffset: number;
  endLine: number;
  endCol: number;
  endOffset: number;
}

interface ElementSourceLocation extends SourceLocation {
  attrs?: Record<string, SourceLocation>;
  startTag?: SourceLocation & { attrs?: Record<string, SourceLocation> };
  endTag?: SourceLocation;
}

interface HtmlElement {
  tagName?: string;
  name?: string;
  attribs?: Record<string, string>;
  parent?: HtmlElement | null;
  sourceCodeLocation?: ElementSourceLocation;
}

interface ExternalSource {
  file: string;
  scriptKind: 'classic' | 'module';
}

interface IncompleteFinding {
  reason: OdNextJavaScriptSyntaxCheckIncompleteReason;
  detail: string;
}

interface ParsedSource {
  imports: string[];
  diagnostics: OdNextJavaScriptSyntaxDiagnostic[];
  parserFailed: boolean;
}

interface DiagnosticOrigin {
  file: string;
  scriptKind: OdNextJavaScriptKind;
  containerSource: string;
  sourceStartOffset?: number;
}

interface LocalReference {
  kind: 'local';
  file: string;
}

type ReferenceResolution =
  | LocalReference
  | { kind: 'skip' }
  | { kind: 'unsupported'; detail: string };

const JAVASCRIPT_EXTENSIONS = new Set(['.cjs', '.js', '.mjs']);
const TRANSPILED_JAVASCRIPT_EXTENSIONS = new Set(['.jsx', '.ts', '.tsx']);
const HTML_EXTENSIONS = new Set(['.htm', '.html']);

/**
 * Controlled HTML/SVG standard event-handler attributes. This is deliberately
 * an allowlist: arbitrary `on*` attributes may be framework data or custom
 * element inputs and must not be interpreted as browser JavaScript.
 */
const STANDARD_EVENT_HANDLER_ATTRIBUTES = new Set([
  'onabort',
  'onactivate',
  'onafterprint',
  'onanimationcancel',
  'onanimationend',
  'onanimationiteration',
  'onanimationstart',
  'onauxclick',
  'onbeforeinput',
  'onbeforematch',
  'onbeforeprint',
  'onbeforetoggle',
  'onbeforeunload',
  'onbegin',
  'onblur',
  'oncancel',
  'oncanplay',
  'oncanplaythrough',
  'onchange',
  'onclick',
  'onclose',
  'oncommand',
  'oncontentvisibilityautostatechange',
  'oncontextlost',
  'oncontextmenu',
  'oncontextrestored',
  'oncopy',
  'oncuechange',
  'oncut',
  'ondblclick',
  'ondrag',
  'ondragend',
  'ondragenter',
  'ondragleave',
  'ondragover',
  'ondragstart',
  'ondrop',
  'ondurationchange',
  'onemptied',
  'onencrypted',
  'onend',
  'onended',
  'onenterpictureinpicture',
  'onerror',
  'onfocus',
  'onfocusin',
  'onfocusout',
  'onformdata',
  'onfullscreenchange',
  'onfullscreenerror',
  'ongamepadconnected',
  'ongamepaddisconnected',
  'ongotpointercapture',
  'onhashchange',
  'oninput',
  'oninvalid',
  'onkeydown',
  'onkeypress',
  'onkeyup',
  'onlanguagechange',
  'onleavepictureinpicture',
  'onload',
  'onloadeddata',
  'onloadedmetadata',
  'onloadstart',
  'onlostpointercapture',
  'onmessage',
  'onmessageerror',
  'onmousedown',
  'onmouseenter',
  'onmouseleave',
  'onmousemove',
  'onmouseout',
  'onmouseover',
  'onmouseup',
  'onoffline',
  'ononline',
  'onpagehide',
  'onpageshow',
  'onpaste',
  'onpause',
  'onplay',
  'onplaying',
  'onpointercancel',
  'onpointerdown',
  'onpointerenter',
  'onpointerleave',
  'onpointermove',
  'onpointerout',
  'onpointerover',
  'onpointerrawupdate',
  'onpointerup',
  'onpopstate',
  'onprogress',
  'onratechange',
  'onreadystatechange',
  'onrejectionhandled',
  'onrepeat',
  'onreset',
  'onresize',
  'onscroll',
  'onscrollend',
  'onsecuritypolicyviolation',
  'onseeked',
  'onseeking',
  'onselect',
  'onselectionchange',
  'onselectstart',
  'onslotchange',
  'onstalled',
  'onstorage',
  'onsubmit',
  'onsuspend',
  'ontimeupdate',
  'ontoggle',
  'ontouchcancel',
  'ontouchend',
  'ontouchmove',
  'ontouchstart',
  'ontransitioncancel',
  'ontransitionend',
  'ontransitionrun',
  'ontransitionstart',
  'onunhandledrejection',
  'onunload',
  'onvisibilitychange',
  'onvolumechange',
  'onwaiting',
  'onwaitingforkey',
  'onwheel',
  'onzoom',
]);

const SCRIPT_KIND_ORDER: Record<OdNextJavaScriptKind, number> = {
  classic: 0,
  module: 1,
  event_handler: 2,
};

/**
 * Parse browser-executable JavaScript reachable from one canonical HTML
 * deliverable. The check is static and never launches a browser or evaluates
 * project code.
 */
export async function checkOdNextJavaScriptSyntax(
  input: CheckOdNextJavaScriptSyntaxInput,
): Promise<OdNextJavaScriptSyntaxCheckResult> {
  const entryFile = normalizeEntryFile(input.entryFile);
  if (!entryFile || !HTML_EXTENSIONS.has(path.posix.extname(entryFile).toLowerCase())) {
    return {
      status: 'check_incomplete',
      checkedSources: 0,
      checkedFiles: [],
      reason: 'entry_unsupported',
      detail: 'The canonical deliverable must be a project-relative HTML file.',
    };
  }

  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const startedAt = performance.now();
  const timedOut = (): boolean => timeoutMs <= 0 || performance.now() - startedAt >= timeoutMs;
  if (timedOut()) return timeoutResult(0, [], timeoutMs);

  let projectRoot: string;
  try {
    projectRoot = await fs.realpath(path.resolve(input.projectRoot));
  } catch {
    return {
      status: 'check_incomplete',
      checkedSources: 0,
      checkedFiles: [],
      reason: 'entry_unreadable',
      detail: `Could not resolve the project root for canonical deliverable ${entryFile}.`,
    };
  }
  const entry = await readProjectUtf8File(
    projectRoot,
    entryFile,
    MAX_OD_NEXT_JAVASCRIPT_ENTRY_BYTES,
  );
  if (entry.kind === 'unreadable') {
    return {
      status: 'check_incomplete',
      checkedSources: 0,
      checkedFiles: [],
      reason: 'entry_unreadable',
      detail: `Could not read canonical deliverable ${entryFile}.`,
    };
  }
  if (entry.kind === 'invalid_encoding') {
    return {
      status: 'check_incomplete',
      checkedSources: 0,
      checkedFiles: [],
      reason: 'invalid_encoding',
      detail: `Canonical deliverable ${entryFile} is not valid UTF-8.`,
    };
  }
  if (entry.kind === 'too_large') {
    return {
      status: 'check_incomplete',
      checkedSources: 0,
      checkedFiles: [],
      reason: 'limit_exceeded',
      detail: `Canonical deliverable ${entryFile} exceeds the static syntax-check size limit.`,
    };
  }
  if (timedOut()) return timeoutResult(0, [], timeoutMs);

  let $: ReturnType<typeof load>;
  try {
    $ = load(entry.source, { sourceCodeLocationInfo: true });
  } catch {
    return {
      status: 'check_incomplete',
      checkedSources: 0,
      checkedFiles: [],
      reason: 'parser_failure',
      detail: `Could not inspect canonical deliverable ${entryFile}.`,
    };
  }
  if (timedOut()) return timeoutResult(0, [], timeoutMs);

  const diagnostics: OdNextJavaScriptSyntaxDiagnostic[] = [];
  const incomplete: IncompleteFinding[] = [];
  const externalQueue: ExternalSource[] = [];
  const scheduledExternal = new Set<string>();
  const checkedFileSet = new Set<string>();
  let checkedSources = 0;
  let checkedSourceBytes = 0;
  let sourceLimitReached = false;
  const hasBaseReference = $('base[href]').length > 0;

  const markIncomplete = (
    reason: OdNextJavaScriptSyntaxCheckIncompleteReason,
    detail: string,
  ): void => {
    incomplete.push({ reason, detail });
  };
  if (hasBaseReference) {
    markIncomplete(
      'entry_unsupported',
      `Canonical deliverable ${entryFile} uses a base URL that the static syntax check cannot resolve.`,
    );
  }

  const reserveSourceBudget = (source: string, file: string): boolean => {
    if (sourceLimitReached) return false;
    if (checkedSources >= MAX_OD_NEXT_JAVASCRIPT_SOURCES) {
      sourceLimitReached = true;
      markIncomplete(
        'limit_exceeded',
        `JavaScript syntax check exceeded its ${MAX_OD_NEXT_JAVASCRIPT_SOURCES}-source limit.`,
      );
      return false;
    }
    const sourceBytes = Buffer.byteLength(source, 'utf8');
    if (checkedSourceBytes + sourceBytes > MAX_OD_NEXT_JAVASCRIPT_TOTAL_SOURCE_BYTES) {
      sourceLimitReached = true;
      markIncomplete(
        'limit_exceeded',
        `JavaScript syntax check exceeded its ${MAX_OD_NEXT_JAVASCRIPT_TOTAL_SOURCE_BYTES}-byte total source limit.`,
      );
      return false;
    }
    checkedSources += 1;
    checkedSourceBytes += sourceBytes;
    checkedFileSet.add(file);
    return true;
  };

  const enqueueExternal = (
    ownerFile: string,
    specifier: string,
    scriptKind: 'classic' | 'module',
    source: 'html' | 'import',
  ): void => {
    // Relative URLs and inline-module imports resolve against <base>. Do not
    // pretend entry-relative resolution is exact when one is present.
    if (hasBaseReference && ownerFile === entryFile) return;
    const resolution = resolveProjectReference(ownerFile, specifier, source === 'html');
    if (resolution.kind === 'skip') return;
    if (resolution.kind === 'unsupported') {
      markIncomplete('dependency_unsupported', resolution.detail);
      return;
    }
    const extension = path.posix.extname(resolution.file).toLowerCase();
    if (!JAVASCRIPT_EXTENSIONS.has(extension)) {
      if (
        source === 'import'
        && extension
        && !TRANSPILED_JAVASCRIPT_EXTENSIONS.has(extension)
      ) return;
      markIncomplete(
        'dependency_unsupported',
        `Referenced local script ${resolution.file} has an unsupported file type.`,
      );
      return;
    }
    const key = `${scriptKind}\0${resolution.file}`;
    if (scheduledExternal.has(key)) return;
    if (scheduledExternal.size >= MAX_OD_NEXT_JAVASCRIPT_SOURCES) {
      sourceLimitReached = true;
      markIncomplete(
        'limit_exceeded',
        `JavaScript syntax check exceeded its ${MAX_OD_NEXT_JAVASCRIPT_SOURCES}-source limit.`,
      );
      return;
    }
    scheduledExternal.add(key);
    externalQueue.push({ file: resolution.file, scriptKind });
  };

  const parseReachableSource = (
    source: string,
    scriptKind: OdNextJavaScriptKind,
    origin: DiagnosticOrigin,
    ownerFile: string,
  ): void => {
    if (!reserveSourceBudget(source, ownerFile)) return;
    const parsed = parseJavaScriptSource(source, scriptKind, origin);
    diagnostics.push(...parsed.diagnostics);
    if (parsed.parserFailed) {
      markIncomplete('parser_failure', `Could not inspect JavaScript in ${ownerFile}.`);
      return;
    }
    if (timedOut()) return;
    for (const specifier of parsed.imports) {
      enqueueExternal(ownerFile, specifier, 'module', 'import');
    }
  };

  for (const rawNode of $('script').toArray()) {
    if (timedOut() || sourceLimitReached) break;
    const node = rawNode as unknown as HtmlElement;
    if (isInsideTemplate(node)) continue;
    const location = node.sourceCodeLocation;
    const startTag = location?.startTag;
    if (!location || !startTag) continue;
    const attributes = node.attribs ?? {};
    const scriptKind = classifyScriptType(attributes.type ?? '');
    if (scriptKind === 'data') continue;

    if (Object.hasOwn(attributes, 'src')) {
      const src = attributes.src?.trim() ?? '';
      if (!src) {
        markIncomplete(
          'dependency_unsupported',
          `A ${scriptKind} script in ${entryFile} has an empty src attribute.`,
        );
      } else {
        enqueueExternal(entryFile, src, scriptKind, 'html');
      }
      continue;
    }

    const bodyStart = startTag.endOffset;
    const bodyEnd = location.endTag?.startOffset ?? location.endOffset;
    const source = entry.source.slice(bodyStart, bodyEnd);
    if (!source.trim()) continue;
    parseReachableSource(
      source,
      scriptKind,
      {
        file: entryFile,
        scriptKind,
        containerSource: entry.source,
        sourceStartOffset: bodyStart,
      },
      entryFile,
    );
  }

  for (const rawNode of $('*').toArray()) {
    if (timedOut() || sourceLimitReached) break;
    const node = rawNode as unknown as HtmlElement;
    if (isInsideTemplate(node)) continue;
    const attributes = node.attribs ?? {};
    for (const attributeName of Object.keys(attributes).sort()) {
      if (!STANDARD_EVENT_HANDLER_ATTRIBUTES.has(attributeName.toLowerCase())) continue;
      const source = attributes[attributeName] ?? '';
      if (!source.trim()) continue;
      if (!reserveSourceBudget(source, entryFile)) break;
      const parsed = parseJavaScriptSource(source, 'event_handler', {
        file: entryFile,
        scriptKind: 'event_handler',
        containerSource: entry.source,
        sourceStartOffset: eventHandlerValueOffset(entry.source, node, attributeName, source),
      });
      if (parsed.parserFailed) {
        markIncomplete('parser_failure', `Could not inspect an event handler in ${entryFile}.`);
        continue;
      }
      if (timedOut()) break;
      if (parsed.diagnostics.length > 0 && parsed.diagnostics.some((item) => item.line < 1)) {
        markIncomplete(
          'unsupported_event_handler_mapping',
          `Could not map an event-handler syntax error precisely in ${entryFile}.`,
        );
      } else {
        diagnostics.push(...parsed.diagnostics);
      }
      for (const specifier of parsed.imports) {
        enqueueExternal(entryFile, specifier, 'module', 'import');
      }
    }
  }

  let queueIndex = 0;
  while (queueIndex < externalQueue.length) {
    if (timedOut() || sourceLimitReached) break;
    const sourceUnit = externalQueue[queueIndex];
    queueIndex += 1;
    if (!sourceUnit) continue;
    const loaded = await readProjectUtf8File(
      projectRoot,
      sourceUnit.file,
      MAX_OD_NEXT_JAVASCRIPT_SOURCE_BYTES,
    );
    if (timedOut()) break;
    if (loaded.kind === 'unreadable') {
      markIncomplete(
        'dependency_unreadable',
        `Could not read referenced local script ${sourceUnit.file}.`,
      );
      continue;
    }
    if (loaded.kind === 'invalid_encoding') {
      markIncomplete(
        'invalid_encoding',
        `Referenced local script ${sourceUnit.file} is not valid UTF-8.`,
      );
      continue;
    }
    if (loaded.kind === 'too_large') {
      markIncomplete(
        'limit_exceeded',
        `Referenced local script ${sourceUnit.file} exceeds the static syntax-check size limit.`,
      );
      continue;
    }
    parseReachableSource(
      loaded.source,
      sourceUnit.scriptKind,
      {
        file: sourceUnit.file,
        scriptKind: sourceUnit.scriptKind,
        containerSource: loaded.source,
      },
      sourceUnit.file,
    );
  }

  diagnostics.sort(compareDiagnostics);
  const checkedFiles = [...checkedFileSet].sort(compareText);
  // A partial check cannot confirm the complete error set. Fail open even when
  // a checked subset already contained a deterministic syntax error.
  if (timedOut()) return timeoutResult(checkedSources, checkedFiles, timeoutMs);
  if (incomplete.length > 0) {
    incomplete.sort((left, right) => (
      compareText(left.reason, right.reason) || compareText(left.detail, right.detail)
    ));
    const first = incomplete[0]!;
    return {
      status: 'check_incomplete',
      checkedSources,
      checkedFiles,
      reason: first.reason,
      detail: first.detail,
    };
  }
  if (diagnostics.length > 0) {
    return {
      status: 'syntax_error',
      checkedSources,
      checkedFiles,
      errors: diagnostics,
    };
  }
  return { status: 'no_syntax_error_found', checkedSources, checkedFiles };
}

function parseJavaScriptSource(
  source: string,
  scriptKind: OdNextJavaScriptKind,
  origin: DiagnosticOrigin,
): ParsedSource {
  try {
    const ast = parse(source, {
      sourceType: scriptKind === 'module' ? 'module' : 'script',
      allowReturnOutsideFunction: scriptKind === 'event_handler',
      errorRecovery: true,
      plugins: ['dynamicImport', 'importAttributes', 'importMeta', 'topLevelAwait'],
    });
    return {
      imports: collectImportSpecifiers(ast),
      diagnostics: (ast.errors ?? []).map((error) => (
        diagnosticFromSyntaxError(error, source, origin)
      )),
      parserFailed: false,
    };
  } catch (error) {
    if (!isParserSyntaxError(error)) {
      return { imports: [], diagnostics: [], parserFailed: true };
    }
    return {
      imports: [],
      diagnostics: [diagnosticFromSyntaxError(error, source, origin)],
      parserFailed: false,
    };
  }
}

function diagnosticFromSyntaxError(
  error: unknown,
  source: string,
  origin: DiagnosticOrigin,
): OdNextJavaScriptSyntaxDiagnostic {
  const local = parserErrorPosition(error, source);
  const canMapToContainer = origin.sourceStartOffset !== undefined;
  const mapped = canMapToContainer
    ? lineColumnAtOffset(origin.containerSource, origin.sourceStartOffset! + local.offset)
    : { line: local.line, column: local.column };
  return {
    file: origin.file,
    scriptKind: origin.scriptKind,
    line: canMapToContainer && origin.sourceStartOffset! < 0 ? -1 : mapped.line,
    column: canMapToContainer && origin.sourceStartOffset! < 0 ? -1 : mapped.column,
    errorType: 'SyntaxError',
    message: parserErrorMessage(error),
    sourceExcerpt: minimalSourceExcerpt(source, local.line, local.column),
  };
}

function parserErrorPosition(
  error: unknown,
  source: string,
): { offset: number; line: number; column: number } {
  const record = asRecord(error);
  const location = asRecord(record?.loc);
  const line = positiveInteger(location?.line) ?? 1;
  const zeroBasedColumn = nonNegativeInteger(location?.column) ?? 0;
  const offset = nonNegativeInteger(record?.pos)
    ?? offsetAtLineColumn(source, line, zeroBasedColumn);
  return { offset, line, column: zeroBasedColumn + 1 };
}

function parserErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'JavaScript parser reported invalid syntax.';
  return raw.replace(/\s+\(\d+:\d+\)$/u, '');
}

function minimalSourceExcerpt(source: string, line: number, column: number): string {
  const sourceLine = source.split(/\r\n|\r|\n/u)[line - 1] ?? '';
  const maximumLength = 120;
  if (sourceLine.length <= maximumLength) return sourceLine;
  const zeroBasedColumn = Math.max(0, column - 1);
  const start = Math.max(0, Math.min(zeroBasedColumn - 40, sourceLine.length - maximumLength));
  const end = Math.min(sourceLine.length, start + maximumLength);
  return `${start > 0 ? '…' : ''}${sourceLine.slice(start, end)}${end < sourceLine.length ? '…' : ''}`;
}

function collectImportSpecifiers(value: unknown): string[] {
  const imports: string[] = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    const node = asRecord(candidate);
    if (!node || typeof node.type !== 'string') return;

    if (
      node.type === 'ImportDeclaration'
      || node.type === 'ExportNamedDeclaration'
      || node.type === 'ExportAllDeclaration'
    ) {
      const source = asRecord(node.source);
      const specifier = staticStringValue(source);
      if (specifier !== null) imports.push(specifier);
    } else if (node.type === 'ImportExpression') {
      const source = asRecord(node.source);
      const specifier = staticStringValue(source);
      if (specifier !== null) imports.push(specifier);
    } else if (node.type === 'CallExpression') {
      const callee = asRecord(node.callee);
      const args = Array.isArray(node.arguments) ? node.arguments : [];
      const source = asRecord(args[0]);
      const specifier = staticStringValue(source);
      if (callee?.type === 'Import' && specifier !== null) {
        imports.push(specifier);
      }
    }

    for (const child of Object.values(node)) {
      if (Array.isArray(child) || (asRecord(child)?.type !== undefined)) visit(child);
    }
  };
  visit(value);
  return imports;
}

function staticStringValue(node: Record<string, unknown> | null): string | null {
  if (typeof node?.value === 'string') return node.value;
  if (node?.type !== 'TemplateLiteral') return null;
  if (Array.isArray(node.expressions) && node.expressions.length > 0) return null;
  const quasis = Array.isArray(node.quasis) ? node.quasis : [];
  const first = asRecord(quasis[0]);
  const value = asRecord(first?.value);
  return typeof value?.cooked === 'string'
    ? value.cooked
    : typeof value?.raw === 'string'
      ? value.raw
      : null;
}

function classifyScriptType(type: string): 'classic' | 'data' | 'module' {
  const normalized = type.trim().toLowerCase();
  if (normalized === 'module') return 'module';
  if (!normalized || isJavaScriptMimeType(normalized)) return 'classic';
  return 'data';
}

function isJavaScriptMimeType(type: string): boolean {
  const essence = type.split(';', 1)[0]?.trim() ?? '';
  return /^(?:(?:application|text)\/(?:x-)?(?:java|ecma)script|text\/(?:javascript1\.[0-5]|jscript|livescript))$/u
    .test(essence);
}

function isInsideTemplate(node: HtmlElement): boolean {
  let current: HtmlElement | null | undefined = node;
  while (current) {
    const tagName = (current.tagName ?? current.name)?.toLowerCase();
    if (tagName === 'template' || tagName === 'noscript') return true;
    current = current.parent;
  }
  return false;
}

function eventHandlerValueOffset(
  html: string,
  node: HtmlElement,
  attributeName: string,
  decodedSource: string,
): number {
  const location = node.sourceCodeLocation?.attrs?.[attributeName.toLowerCase()]
    ?? node.sourceCodeLocation?.startTag?.attrs?.[attributeName.toLowerCase()];
  if (!location) return -1;
  const rawAttribute = html.slice(location.startOffset, location.endOffset);
  const equalsIndex = rawAttribute.indexOf('=');
  if (equalsIndex < 0) return decodedSource ? -1 : location.endOffset;
  let valueIndex = equalsIndex + 1;
  while (/\s/u.test(rawAttribute[valueIndex] ?? '')) valueIndex += 1;
  const quote = rawAttribute[valueIndex];
  if (quote === '"' || quote === "'") valueIndex += 1;
  const rawEnd = quote === '"' || quote === "'"
    ? rawAttribute.lastIndexOf(quote)
    : rawAttribute.length;
  if (rawEnd < valueIndex) return -1;
  const rawValue = rawAttribute.slice(valueIndex, rawEnd);
  return rawValue === decodedSource ? location.startOffset + valueIndex : -1;
}

function resolveProjectReference(
  ownerFile: string,
  rawReference: string,
  allowDocumentRelativeBare: boolean,
): ReferenceResolution {
  const reference = rawReference.trim();
  if (!reference || reference.startsWith('#')) return { kind: 'skip' };
  if (reference.includes('\\') || reference.includes('\0')) {
    return { kind: 'unsupported', detail: `A local script reference in ${ownerFile} uses an unsupported path.` };
  }
  if (
    /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(reference)
    || /^\/(?:api|artifacts|frames)(?:\/|$)/u.test(reference)
  ) return { kind: 'skip' };

  const cutIndexes = [reference.indexOf('?'), reference.indexOf('#')].filter((index) => index >= 0);
  const encodedPath = reference.slice(0, cutIndexes.length > 0 ? Math.min(...cutIndexes) : undefined);
  if (!encodedPath) return { kind: 'skip' };
  if (!allowDocumentRelativeBare && !encodedPath.startsWith('.') && !encodedPath.startsWith('/')) {
    return { kind: 'skip' };
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(encodedPath);
  } catch {
    return {
      kind: 'unsupported',
      detail: `A local script reference in ${ownerFile} has invalid URL encoding.`,
    };
  }
  if (decodedPath.includes('\\') || decodedPath.includes('\0')) {
    return {
      kind: 'unsupported',
      detail: `A local script reference in ${ownerFile} uses an unsupported path.`,
    };
  }
  const joined = decodedPath.startsWith('/')
    ? decodedPath.replace(/^\/+/, '')
    : path.posix.join(path.posix.dirname(ownerFile), decodedPath);
  const normalized = path.posix.normalize(joined).replace(/^\.\//u, '');
  if (
    !normalized
    || normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
    || path.posix.isAbsolute(normalized)
  ) {
    return {
      kind: 'unsupported',
      detail: `A local script reference in ${ownerFile} escapes the project root.`,
    };
  }
  return { kind: 'local', file: normalized };
}

function normalizeEntryFile(value: string): string | null {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return null;
  const slashPath = value.trim().replaceAll('\\', '/');
  if (path.posix.isAbsolute(slashPath) || /^[a-z]:\//iu.test(slashPath)) return null;
  const normalized = path.posix.normalize(slashPath).replace(/^\.\//u, '');
  if (
    !normalized
    || normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
  ) return null;
  return normalized;
}

async function readProjectUtf8File(
  projectRoot: string,
  projectFile: string,
  maximumBytes: number,
): Promise<
  | { kind: 'loaded'; source: string }
  | { kind: 'unreadable' }
  | { kind: 'invalid_encoding' }
  | { kind: 'too_large' }
> {
  const absolute = path.resolve(projectRoot, ...projectFile.split('/'));
  const relative = path.relative(projectRoot, absolute);
  if (
    !relative
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    return { kind: 'unreadable' };
  }
  let resolvedFile: string;
  try {
    resolvedFile = await fs.realpath(absolute);
  } catch {
    return { kind: 'unreadable' };
  }
  const resolvedRelative = path.relative(projectRoot, resolvedFile);
  if (
    !resolvedRelative
    || resolvedRelative === '..'
    || resolvedRelative.startsWith(`..${path.sep}`)
    || path.isAbsolute(resolvedRelative)
  ) {
    return { kind: 'unreadable' };
  }
  try {
    const stats = await fs.stat(resolvedFile);
    if (!stats.isFile()) return { kind: 'unreadable' };
    if (stats.size > maximumBytes) return { kind: 'too_large' };
  } catch {
    return { kind: 'unreadable' };
  }
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(resolvedFile);
  } catch {
    return { kind: 'unreadable' };
  }
  if (buffer.byteLength > maximumBytes) return { kind: 'too_large' };
  try {
    return {
      kind: 'loaded',
      source: new TextDecoder('utf-8', { fatal: true }).decode(buffer),
    };
  } catch {
    return { kind: 'invalid_encoding' };
  }
}

function lineColumnAtOffset(source: string, requestedOffset: number): { line: number; column: number } {
  const offset = Math.max(0, Math.min(requestedOffset, source.length));
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset; index += 1) {
    const character = source[index];
    if (character === '\r') {
      if (source[index + 1] === '\n' && index + 1 < offset) index += 1;
      line += 1;
      column = 1;
    } else if (character === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function offsetAtLineColumn(source: string, requestedLine: number, zeroBasedColumn: number): number {
  let line = 1;
  let offset = 0;
  while (offset < source.length && line < requestedLine) {
    if (source[offset] === '\r') {
      offset += source[offset + 1] === '\n' ? 2 : 1;
      line += 1;
    } else if (source[offset] === '\n') {
      offset += 1;
      line += 1;
    } else {
      offset += 1;
    }
  }
  return Math.min(source.length, offset + zeroBasedColumn);
}

function compareDiagnostics(
  left: OdNextJavaScriptSyntaxDiagnostic,
  right: OdNextJavaScriptSyntaxDiagnostic,
): number {
  return compareText(left.file, right.file)
    || SCRIPT_KIND_ORDER[left.scriptKind] - SCRIPT_KIND_ORDER[right.scriptKind]
    || left.line - right.line
    || left.column - right.column
    || compareText(left.message, right.message)
    || compareText(left.sourceExcerpt, right.sourceExcerpt);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_OD_NEXT_JAVASCRIPT_SYNTAX_TIMEOUT_MS;
  if (!Number.isFinite(value)) return DEFAULT_OD_NEXT_JAVASCRIPT_SYNTAX_TIMEOUT_MS;
  return Math.max(0, value);
}

function timeoutResult(
  checkedSources: number,
  checkedFiles: string[],
  timeoutMs: number,
): OdNextJavaScriptSyntaxCheckResult {
  return {
    status: 'check_incomplete',
    checkedSources,
    checkedFiles,
    reason: 'timeout',
    detail: `JavaScript syntax check exceeded its ${timeoutMs} ms budget.`,
  };
}

function isParserSyntaxError(value: unknown): boolean {
  return value instanceof SyntaxError || asRecord(value)?.name === 'SyntaxError';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}
