import { createHash } from 'node:crypto';

import {
  OfficialSkillDiscoverySearchRequestV1Schema,
  OfficialSkillDiscoveryLoadResponseV1Schema,
  PublicSkillDiscoveryStateV1Schema,
  SkillDiscoveryToolDeactivateRequestV1Schema,
  SkillDiscoveryToolLoadRequestV1Schema,
  SkillDiscoveryToolRehydrateRequestV1Schema,
  SkillDiscoveryToolResolveRequestV1Schema,
  type ApiErrorCode,
  type OfficialSkillDiscoverySearchRequestV1,
  type OfficialSkillDiscoveryLoadResponseV1,
  type OfficialSkillDiscoveryMaterializationV1,
  type SkillDiscoveryToolLoadRequestV1,
  type SkillDiscoveryToolResolveRequestV1,
} from '@open-design/contracts';
import type Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';

import {
  OfficialSkillDiscoveryCatalogError,
  resolveOfficialSkillDiscoveryResourceBundleV1,
  resolveOfficialSkillDiscoveryLoadV1,
  searchOfficialSkillDiscoveryCatalogV1,
  type OfficialSkillDiscoveryCatalogSourcesV1,
  type OfficialSkillDiscoveryResourceBundleV1,
} from '../skill-discovery/catalog.js';
import { SkillDiscoveryMaterializationError } from '../skill-discovery/materialize.js';
import {
  SkillDiscoveryStateError,
  applySkillDiscoveryLoad,
  deactivateSkillDiscoveryAuxiliary,
  planSkillDiscoveryLoad,
  readSkillDiscoveryState,
  recordSkillDiscoverySearch,
  renderSkillDiscoveryLifecycleCapsule,
  resolveSkillDiscovery,
  type SkillDiscoveryState,
} from '../skill-discovery/state.js';
import type { ToolTokenGrant } from '../tool-tokens.js';

type SendApiError = (
  res: Response,
  status: number,
  code: ApiErrorCode,
  message: string,
  extras?: Record<string, unknown>,
) => void;

export interface SkillDiscoveryRunScope {
  runId: string;
  projectId: string;
  conversationId: string;
}

export interface MaterializeOfficialSkillDiscoveryLoadInput {
  scope: SkillDiscoveryRunScope;
  loaded: OfficialSkillDiscoveryLoadResponseV1;
  bundle: OfficialSkillDiscoveryResourceBundleV1;
}

export interface RegisterSkillDiscoveryToolRoutesDeps {
  auth: {
    authorizeToolRequest: (
      req: Request,
      res: Response,
      operation: string,
    ) => ToolTokenGrant | null;
  };
  http: {
    sendApiError: SendApiError;
  };
  db: Database.Database;
  /** Re-read official sources on every request so search/load cannot trust a stale snapshot. */
  resolveCatalogSources: () => OfficialSkillDiscoveryCatalogSourcesV1;
  /** Resolve conversation identity from the daemon-owned run, never from request input. */
  resolveRunScope: (grant: ToolTokenGrant) => SkillDiscoveryRunScope | null;
  /** Publish verified bytes into the project-private Skill staging root. */
  materializeResources: (
    input: MaterializeOfficialSkillDiscoveryLoadInput,
  ) => Promise<OfficialSkillDiscoveryMaterializationV1>;
}

export function registerSkillDiscoveryToolRoutes(
  app: Express,
  ctx: RegisterSkillDiscoveryToolRoutesDeps,
): void {
  app.post('/api/tools/skills/search', (req, res) => {
    withAuthorizedScope(req, res, ctx, 'skills:search', (scope) => {
      if (!requireActiveDiscoveryState(ctx, res, scope)) return;
      const parsed = OfficialSkillDiscoverySearchRequestV1Schema.safeParse(req.body);
      if (!parsed.success) {
        return sendValidationError(ctx, res, parsed.error.issues);
      }

      const search = searchOfficialSkillDiscoveryCatalogV1({
        ...ctx.resolveCatalogSources(),
        request: parsed.data,
      });
      recordSkillDiscoverySearch(ctx.db, {
        conversationId: scope.conversationId,
        runId: scope.runId,
        queryDigest: digestText(parsed.data.query),
        filters: {
          ...(parsed.data.role ? { role: parsed.data.role } : {}),
          ...(parsed.data.outputKind ? { outputKind: parsed.data.outputKind } : {}),
          ...(parsed.data.limit ? { limit: parsed.data.limit } : {}),
        },
        candidates: search.candidates.map(({ id, score }) => ({ id, score })),
        catalogRevision: search.revision,
      });
      res.json({ search });
    });
  });

  app.post('/api/tools/skills/load', async (req, res) => {
    await withAuthorizedScope(req, res, ctx, 'skills:load', async (scope) => {
      const stateBeforeLoad = requireActiveDiscoveryState(ctx, res, scope);
      if (!stateBeforeLoad) return;
      const parsed = SkillDiscoveryToolLoadRequestV1Schema.safeParse(req.body);
      if (!parsed.success) {
        return sendValidationError(ctx, res, parsed.error.issues);
      }

      const { purpose, replaceId, ...catalogRequest } = parsed.data;
      const catalogSources = ctx.resolveCatalogSources();
      const loadedBeforeMaterialization = resolveOfficialSkillDiscoveryLoadV1({
        ...catalogSources,
        request: catalogRequest,
      });
      const plannedAt = Date.now();
      const loadInput = {
        conversationId: scope.conversationId,
        runId: scope.runId,
        loaded: {
          id: loadedBeforeMaterialization.candidate.id,
          kind: loadedBeforeMaterialization.candidate.origin.kind === 'bundled-task-profile'
            ? 'task-profile' as const
            : 'functional' as const,
          role: loadedBeforeMaterialization.resolvedRole,
          version: loadedBeforeMaterialization.candidate.version,
          candidateDigest: loadedBeforeMaterialization.candidate.candidateDigest,
          contentDigest: loadedBeforeMaterialization.candidate.contentDigest,
          catalogRevision: loadedBeforeMaterialization.revision,
          purposeDigest: digestText(purpose),
        },
        conflictsWith: loadedBeforeMaterialization.candidate.conflictsWith,
        ...(replaceId ? { replaceId } : {}),
        now: plannedAt,
      };
      const plan = planSkillDiscoveryLoad(stateBeforeLoad, loadInput);
      const bundle = resolveOfficialSkillDiscoveryResourceBundleV1({
        ...catalogSources,
        request: catalogRequest,
      });
      const materialization = await ctx.materializeResources({
        scope,
        loaded: loadedBeforeMaterialization,
        bundle,
      });
      const loaded = OfficialSkillDiscoveryLoadResponseV1Schema.parse({
        ...loadedBeforeMaterialization,
        materialization,
      });
      const state = applySkillDiscoveryLoad(ctx.db, {
        ...loadInput,
        expectedStateRevision: plan.expectedStateRevision,
      });
      res.json({ loaded, state: publicState(state) });
    });
  });

  app.post('/api/tools/skills/resolve', (req, res) => {
    withAuthorizedScope(req, res, ctx, 'skills:resolve', (scope) => {
      if (!requireActiveDiscoveryState(ctx, res, scope)) return;
      const parsed = SkillDiscoveryToolResolveRequestV1Schema.safeParse(req.body);
      if (!parsed.success) {
        return sendValidationError(ctx, res, parsed.error.issues);
      }
      const state = resolveSkillDiscovery(ctx.db, {
        conversationId: scope.conversationId,
        runId: scope.runId,
        resolution: parsed.data.resolution,
        reasonDigest: digestText(parsed.data.reason),
      });
      res.json({ state: publicState(state) });
    });
  });

  app.post('/api/tools/skills/deactivate', (req, res) => {
    withAuthorizedScope(req, res, ctx, 'skills:deactivate', (scope) => {
      if (!requireActiveDiscoveryState(ctx, res, scope)) return;
      const parsed = SkillDiscoveryToolDeactivateRequestV1Schema.safeParse(req.body);
      if (!parsed.success) {
        return sendValidationError(ctx, res, parsed.error.issues);
      }
      const state = deactivateSkillDiscoveryAuxiliary(ctx.db, {
        conversationId: scope.conversationId,
        runId: scope.runId,
        id: parsed.data.id,
        reasonDigest: digestText(parsed.data.reason),
      });
      res.json({ state: publicState(state) });
    });
  });

  app.get('/api/tools/skills/status', (req, res) => {
    withAuthorizedScope(req, res, ctx, 'skills:status', (scope) => {
      if (Object.keys(req.query).length > 0) {
        return ctx.http.sendApiError(
          res,
          400,
          'BAD_REQUEST',
          'status does not accept query parameters',
        );
      }
      const state = requireActiveDiscoveryState(ctx, res, scope);
      if (!state) return;
      res.json({ state: publicState(state) });
    });
  });

  app.post('/api/tools/skills/rehydrate', (req, res) => {
    withAuthorizedScope(req, res, ctx, 'skills:status', (scope) => {
      const parsed = SkillDiscoveryToolRehydrateRequestV1Schema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return sendValidationError(ctx, res, parsed.error.issues);
      }
      const state = requireActiveDiscoveryState(ctx, res, scope);
      if (!state) return;
      res.json({
        state: publicState(state),
        lifecycleCapsule: renderSkillDiscoveryLifecycleCapsule(state),
      });
    });
  });
}

async function withAuthorizedScope(
  req: Request,
  res: Response,
  ctx: RegisterSkillDiscoveryToolRoutesDeps,
  operation:
    | 'skills:search'
    | 'skills:load'
    | 'skills:deactivate'
    | 'skills:resolve'
    | 'skills:status',
  handler: (scope: SkillDiscoveryRunScope) => void | Promise<void>,
): Promise<void> {
  try {
    const grant = ctx.auth.authorizeToolRequest(req, res, operation);
    if (!grant) return;
    const scope = ctx.resolveRunScope(grant);
    if (
      !scope
      || scope.runId !== grant.runId
      || scope.projectId !== grant.projectId
      || !scope.conversationId
    ) {
      ctx.http.sendApiError(
        res,
        409,
        'SKILL_DISCOVERY_SCOPE_UNAVAILABLE',
        'The tool token does not resolve to an active Skill discovery conversation.',
      );
      return;
    }
    await handler(scope);
  } catch (error) {
    sendRouteError(ctx, res, error);
  }
}

function sendRouteError(
  ctx: RegisterSkillDiscoveryToolRoutesDeps,
  res: Response,
  error: unknown,
): void {
  if (error instanceof SkillDiscoveryStateError) {
    ctx.http.sendApiError(res, 409, 'SKILL_DISCOVERY_STATE_CONFLICT', error.message);
    return;
  }
  if (error instanceof OfficialSkillDiscoveryCatalogError) {
    const changed = /changed|digest|revision|unavailable|requested .* role/iu.test(error.message);
    ctx.http.sendApiError(
      res,
      changed ? 409 : 500,
      changed ? 'SKILL_DISCOVERY_CATALOG_CHANGED' : 'SKILL_DISCOVERY_CATALOG_INVALID',
      error.message,
      changed ? { retryable: true } : undefined,
    );
    return;
  }
  if (error instanceof SkillDiscoveryMaterializationError) {
    ctx.http.sendApiError(
      res,
      500,
      'SKILL_DISCOVERY_MATERIALIZATION_FAILED',
      error.message,
      { retryable: true },
    );
    return;
  }
  ctx.http.sendApiError(
    res,
    500,
    'INTERNAL_ERROR',
    error instanceof Error ? error.message : String(error),
  );
}

function requireActiveDiscoveryState(
  ctx: RegisterSkillDiscoveryToolRoutesDeps,
  res: Response,
  scope: SkillDiscoveryRunScope,
): SkillDiscoveryState | null {
  const state = readSkillDiscoveryState(ctx.db, scope.conversationId);
  if (!state) {
    ctx.http.sendApiError(
      res,
      409,
      'SKILL_DISCOVERY_NOT_INITIALIZED',
      'Skill discovery is not enabled for this conversation.',
    );
    return null;
  }
  if (state.activeRunId !== scope.runId || state.projectId !== scope.projectId) {
    ctx.http.sendApiError(
      res,
      409,
      'SKILL_DISCOVERY_SCOPE_UNAVAILABLE',
      'Skill discovery state does not belong to the active tool-token run.',
    );
    return null;
  }
  return state;
}

function sendValidationError(
  ctx: RegisterSkillDiscoveryToolRoutesDeps,
  res: Response,
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): void {
  ctx.http.sendApiError(res, 400, 'BAD_REQUEST', formatIssues(issues));
}

function formatIssues(
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): string {
  return issues
    .map((issue) => `${issue.path.map(String).join('.') || 'body'}: ${issue.message}`)
    .join('; ');
}

function digestText(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function publicState(state: SkillDiscoveryState) {
  return PublicSkillDiscoveryStateV1Schema.parse({
    schemaVersion: state.schemaVersion,
    status: state.status,
    catalogRevision: state.catalogRevision,
    activePrimary: state.activePrimary,
    activeAuxiliaries: state.activeAuxiliaries,
    superseded: state.superseded,
    lastResolution: state.lastResolution,
    revision: state.revision,
  });
}

// Keep these request types reachable for focused CLI/route compatibility tests.
export type {
  SkillDiscoveryToolLoadRequestV1 as SkillDiscoveryLoadRouteRequest,
  SkillDiscoveryToolResolveRequestV1 as SkillDiscoveryResolveRouteRequest,
  OfficialSkillDiscoverySearchRequestV1 as SkillDiscoverySearchRouteRequest,
};
