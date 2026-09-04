import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { InstalledPluginRecord } from '@open-design/contracts';
import Database from 'better-sqlite3';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolvePluginFolder } from '../../src/plugins/registry.js';
import { registerSkillDiscoveryToolRoutes } from '../../src/routes/skill-discovery-tool.js';
import {
  materializeVerifiedSkillDiscoveryResources,
  skillDiscoveryMaterializationAlias,
} from '../../src/skill-discovery/materialize.js';
import {
  ensureSkillDiscoveryForRun,
  migrateSkillDiscoveryState,
  readSkillDiscoveryState,
} from '../../src/skill-discovery/state.js';

const STRATEGY_SOURCE = path.resolve(
  import.meta.dirname,
  '../../../../plugins/_official/scenarios/od-next-strategy',
);
const BUILT_IN_SKILLS_ROOT = path.resolve(import.meta.dirname, '../../../../skills');

type JsonBody = Record<string, any>;

let db: Database.Database;
let server: http.Server | undefined;
let baseUrl: string;
let operations: string[];
let projectDir: string;
let toolRunId: string;

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(os.tmpdir(), 'od-skill-discovery-route-'));
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY);
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
    );
    INSERT INTO projects (id) VALUES ('project-1');
    INSERT INTO conversations (id, project_id) VALUES ('conversation-1', 'project-1');
  `);
  migrateSkillDiscoveryState(db);

  const bundledStrategyPlugin = await resolveStrategyRecord();
  ensureSkillDiscoveryForRun(db, {
    projectId: 'project-1',
    conversationId: 'conversation-1',
    runId: 'run-1',
    catalogRevision: `sha256:${'0'.repeat(64)}`,
  });

  operations = [];
  toolRunId = 'run-1';
  const app = express();
  app.use(express.json());
  registerSkillDiscoveryToolRoutes(app, {
    auth: {
      authorizeToolRequest: (_req, _res, operation) => {
        operations.push(operation);
        return {
          token: 'tool-token',
          runId: toolRunId,
          projectId: 'project-1',
          allowedEndpoints: [],
          allowedOperations: [],
          issuedAt: new Date(0).toISOString(),
          expiresAt: new Date(60_000).toISOString(),
        };
      },
    },
    http: {
      sendApiError: (res, status, code, message, extras = {}) => {
        res.status(status).json({ error: { code, message, ...extras } });
      },
    },
    db,
    resolveCatalogSources: () => ({
      bundledStrategyPlugin,
      builtInFunctionalSkillsRoot: BUILT_IN_SKILLS_ROOT,
    }),
    resolveRunScope: (grant) => ({
      runId: grant.runId,
      projectId: grant.projectId,
      conversationId: 'conversation-1',
    }),
    materializeResources: async ({ loaded, bundle }) => (
      materializeVerifiedSkillDiscoveryResources({
        cwd: projectDir,
        alias: skillDiscoveryMaterializationAlias({
          id: loaded.candidate.id,
          candidateDigest: loaded.candidate.candidateDigest,
        }),
        resources: bundle.files,
      })
    ),
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server?.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('unexpected server address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    if (!server) return resolve();
    server.close((error?: Error) => error ? reject(error) : resolve());
  });
  server = undefined;
  db.close();
  await rm(projectDir, { recursive: true, force: true });
});

async function resolveStrategyRecord(): Promise<InstalledPluginRecord> {
  const resolved = await resolvePluginFolder({
    folder: STRATEGY_SOURCE,
    folderId: 'od-next-strategy',
    sourceKind: 'bundled',
    source: STRATEGY_SOURCE,
    trust: 'bundled',
  });
  if (!resolved.ok) throw new Error(resolved.errors.join('; '));
  return resolved.record;
}

async function request(
  pathname: string,
  init: { method?: string; body?: Record<string, unknown> } = {},
): Promise<{ status: number; body: JsonBody }> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: {
      Authorization: 'Bearer tool-token',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  return { status: response.status, body: await response.json() as JsonBody };
}

describe('agent-native Skill discovery tool routes', () => {
  it('supports same-run metadata search then verified load without persisting raw intent', async () => {
    const searched = await request('/api/tools/skills/search', {
      body: { query: '帮我做一个官网', role: 'primary', limit: 5 },
    });

    expect(searched.status).toBe(200);
    expect(searched.body.search.candidates[0].id).toBe('prototype');
    expect(JSON.stringify(searched.body)).not.toContain('profileMarkdown');
    const candidate = searched.body.search.candidates[0];
    const searchEvent = db.prepare(`
      SELECT payload_json AS payloadJson
        FROM skill_discovery_events
       WHERE conversation_id = ? AND kind = 'search'
    `).get('conversation-1') as { payloadJson: string };
    expect(searchEvent.payloadJson).not.toContain('帮我做一个官网');
    expect(JSON.parse(searchEvent.payloadJson).queryDigest).toBe(
      `sha256:${createHash('sha256').update('帮我做一个官网').digest('hex')}`,
    );

    const loaded = await request('/api/tools/skills/load', {
      body: {
        id: candidate.id,
        revision: searched.body.search.revision,
        candidateDigest: candidate.candidateDigest,
        role: 'primary',
        purpose: 'Create the requested product website.',
      },
    });

    expect(loaded.status).toBe(200);
    expect(loaded.body.loaded.profileMarkdown).toContain('Prototype execution profile v1');
    expect(loaded.body.loaded.profileMarkdown).not.toContain('RunManifest');
    expect(loaded.body.loaded.strategyBinding).toBeUndefined();
    expect(loaded.body.loaded.materialization.materializedRoot)
      .toMatch(/^\.od-skills\/discovered-prototype-[a-f0-9]{12}$/u);
    expect(loaded.body.state).toMatchObject({
      status: 'resolved_skill',
      activePrimary: { id: 'prototype', role: 'primary' },
    });
    expect(operations).toEqual(['skills:search', 'skills:load']);
  });

  it('fails closed on a stale candidate digest and keeps the ledger pending', async () => {
    const searched = await request('/api/tools/skills/search', {
      body: { query: 'make a website', role: 'primary' },
    });
    const candidate = searched.body.search.candidates.find(
      (item: { id: string }) => item.id === 'prototype',
    );
    expect(candidate).toBeDefined();

    const loaded = await request('/api/tools/skills/load', {
      body: {
        id: candidate.id,
        revision: searched.body.search.revision,
        candidateDigest: `sha256:${'f'.repeat(64)}`,
        role: 'primary',
        purpose: 'Create the site.',
      },
    });

    expect(loaded.status).toBe(409);
    expect(loaded.body.error).toMatchObject({
      code: 'SKILL_DISCOVERY_CATALOG_CHANGED',
      retryable: true,
    });
    expect(readSkillDiscoveryState(db, 'conversation-1')?.status).toBe('pending');
  });

  it('rejects a second primary before resource materialization publishes an alias', async () => {
    const pptSearch = await request('/api/tools/skills/search', {
      body: { query: '帮我做一份融资路演 PPT', role: 'primary', limit: 5 },
    });
    expect(pptSearch).toMatchObject({ status: 200 });
    const ppt = pptSearch.body.search.candidates.find(
      (candidate: { id: string }) => candidate.id === 'ppt',
    );
    expect(ppt).toBeDefined();
    const firstLoad = await request('/api/tools/skills/load', {
      body: {
        id: ppt.id,
        revision: pptSearch.body.search.revision,
        candidateDigest: ppt.candidateDigest,
        role: 'primary',
        purpose: 'Create the presentation.',
      },
    });
    expect(firstLoad.status).toBe(200);

    const prototypeSearch = await request('/api/tools/skills/search', {
      body: { query: '帮我做一个官网', role: 'primary', limit: 5 },
    });
    const prototype = prototypeSearch.body.search.candidates.find(
      (candidate: { id: string }) => candidate.id === 'prototype',
    );
    expect(prototype).toBeDefined();
    const rejected = await request('/api/tools/skills/load', {
      body: {
        id: prototype.id,
        revision: prototypeSearch.body.search.revision,
        candidateDigest: prototype.candidateDigest,
        role: 'primary',
        purpose: 'Create the requested product website.',
      },
    });

    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe('SKILL_DISCOVERY_STATE_CONFLICT');
    const stagedAliases = await readdir(path.join(projectDir, '.od-skills')).catch(() => []);
    expect(stagedAliases.some((entry) => entry.startsWith('discovered-prototype-'))).toBe(false);
  });

  it('records explicit none and clarification resolutions and exposes rehydration', async () => {
    const none = await request('/api/tools/skills/resolve', {
      body: { resolution: 'none', reason: 'No official Skill clearly applies.' },
    });
    expect(none.status).toBe(200);
    expect(none.body.state.status).toBe('resolved_none');

    const clarify = await request('/api/tools/skills/resolve', {
      body: { resolution: 'clarify', reason: 'Output kind changes the primary Skill.' },
    });
    expect(clarify.status).toBe(200);
    expect(clarify.body.state.status).toBe('clarification');
    const eventPayloads = db.prepare(`
      SELECT payload_json AS payloadJson
        FROM skill_discovery_events
       WHERE conversation_id = ? AND kind IN ('resolve_none', 'clarify')
       ORDER BY id
    `).all('conversation-1') as Array<{ payloadJson: string }>;
    expect(eventPayloads).toHaveLength(2);
    expect(eventPayloads.map((event) => event.payloadJson).join('\n'))
      .not.toContain('Output kind');

    const rehydrated = await request('/api/tools/skills/rehydrate', {
      body: {},
    });
    expect(rehydrated.status).toBe(200);
    expect(rehydrated.body.lifecycleCapsule).toContain('Decision state: `clarification`');
    expect(operations).toEqual(['skills:resolve', 'skills:resolve', 'skills:status']);
  });

  it('keeps clarification blocked until a later run reopens discovery', async () => {
    const searched = await request('/api/tools/skills/search', {
      body: { query: '帮我做一个官网', role: 'primary', limit: 5 },
    });
    const candidate = searched.body.search.candidates.find(
      (item: { id: string }) => item.id === 'prototype',
    );
    expect(candidate).toBeDefined();

    const clarified = await request('/api/tools/skills/resolve', {
      body: { resolution: 'clarify', reason: 'The output choice changes the workflow.' },
    });
    expect(clarified).toMatchObject({ status: 200, body: { state: { status: 'clarification' } } });

    const sameRunNone = await request('/api/tools/skills/resolve', {
      body: { resolution: 'none', reason: 'Trying to change the decision in the same run.' },
    });
    expect(sameRunNone).toMatchObject({
      status: 409,
      body: { error: { code: 'SKILL_DISCOVERY_STATE_CONFLICT' } },
    });

    const sameRunLoad = await request('/api/tools/skills/load', {
      body: {
        id: candidate.id,
        revision: searched.body.search.revision,
        candidateDigest: candidate.candidateDigest,
        role: 'primary',
        purpose: 'Trying to load before the answer arrives.',
      },
    });
    expect(sameRunLoad).toMatchObject({
      status: 409,
      body: { error: { code: 'SKILL_DISCOVERY_STATE_CONFLICT' } },
    });

    const current = readSkillDiscoveryState(db, 'conversation-1')!;
    ensureSkillDiscoveryForRun(db, {
      projectId: 'project-1',
      conversationId: 'conversation-1',
      runId: 'run-2',
      catalogRevision: current.catalogRevision,
    });
    toolRunId = 'run-2';
    const laterRunNone = await request('/api/tools/skills/resolve', {
      body: { resolution: 'none', reason: 'The user answer confirms no Skill is needed.' },
    });
    expect(laterRunNone).toMatchObject({ status: 200, body: { state: { status: 'resolved_none' } } });
  });

  it('rejects status and rehydration from a token whose run is no longer active', async () => {
    ensureSkillDiscoveryForRun(db, {
      projectId: 'project-1',
      conversationId: 'conversation-1',
      runId: 'run-2',
      catalogRevision: readSkillDiscoveryState(db, 'conversation-1')!.catalogRevision,
    });

    const status = await request('/api/tools/skills/status');
    expect(status.status).toBe(409);
    expect(status.body.error.code).toBe('SKILL_DISCOVERY_SCOPE_UNAVAILABLE');

    const rehydrated = await request('/api/tools/skills/rehydrate', { body: {} });
    expect(rehydrated.status).toBe(409);
    expect(rehydrated.body.error.code).toBe('SKILL_DISCOVERY_SCOPE_UNAVAILABLE');
  });

  it('deactivates an obsolete auxiliary before another auxiliary can replace it', async () => {
    const searched = await request('/api/tools/skills/search', {
      body: { query: '复刻网站', role: 'auxiliary', limit: 5 },
    });
    const candidate = searched.body.search.candidates.find(
      (item: { id: string }) => item.id === 'web-clone',
    );
    expect(candidate).toBeDefined();
    const loaded = await request('/api/tools/skills/load', {
      body: {
        id: candidate.id,
        revision: searched.body.search.revision,
        candidateDigest: candidate.candidateDigest,
        role: 'auxiliary',
        purpose: 'Clone the referenced website accurately.',
      },
    });
    expect(loaded.status).toBe(200);
    expect(loaded.body.state.activeAuxiliaries).toEqual([
      expect.objectContaining({ id: 'web-clone' }),
    ]);

    const deactivated = await request('/api/tools/skills/deactivate', {
      body: { id: 'web-clone', reason: 'The user changed from cloning to a new design.' },
    });
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.state.activeAuxiliaries).toEqual([]);
    expect(deactivated.body.state.superseded).toEqual([
      expect.objectContaining({ id: 'web-clone' }),
    ]);
    expect(operations.at(-1)).toBe('skills:deactivate');
  });

  it('strictly rejects unknown request fields before catalog access', async () => {
    const response = await request('/api/tools/skills/search', {
      body: { query: 'website', hiddenOverride: true },
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
    expect(readSkillDiscoveryState(db, 'conversation-1')?.status).toBe('pending');
  });
});
