import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_OD_NEXT_JAVASCRIPT_ENTRY_BYTES,
  MAX_OD_NEXT_JAVASCRIPT_SOURCE_BYTES,
  MAX_OD_NEXT_JAVASCRIPT_SOURCES,
  MAX_OD_NEXT_JAVASCRIPT_TOTAL_SOURCE_BYTES,
  OD_NEXT_JAVASCRIPT_SYNTAX_CHECKER_HASH,
  OD_NEXT_JAVASCRIPT_SYNTAX_CHECKER_VERSION,
  checkOdNextJavaScriptSyntax,
} from '../../../src/strategies/od-next/javascript-syntax-check.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) => (
    fs.rm(root, { recursive: true, force: true })
  )));
});

async function project(files: Record<string, string | Uint8Array>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-next-js-syntax-'));
  temporaryRoots.push(root);
  for (const [file, body] of Object.entries(files)) {
    const absolute = path.join(root, ...file.split('/'));
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, body);
  }
  return root;
}

describe('checkOdNextJavaScriptSyntax', () => {
  it('exports a stable versioned checker identity', () => {
    expect(OD_NEXT_JAVASCRIPT_SYNTAX_CHECKER_VERSION)
      .toBe('open-design.od-next-javascript-syntax-check/v1');
    expect(OD_NEXT_JAVASCRIPT_SYNTAX_CHECKER_HASH)
      .toBe('97ccc1578d5422ce1edaa8962d3b46da8d30f45dc14f343257ee4bbfe5a5aa12');
    expect(OD_NEXT_JAVASCRIPT_SYNTAX_CHECKER_HASH).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('checks effective inline, handler, referenced, and recursively imported local JavaScript', async () => {
    const projectRoot = await project({
      'index.html': `<!doctype html><html><head>
        <script>window.started = true; import(\`./modules/lazy.js\`);</script>
        <script type="module">import './modules/main.js';</script>
        <script src="./scripts/classic.js"></script>
        <script src="https://cdn.example.com/unchecked.js"></script>
        <script type="application/json">{"not":"javascript"}</script>
        <script type="importmap">{"imports":{"bad":"./bad.js"}}</script>
        <script type="text/x-template">const broken = ;</script>
        <style>.card { color: red; }</style>
      </head><body>
        <button onclick="return window.run(event)">Run</button>
        <div onmadeup="const broken = ;"></div>
        <template><script>const broken = ;</script><button onclick="broken("></button></template>
      </body></html>`,
      'scripts/classic.js': 'window.run = (event) => Boolean(event);',
      'modules/lazy.js': "import './shared.js'; export const lazy = true;",
      'modules/main.js': "export { shared } from './shared.js';",
      'modules/shared.js': 'export const shared = true;',
      'bad.js': 'export const broken = ;',
    });

    await expect(checkOdNextJavaScriptSyntax({ projectRoot, entryFile: 'index.html' }))
      .resolves.toEqual({
        status: 'no_syntax_error_found',
        checkedSources: 7,
        checkedFiles: [
          'index.html',
          'modules/lazy.js',
          'modules/main.js',
          'modules/shared.js',
          'scripts/classic.js',
        ],
      });
  });

  it('aggregates deterministic errors and maps inline and handler locations to HTML coordinates', async () => {
    const projectRoot = await project({
      'index.html': `<!doctype html>
<script>
const inlineBroken = ;
</script>
<script type="module">
export const moduleBroken = ;
</script>
<button
  onclick="if (ready) {
    run(;
  }">Go</button>
<script src="scripts/classic.js"></script>
<script type="module" src="scripts/root.js"></script>`,
      'scripts/classic.js': 'function classicBroken( {',
      'scripts/root.js': "import './nested.js';",
      'scripts/nested.js': 'export const nestedBroken = ;',
    });

    const result = await checkOdNextJavaScriptSyntax({ projectRoot, entryFile: 'index.html' });

    expect(result.status).toBe('syntax_error');
    if (result.status !== 'syntax_error') return;
    expect(result.checkedSources).toBe(6);
    expect(result.checkedFiles).toEqual([
      'index.html',
      'scripts/classic.js',
      'scripts/nested.js',
      'scripts/root.js',
    ]);
    expect(result.errors).toHaveLength(5);
    expect(result.errors.map(({ file, scriptKind }) => ({ file, scriptKind }))).toEqual([
      { file: 'index.html', scriptKind: 'classic' },
      { file: 'index.html', scriptKind: 'module' },
      { file: 'index.html', scriptKind: 'event_handler' },
      { file: 'scripts/classic.js', scriptKind: 'classic' },
      { file: 'scripts/nested.js', scriptKind: 'module' },
    ]);
    expect(result.errors[0]).toMatchObject({
      file: 'index.html',
      scriptKind: 'classic',
      line: 3,
      errorType: 'SyntaxError',
      sourceExcerpt: 'const inlineBroken = ;',
    });
    expect(result.errors[2]).toMatchObject({
      file: 'index.html',
      scriptKind: 'event_handler',
      line: 10,
      column: 9,
      errorType: 'SyntaxError',
      sourceExcerpt: '    run(;',
    });
    for (const diagnostic of result.errors) {
      expect(diagnostic.line).toBeGreaterThan(0);
      expect(diagnostic.column).toBeGreaterThan(0);
      expect(diagnostic.message).not.toMatch(/\(\d+:\d+\)$/u);
      expect(diagnostic.sourceExcerpt.length).toBeLessThanOrEqual(122);
    }
  });

  it('uses browser classic and module grammars even when the same file is referenced twice', async () => {
    const projectRoot = await project({
      'index.html': `<script src="scripts/shared.js"></script>
        <script type="module" src="scripts/shared.js"></script>`,
      'scripts/shared.js': "import './dependency.js'; export const ready = true;",
      'scripts/dependency.js': 'export const dependency = true;',
    });

    const result = await checkOdNextJavaScriptSyntax({ projectRoot, entryFile: 'index.html' });

    expect(result.status).toBe('syntax_error');
    if (result.status !== 'syntax_error') return;
    expect(result.checkedSources).toBe(3);
    expect(result.checkedFiles).toEqual(['scripts/dependency.js', 'scripts/shared.js']);
    expect(result.errors).toEqual([
      expect.objectContaining({
        file: 'scripts/shared.js',
        scriptKind: 'classic',
        line: 1,
        column: 1,
        errorType: 'SyntaxError',
      }),
      expect.objectContaining({
        file: 'scripts/shared.js',
        scriptKind: 'classic',
        line: 1,
        column: 27,
        errorType: 'SyntaxError',
      }),
    ]);
  });

  it('does not inspect inactive data, templates, styles, remote scripts, custom handlers, or unreferenced files', async () => {
    const projectRoot = await project({
      'index.html': `<script type="application/ld+json">{"value":}</script>
        <script type="importmap">{"imports":}</script>
        <script type="text/template">const broken = ;</script>
        <script src="//cdn.example.com/broken.js"></script>
        <template><script type="module">export const broken = ;</script></template>
        <noscript><script>const broken = ;</script></noscript>
        <div style="background: url('broken(')" oncustomaction="const broken = ;"></div>`,
      'unreferenced.js': 'const broken = ;',
    });

    await expect(checkOdNextJavaScriptSyntax({ projectRoot, entryFile: 'index.html' }))
      .resolves.toEqual({
        status: 'no_syntax_error_found',
        checkedSources: 0,
        checkedFiles: [],
      });
  });

  it('returns check_incomplete for invalid UTF-8 without treating replacement characters as syntax', async () => {
    const invalidUtf8 = new Uint8Array([0x3c, 0x73, 0x63, 0x72, 0x69, 0x70, 0x74, 0x3e, 0xc3, 0x28]);
    const projectRoot = await project({ 'index.html': invalidUtf8 });

    await expect(checkOdNextJavaScriptSyntax({ projectRoot, entryFile: 'index.html' }))
      .resolves.toEqual({
        status: 'check_incomplete',
        checkedSources: 0,
        checkedFiles: [],
        reason: 'invalid_encoding',
        detail: 'Canonical deliverable index.html is not valid UTF-8.',
      });
  });

  it('returns check_incomplete when a referenced local script is unreadable or invalid UTF-8', async () => {
    const missingRoot = await project({
      'index.html': '<script src="scripts/missing.js"></script>',
    });
    const invalidRoot = await project({
      'index.html': '<script src="scripts/invalid.js"></script>',
      'scripts/invalid.js': new Uint8Array([0xc3, 0x28]),
    });

    await expect(checkOdNextJavaScriptSyntax({ projectRoot: missingRoot, entryFile: 'index.html' }))
      .resolves.toMatchObject({
        status: 'check_incomplete',
        checkedSources: 0,
        checkedFiles: [],
        reason: 'dependency_unreadable',
      });
    await expect(checkOdNextJavaScriptSyntax({ projectRoot: invalidRoot, entryFile: 'index.html' }))
      .resolves.toMatchObject({
        status: 'check_incomplete',
        checkedSources: 0,
        checkedFiles: [],
        reason: 'invalid_encoding',
      });
  });

  it.skipIf(process.platform === 'win32')(
    'does not follow a project symlink to JavaScript outside the project root',
    async () => {
      const projectRoot = await project({
        'index.html': '<script src="scripts/escaped.js"></script>',
      });
      const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'od-next-js-external-'));
      temporaryRoots.push(externalRoot);
      const externalFile = path.join(externalRoot, 'private.js');
      await fs.writeFile(externalFile, 'const PRIVATE_OUTSIDE_PROJECT = ;');
      await fs.mkdir(path.join(projectRoot, 'scripts'), { recursive: true });
      await fs.symlink(externalFile, path.join(projectRoot, 'scripts', 'escaped.js'));

      const result = await checkOdNextJavaScriptSyntax({
        projectRoot,
        entryFile: 'index.html',
      });

      expect(result).toMatchObject({
        status: 'check_incomplete',
        checkedSources: 0,
        checkedFiles: [],
        reason: 'dependency_unreadable',
      });
      expect(JSON.stringify(result)).not.toContain('PRIVATE_OUTSIDE_PROJECT');
    },
  );

  it('returns check_incomplete ahead of syntax_error when coverage is incomplete', async () => {
    const projectRoot = await project({
      'index.html': `<script>const deterministicError = ;</script>
        <script src="scripts/missing.js"></script>`,
    });

    await expect(checkOdNextJavaScriptSyntax({ projectRoot, entryFile: 'index.html' }))
      .resolves.toEqual({
        status: 'check_incomplete',
        checkedSources: 1,
        checkedFiles: ['index.html'],
        reason: 'dependency_unreadable',
        detail: 'Could not read referenced local script scripts/missing.js.',
      });
  });

  it('returns check_incomplete for unsupported entry and script-like dependency types', async () => {
    const projectRoot = await project({
      'entry.txt': '<script>const ready = true;</script>',
      'index.html': '<script type="module" src="scripts/main.ts"></script>',
      'base.htm': '<base href="assets/"><script>const ready = true;</script>',
      'scripts/main.ts': 'const ready: boolean = true;',
    });

    await expect(checkOdNextJavaScriptSyntax({ projectRoot, entryFile: 'entry.txt' }))
      .resolves.toMatchObject({
        status: 'check_incomplete',
        checkedFiles: [],
        reason: 'entry_unsupported',
      });
    await expect(checkOdNextJavaScriptSyntax({ projectRoot, entryFile: 'index.html' }))
      .resolves.toMatchObject({
        status: 'check_incomplete',
        checkedSources: 0,
        checkedFiles: [],
        reason: 'dependency_unsupported',
      });
    await expect(checkOdNextJavaScriptSyntax({ projectRoot, entryFile: 'base.htm' }))
      .resolves.toMatchObject({
        status: 'check_incomplete',
        checkedSources: 1,
        checkedFiles: ['base.htm'],
        reason: 'entry_unsupported',
      });
  });

  it('bounds entry and individual dependency bytes before invoking the parser', async () => {
    const oversizedEntryRoot = await project({
      'index.html': ' '.repeat(MAX_OD_NEXT_JAVASCRIPT_ENTRY_BYTES + 1),
    });
    const oversizedDependencyRoot = await project({
      'index.html': '<script src="scripts/large.js"></script>',
      'scripts/large.js': ' '.repeat(MAX_OD_NEXT_JAVASCRIPT_SOURCE_BYTES + 1),
    });

    await expect(checkOdNextJavaScriptSyntax({
      projectRoot: oversizedEntryRoot,
      entryFile: 'index.html',
    })).resolves.toMatchObject({
      status: 'check_incomplete',
      checkedSources: 0,
      checkedFiles: [],
      reason: 'limit_exceeded',
    });
    await expect(checkOdNextJavaScriptSyntax({
      projectRoot: oversizedDependencyRoot,
      entryFile: 'index.html',
    })).resolves.toMatchObject({
      status: 'check_incomplete',
      checkedSources: 0,
      checkedFiles: [],
      reason: 'limit_exceeded',
    });
  });

  it('bounds the number of independently parsed source units', async () => {
    const handlers = Array.from(
      { length: MAX_OD_NEXT_JAVASCRIPT_SOURCES + 1 },
      (_, index) => `<button onclick="window.run(${index})"></button>`,
    ).join('\n');
    const projectRoot = await project({ 'index.html': handlers });

    await expect(checkOdNextJavaScriptSyntax({ projectRoot, entryFile: 'index.html' }))
      .resolves.toEqual({
        status: 'check_incomplete',
        checkedSources: MAX_OD_NEXT_JAVASCRIPT_SOURCES,
        checkedFiles: ['index.html'],
        reason: 'limit_exceeded',
        detail: `JavaScript syntax check exceeded its ${MAX_OD_NEXT_JAVASCRIPT_SOURCES}-source limit.`,
      });
  });

  it('bounds cumulative parser input bytes across reachable sources', async () => {
    const moduleBody = ' '.repeat(MAX_OD_NEXT_JAVASCRIPT_SOURCE_BYTES);
    const projectRoot = await project({
      'index.html': '<script type="module" src="scripts/root.js"></script>',
      'scripts/root.js': [1, 2, 3, 4]
        .map((index) => `import './large-${index}.js';`)
        .join('\n'),
      'scripts/large-1.js': moduleBody,
      'scripts/large-2.js': moduleBody,
      'scripts/large-3.js': moduleBody,
      'scripts/large-4.js': moduleBody,
    });

    await expect(checkOdNextJavaScriptSyntax({
      projectRoot,
      entryFile: 'index.html',
      timeoutMs: 30_000,
    })).resolves.toEqual({
      status: 'check_incomplete',
      checkedSources: 4,
      checkedFiles: [
        'scripts/large-1.js',
        'scripts/large-2.js',
        'scripts/large-3.js',
        'scripts/root.js',
      ],
      reason: 'limit_exceeded',
      detail: `JavaScript syntax check exceeded its ${MAX_OD_NEXT_JAVASCRIPT_TOTAL_SOURCE_BYTES}-byte total source limit.`,
    });
  });

  it('returns check_incomplete when an encoded event-handler error cannot be mapped exactly', async () => {
    const projectRoot = await project({
      'index.html': '<button onclick="if (&quot;ready&quot;) {">Run</button>',
    });

    await expect(checkOdNextJavaScriptSyntax({ projectRoot, entryFile: 'index.html' }))
      .resolves.toEqual({
        status: 'check_incomplete',
        checkedSources: 1,
        checkedFiles: ['index.html'],
        reason: 'unsupported_event_handler_mapping',
        detail: 'Could not map an event-handler syntax error precisely in index.html.',
      });
  });

  it('uses a deterministic timeout outcome without launching a runtime', async () => {
    const projectRoot = await project({
      'index.html': '<script>const ready = true;</script>',
    });

    await expect(checkOdNextJavaScriptSyntax({
      projectRoot,
      entryFile: 'index.html',
      timeoutMs: 0,
    })).resolves.toEqual({
      status: 'check_incomplete',
      checkedSources: 0,
      checkedFiles: [],
      reason: 'timeout',
      detail: 'JavaScript syntax check exceeded its 0 ms budget.',
    });
  });

  it('returns timeout ahead of a syntax error found before the deadline expired', async () => {
    const projectRoot = await project({
      'index.html': '<script>const deterministicError = ;</script>',
    });
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(20)
      .mockReturnValue(20);

    await expect(checkOdNextJavaScriptSyntax({
      projectRoot,
      entryFile: 'index.html',
      timeoutMs: 10,
    })).resolves.toEqual({
      status: 'check_incomplete',
      checkedSources: 1,
      checkedFiles: ['index.html'],
      reason: 'timeout',
      detail: 'JavaScript syntax check exceeded its 10 ms budget.',
    });
  });
});
