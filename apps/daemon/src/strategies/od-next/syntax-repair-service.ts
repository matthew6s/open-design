import {
  composeOdNextStrategyContinuationV2,
  type OdNextSyntaxDiagnosticV1,
  type StrategyExecutionModeV2,
  type StrategyRouteV2,
} from '@open-design/contracts';
import type Database from 'better-sqlite3';

import type {
  InternalPhysicalRun,
  InternalRunCreateInput,
  InternalRunCreationService,
  PreparedInternalRunResult,
} from '../../services/internal-run-service.js';
import {
  compareAndTransitionStrategyTaskExecution,
  type StrategySyntaxValidationRecord,
  type StrategyTaskExecutionRecord,
} from '../task-store.js';

type SqliteDb = Database.Database;

export class OdNextSyntaxRepairPreparationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OdNextSyntaxRepairPreparationError';
  }
}

export interface PreparedOdNextSyntaxRepair<TRun> {
  prepared: PreparedInternalRunResult<TRun>;
  task: StrategyTaskExecutionRecord;
  fullInstruction: string;
  persistedInstruction: string;
}

/**
 * Claim the one host-owned syntax repair Run.
 *
 * `persistedInstruction` deliberately replaces source excerpts before it is
 * handed to the normal Run/message persistence path. The complete instruction
 * is returned separately for one-shot in-memory delivery to the native Agent
 * session; callers must never assign it to Run state or analytics fields.
 */
export function prepareOdNextSyntaxRepairRun<
  TMeta extends InternalRunCreateInput,
  TRun extends InternalPhysicalRun,
>(input: {
  db: SqliteDb;
  service: InternalRunCreationService<TMeta, TRun>;
  task: StrategyTaskExecutionRecord;
  route: StrategyRouteV2;
  executionMode: StrategyExecutionModeV2;
  diagnostics: OdNextSyntaxDiagnosticV1[];
  validation: StrategySyntaxValidationRecord;
  createMeta: (persistedInstruction: string, taskRunIndex: number) => TMeta;
  updatedAt?: number;
}): PreparedOdNextSyntaxRepair<TRun> {
  if (input.validation.syntaxCheck.state !== 'syntax_error') {
    throw new OdNextSyntaxRepairPreparationError(
      'Only a confirmed syntax_error may allocate a syntax repair Run.',
    );
  }
  if (input.task.syntaxRepairAttempts !== 0) {
    throw new OdNextSyntaxRepairPreparationError(
      'A logical OD Next task may allocate only one syntax repair Run.',
    );
  }
  if (input.task.latestRunId !== input.task.activeRunId) {
    throw new OdNextSyntaxRepairPreparationError(
      'Syntax repair must continue from the active latest physical Run.',
    );
  }

  const continuationBase = {
    stage: 'syntax_repair' as const,
    nativeSessionResume: true as const,
    taskExecutionId: input.task.taskExecutionId,
    taskRunIndex: input.task.runs.length,
  };
  const fullInstruction = composeOdNextStrategyContinuationV2({
    ...continuationBase,
    diagnostics: input.diagnostics,
  });
  const persistedInstruction = composeOdNextStrategyContinuationV2({
    ...continuationBase,
    diagnostics: input.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      sourceExcerpt: '[redacted from persisted task state]',
    })),
  });

  let claimed: StrategyTaskExecutionRecord | null = null;
  const prepared = input.service.prepare({
    meta: input.createMeta(persistedInstruction, input.task.runs.length),
    beforeClaimCommit: (nextRun) => {
      claimed = compareAndTransitionStrategyTaskExecution(input.db, {
        taskExecutionId: input.task.taskExecutionId,
        expectedRevision: input.task.revision,
        to: {
          route: input.route,
          inputStage: 'syntax_repair',
          outcome: 'running',
          executionMode: input.executionMode,
        },
        nextRun: {
          runId: nextRun.id,
          sourceRunId: input.task.latestRunId,
          finalText: persistedInstruction,
          runPurpose: 'syntax_auto_repair',
        },
        syntaxValidation: input.validation,
        deliverySyntaxState: 'not_checked',
        ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
      });
    },
  });
  if (prepared.kind !== 'ready' || !claimed) {
    throw new OdNextSyntaxRepairPreparationError(
      `Syntax repair Run could not be claimed (${prepared.kind}).`,
    );
  }
  const task = claimed as StrategyTaskExecutionRecord;
  return {
    prepared,
    task,
    fullInstruction,
    persistedInstruction,
  };
}
