import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runSkillDiscoveryToolCli } from '../src/tools-skills-cli.js';

const ORIGINAL_ENV = { ...process.env };

describe('agent-native Skill discovery tool CLI', () => {
  let stdout: string[];
  let stderr: string[];
  let stdoutWrite: { mockRestore: () => void };
  let stderrWrite: { mockRestore: () => void };
  let fetchMock: ReturnType<typeof vi.fn>;
  let tempRoot: string;

  beforeEach(async () => {
    process.env = {
      ...ORIGINAL_ENV,
      OD_DAEMON_URL: 'http://127.0.0.1:7456/base/',
      OD_TOOL_TOKEN: 'agent-run-token',
    };
    stdout = [];
    stderr = [];
    stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ state: { status: 'pending' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'od-tools-skills-cli-'));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
    process.env = ORIGINAL_ENV;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('reads a long search query from a file and sends the strict search DTO', async () => {
    const queryPath = path.join(tempRoot, 'query.md');
    await writeFile(queryPath, '帮我做一个官网\n', 'utf8');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      search: { revision: `sha256:${'1'.repeat(64)}`, candidates: [] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await runSkillDiscoveryToolCli([
      'search',
      '--query-file', queryPath,
      '--role', 'primary',
      '--output-kind', 'website',
      '--limit', '5',
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:7456/base/api/tools/skills/search',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer agent-run-token' }),
        body: JSON.stringify({
          query: '帮我做一个官网',
          role: 'primary',
          outputKind: 'website',
          limit: 5,
        }),
      }),
    );
    expect(JSON.parse(stdout.join(''))).toMatchObject({ ok: true, search: { candidates: [] } });
    expect(stderr.join('')).toBe('');
  });

  it('sends all TOCTOU evidence and explicit replacement intent on load', async () => {
    const revision = `sha256:${'2'.repeat(64)}`;
    const candidateDigest = `sha256:${'3'.repeat(64)}`;

    const result = await runSkillDiscoveryToolCli([
      'load',
      '--id', 'prototype',
      '--catalog-revision', revision,
      '--candidate-digest', candidateDigest,
      '--role', 'primary',
      '--purpose', 'Build the requested website.',
      '--replace', 'ppt',
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      id: 'prototype',
      revision,
      candidateDigest,
      role: 'primary',
      purpose: 'Build the requested website.',
      replaceId: 'ppt',
    });
  });

  it('supports none and clarify resolution payloads', async () => {
    const none = await runSkillDiscoveryToolCli([
      'resolve', '--none', '--reason', 'No official Skill applies.', '--json',
    ]);
    expect(none.exitCode).toBe(0);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      resolution: 'none',
      reason: 'No official Skill applies.',
    });

    stdout.length = 0;
    fetchMock.mockClear();
    const clarify = await runSkillDiscoveryToolCli([
      'resolve', '--clarify', '--reason', 'Need the output format.', '--json',
    ]);
    expect(clarify.exitCode).toBe(0);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      resolution: 'clarify',
      reason: 'Need the output format.',
    });
  });

  it('deactivates one active auxiliary with an explicit reason', async () => {
    const result = await runSkillDiscoveryToolCli([
      'deactivate',
      '--id', 'web-clone',
      '--reason', 'The task changed to a local redesign.',
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:7456/base/api/tools/skills/deactivate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          id: 'web-clone',
          reason: 'The task changed to a local redesign.',
        }),
      }),
    );
  });

  it('uses the dedicated rehydrate endpoint for status --rehydrate', async () => {
    const result = await runSkillDiscoveryToolCli(['status', '--rehydrate', '--json']);

    expect(result.exitCode).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:7456/base/api/tools/skills/rehydrate',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
  });

  it('prints a stable retryable error for stale catalog evidence', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      error: {
        code: 'SKILL_DISCOVERY_CATALOG_CHANGED',
        message: 'catalog revision changed before load',
        retryable: true,
      },
    }), { status: 409, headers: { 'Content-Type': 'application/json' } }));

    const result = await runSkillDiscoveryToolCli([
      'load',
      '--id', 'prototype',
      '--catalog-revision', `sha256:${'4'.repeat(64)}`,
      '--candidate-digest', `sha256:${'5'.repeat(64)}`,
      '--role', 'primary',
      '--purpose', 'Build it.',
      '--json',
    ]);

    expect(result.exitCode).toBe(1);
    expect(stdout.join('')).toBe('');
    expect(JSON.parse(stderr.join(''))).toEqual({
      ok: false,
      status: 409,
      error: {
        code: 'SKILL_DISCOVERY_CATALOG_CHANGED',
        message: 'catalog revision changed before load',
        retryable: true,
      },
    });
  });

  it('fails before HTTP when query sources are ambiguous', async () => {
    const queryPath = path.join(tempRoot, 'query.md');
    await writeFile(queryPath, 'website', 'utf8');

    const result = await runSkillDiscoveryToolCli([
      'search', '--query', 'site', '--query-file', queryPath,
    ]);

    expect(result.exitCode).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stderr.join('')).toContain('pass either --query or --query-file');
  });
});
