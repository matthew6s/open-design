import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { test } from 'vitest';

import type { RunArtifactDiff } from '../../../src/run-artifact-fs.js';
import { evaluateOdNextSyntaxDeliveryGate } from '../../../src/strategies/od-next/syntax-delivery-gate.js';

function artifactDiff(overrides: Partial<RunArtifactDiff>): RunArtifactDiff {
  return {
    created: 0,
    modified: 0,
    touched: 0,
    designSystemCreated: false,
    previewModuleCount: 0,
    touchedPaths: [],
    contentCreated: 0,
    contentModified: 0,
    contentTouched: 0,
    contentTouchedPaths: [],
    contentCreatedPaths: [],
    contentModifiedPaths: [],
    renderDependencyTouched: 0,
    renderDependencyTouchedPaths: [],
    renderDependencyCreatedPaths: [],
    renderDependencyModifiedPaths: [],
    supportingMediaTouched: 0,
    filesWritten: 0,
    ...overrides,
  };
}

function projectRoot(): string {
  return path.join(os.tmpdir(), 'od-next-syntax-gate');
}

test('a confirmed error in a changed HTML candidate requests one repair without persisting source', async () => {
  const root = projectRoot();
  const entry = path.join(root, 'index.html');
  const result = await evaluateOdNextSyntaxDeliveryGate({
    projectRoot: root,
    entryFile: 'index.html',
    changeDetectionState: 'complete',
    processTreeQuiescent: true,
    diff: artifactDiff({
      contentModified: 1,
      contentTouched: 1,
      contentTouchedPaths: [entry],
      contentModifiedPaths: [entry],
    }),
    checker: async () => ({
      status: 'syntax_error',
      checkedSources: 1,
      checkedFiles: ['index.html'],
      errors: [{
        file: 'index.html',
        scriptKind: 'classic',
        line: 4,
        column: 9,
        errorType: 'SyntaxError',
        message: 'Unexpected token',
        sourceExcerpt: 'const answer = ;',
      }],
    }),
  });

  assert.equal(result.repairRequired, true);
  assert.equal(result.deliverySyntaxState, 'not_checked');
  assert.equal(result.validation.syntaxCheck.state, 'syntax_error');
  assert.equal(result.diagnostics[0]?.sourceExcerpt, 'const answer = ;');
  assert.equal(
    Object.hasOwn(result.validation.syntaxCheck.diagnosticSummary[0] ?? {}, 'sourceExcerpt'),
    false,
  );
});

test('a changed but unreachable JavaScript file is skipped', async () => {
  const root = projectRoot();
  const changed = path.join(root, 'unused.js');
  const result = await evaluateOdNextSyntaxDeliveryGate({
    projectRoot: root,
    entryFile: 'index.html',
    changeDetectionState: 'complete',
    processTreeQuiescent: true,
    diff: artifactDiff({
      renderDependencyTouched: 1,
      renderDependencyTouchedPaths: [changed],
      renderDependencyModifiedPaths: [changed],
    }),
    checker: async () => ({
      status: 'no_syntax_error_found',
      checkedSources: 1,
      checkedFiles: ['app.js'],
    }),
  });

  assert.equal(result.validation.syntaxCheck.state, 'skipped');
  assert.equal(result.validation.syntaxCheck.skipReason, 'no_relevant_change');
  assert.deepEqual(result.validation.deliverableCodeChanges, []);
});

test('a changed reachable JavaScript dependency is checked', async () => {
  const root = projectRoot();
  const changed = path.join(root, 'app.js');
  const result = await evaluateOdNextSyntaxDeliveryGate({
    projectRoot: root,
    entryFile: 'index.html',
    changeDetectionState: 'complete',
    processTreeQuiescent: true,
    diff: artifactDiff({
      renderDependencyTouched: 1,
      renderDependencyTouchedPaths: [changed],
      renderDependencyModifiedPaths: [changed],
    }),
    checker: async () => ({
      status: 'no_syntax_error_found',
      checkedSources: 1,
      checkedFiles: ['app.js'],
    }),
  });

  assert.equal(result.validation.syntaxCheck.state, 'no_syntax_error_found');
  assert.equal(result.deliverySyntaxState, 'syntax_checked');
  assert.deepEqual(result.validation.deliverableCodeChanges, [{
    path: 'app.js',
    change: 'modified',
    role: 'render_dependency',
  }]);
});

test('contended change detection fails open without invoking the checker', async () => {
  const root = projectRoot();
  const entry = path.join(root, 'index.html');
  let invoked = false;
  const result = await evaluateOdNextSyntaxDeliveryGate({
    projectRoot: root,
    entryFile: 'index.html',
    changeDetectionState: 'contended',
    processTreeQuiescent: true,
    diff: artifactDiff({ contentModifiedPaths: [entry] }),
    checker: async () => {
      invoked = true;
      return { status: 'no_syntax_error_found', checkedSources: 0, checkedFiles: [] };
    },
  });

  assert.equal(invoked, false);
  assert.equal(result.validation.syntaxCheck.state, 'check_incomplete');
  assert.equal(result.deliverySyntaxState, 'check_incomplete');
  assert.equal(result.repairRequired, false);
});

test('failed change detection with no diff is incomplete rather than skipped', async () => {
  let invoked = false;
  const result = await evaluateOdNextSyntaxDeliveryGate({
    projectRoot: projectRoot(),
    entryFile: 'index.html',
    changeDetectionState: 'snapshot_failed',
    processTreeQuiescent: true,
    checker: async () => {
      invoked = true;
      return { status: 'no_syntax_error_found', checkedSources: 0, checkedFiles: [] };
    },
  });

  assert.equal(invoked, false);
  assert.equal(result.validation.changeDetectionState, 'snapshot_failed');
  assert.equal(result.validation.syntaxCheck.state, 'check_incomplete');
  assert.equal(result.validation.syntaxCheck.skipReason, undefined);
  assert.equal(result.deliverySyntaxState, 'check_incomplete');
  assert.equal(result.incompleteReason, 'change_detection_snapshot_failed');
  assert.deepEqual(result.validation.deliverableCodeChanges, []);
  assert.equal(result.repairRequired, false);
});

test('incomplete parser coverage never schedules repair', async () => {
  const root = projectRoot();
  const entry = path.join(root, 'index.html');
  const result = await evaluateOdNextSyntaxDeliveryGate({
    projectRoot: root,
    entryFile: 'index.html',
    changeDetectionState: 'complete',
    processTreeQuiescent: true,
    diff: artifactDiff({ contentModifiedPaths: [entry] }),
    checker: async () => ({
      status: 'check_incomplete',
      checkedSources: 1,
      checkedFiles: ['index.html'],
      reason: 'dependency_unreadable',
      detail: 'unreadable',
    }),
  });

  assert.equal(result.validation.syntaxCheck.state, 'check_incomplete');
  assert.equal(result.repairRequired, false);
});
