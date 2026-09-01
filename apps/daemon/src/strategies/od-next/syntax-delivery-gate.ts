import path from 'node:path';

import type { OdNextSyntaxDiagnosticV1 } from '@open-design/contracts';

import type { RunArtifactDiff } from '../../run-artifact-fs.js';
import type {
  StrategyChangeDetectionState,
  StrategyDeliverySyntaxState,
  StrategyDeliverableCodeChange,
  StrategySyntaxValidationRecord,
} from '../task-store.js';
import {
  checkOdNextJavaScriptSyntax,
  OD_NEXT_JAVASCRIPT_SYNTAX_CHECKER_HASH,
  OD_NEXT_JAVASCRIPT_SYNTAX_CHECKER_VERSION,
  type CheckOdNextJavaScriptSyntaxInput,
  type OdNextJavaScriptSyntaxCheckResult,
} from './javascript-syntax-check.js';

type SyntaxChecker = (
  input: CheckOdNextJavaScriptSyntaxInput,
) => Promise<OdNextJavaScriptSyntaxCheckResult>;

export interface OdNextSyntaxDeliveryGateResult {
  validation: StrategySyntaxValidationRecord;
  deliverySyntaxState: StrategyDeliverySyntaxState;
  diagnostics: OdNextSyntaxDiagnosticV1[];
  checkedFileCount: number;
  repairRequired: boolean;
  incompleteReason?: string;
}

export async function evaluateOdNextSyntaxDeliveryGate(input: {
  projectRoot: string;
  entryFile: string;
  changeDetectionState: StrategyChangeDetectionState;
  diff?: RunArtifactDiff;
  processTreeQuiescent: boolean;
  checker?: SyntaxChecker;
}): Promise<OdNextSyntaxDeliveryGateResult> {
  const startedAt = Date.now();
  const entryFile = normalizeRelativePath(input.projectRoot, input.entryFile);
  const potential = potentialCodeChanges(input.projectRoot, entryFile, input.diff);
  const baseCheck = {
    checkerVersion: OD_NEXT_JAVASCRIPT_SYNTAX_CHECKER_VERSION,
    checkerHash: OD_NEXT_JAVASCRIPT_SYNTAX_CHECKER_HASH,
  };
  const finish = (result: Omit<OdNextSyntaxDeliveryGateResult, 'validation'> & {
    state: StrategySyntaxValidationRecord['syntaxCheck']['state'];
    changes: StrategyDeliverableCodeChange[];
    diagnosticSummary: StrategySyntaxValidationRecord['syntaxCheck']['diagnosticSummary'];
    skipReason?: StrategySyntaxValidationRecord['syntaxCheck']['skipReason'];
  }): OdNextSyntaxDeliveryGateResult => ({
    validation: {
      changeDetectionState: input.changeDetectionState,
      deliverableCodeChanges: result.changes,
      syntaxCheck: {
        state: result.state,
        ...baseCheck,
        durationMs: Math.max(0, Date.now() - startedAt),
        errorCount: result.diagnosticSummary.length,
        errorFileCount: new Set(result.diagnosticSummary.map(({ file }) => file)).size,
        diagnosticSummary: result.diagnosticSummary,
        ...(result.skipReason ? { skipReason: result.skipReason } : {}),
      },
    },
    deliverySyntaxState: result.deliverySyntaxState,
    diagnostics: result.diagnostics,
    checkedFileCount: result.checkedFileCount,
    repairRequired: result.repairRequired,
    ...(result.incompleteReason ? { incompleteReason: result.incompleteReason } : {}),
  });

  if (input.changeDetectionState !== 'complete') {
    return finish({
      state: 'check_incomplete',
      changes: potential.filter(({ role }) => role === 'entry_html'),
      diagnosticSummary: [],
      deliverySyntaxState: 'check_incomplete',
      diagnostics: [],
      checkedFileCount: 0,
      repairRequired: false,
      incompleteReason: `change_detection_${input.changeDetectionState}`,
    });
  }
  if (potential.length === 0) {
    return finish({
      state: 'skipped',
      skipReason: 'no_relevant_change',
      changes: [],
      diagnosticSummary: [],
      deliverySyntaxState: 'not_checked',
      diagnostics: [],
      checkedFileCount: 0,
      repairRequired: false,
    });
  }
  if (!input.processTreeQuiescent) {
    return finish({
      state: 'check_incomplete',
      changes: potential,
      diagnosticSummary: [],
      deliverySyntaxState: 'check_incomplete',
      diagnostics: [],
      checkedFileCount: 0,
      repairRequired: false,
      incompleteReason: 'process_tree_not_quiescent',
    });
  }

  const checked = await (input.checker ?? checkOdNextJavaScriptSyntax)({
    projectRoot: input.projectRoot,
    entryFile,
  });
  const checkedFiles = new Set(checked.checkedFiles);
  const reachableChanges = potential.filter((change) => (
    change.role === 'entry_html' || checkedFiles.has(change.path)
  ));
  const entryChanged = reachableChanges.some(({ role }) => role === 'entry_html');
  const reachableDependencyChanged = reachableChanges.some(
    ({ role }) => role === 'render_dependency',
  );
  if (!entryChanged && !reachableDependencyChanged) {
    if (checked.status === 'check_incomplete') {
      return finish({
        state: 'check_incomplete',
        changes: [],
        diagnosticSummary: [],
        deliverySyntaxState: 'check_incomplete',
        diagnostics: [],
        checkedFileCount: checked.checkedFiles.length,
        repairRequired: false,
        incompleteReason: checked.reason,
      });
    }
    return finish({
      state: 'skipped',
      skipReason: 'no_relevant_change',
      changes: [],
      diagnosticSummary: [],
      deliverySyntaxState: 'not_checked',
      diagnostics: [],
      checkedFileCount: checked.checkedFiles.length,
      repairRequired: false,
    });
  }
  if (checked.status === 'check_incomplete') {
    return finish({
      state: 'check_incomplete',
      changes: reachableChanges,
      diagnosticSummary: [],
      deliverySyntaxState: 'check_incomplete',
      diagnostics: [],
      checkedFileCount: checked.checkedFiles.length,
      repairRequired: false,
      incompleteReason: checked.reason,
    });
  }
  if (checked.status === 'no_syntax_error_found') {
    return finish({
      state: 'no_syntax_error_found',
      changes: reachableChanges,
      diagnosticSummary: [],
      deliverySyntaxState: 'syntax_checked',
      diagnostics: [],
      checkedFileCount: checked.checkedFiles.length,
      repairRequired: false,
    });
  }
  if (checked.errors.length > 50) {
    return finish({
      state: 'check_incomplete',
      changes: reachableChanges,
      diagnosticSummary: [],
      deliverySyntaxState: 'check_incomplete',
      diagnostics: [],
      checkedFileCount: checked.checkedFiles.length,
      repairRequired: false,
      incompleteReason: 'diagnostic_limit_exceeded',
    });
  }
  const diagnostics = checked.errors.map((diagnostic) => ({
    ...diagnostic,
    message: diagnostic.message.slice(0, 1_000),
    sourceExcerpt: diagnostic.sourceExcerpt.slice(0, 1_000),
  }));
  return finish({
    state: 'syntax_error',
    changes: reachableChanges,
    diagnosticSummary: diagnostics.map(({ sourceExcerpt: _sourceExcerpt, ...summary }) => summary),
    deliverySyntaxState: 'not_checked',
    diagnostics,
    checkedFileCount: checked.checkedFiles.length,
    repairRequired: true,
  });
}

function potentialCodeChanges(
  projectRoot: string,
  entryFile: string,
  diff: RunArtifactDiff | undefined,
): StrategyDeliverableCodeChange[] {
  if (!diff || !/\.html?$/iu.test(entryFile)) return [];
  const changes = new Map<string, StrategyDeliverableCodeChange>();
  const add = (
    filePath: string,
    change: StrategyDeliverableCodeChange['change'],
    role: StrategyDeliverableCodeChange['role'],
  ) => {
    const relative = normalizeRelativePath(projectRoot, filePath);
    if (role === 'render_dependency' && !/\.(?:cjs|js|mjs)$/iu.test(relative)) return;
    changes.set(`${role}\0${relative}`, { path: relative, change, role });
  };
  for (const filePath of diff.contentCreatedPaths) {
    const relative = normalizeRelativePath(projectRoot, filePath);
    if (relative === entryFile) add(filePath, 'created', 'entry_html');
  }
  for (const filePath of diff.contentModifiedPaths) {
    const relative = normalizeRelativePath(projectRoot, filePath);
    if (relative === entryFile) add(filePath, 'modified', 'entry_html');
  }
  for (const filePath of diff.renderDependencyCreatedPaths) {
    add(filePath, 'created', 'render_dependency');
  }
  for (const filePath of diff.renderDependencyModifiedPaths) {
    add(filePath, 'modified', 'render_dependency');
  }
  return [...changes.values()].sort((left, right) => (
    left.path.localeCompare(right.path) || left.role.localeCompare(right.role)
  ));
}

function normalizeRelativePath(projectRoot: string, filePath: string): string {
  const absolute = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(projectRoot, filePath);
  const relative = path.relative(path.resolve(projectRoot), absolute);
  if (
    !relative
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new TypeError('Syntax delivery paths must stay inside the project root.');
  }
  return relative.replaceAll(path.sep, '/');
}
