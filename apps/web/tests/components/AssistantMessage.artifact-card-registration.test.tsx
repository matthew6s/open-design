// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { AssistantMessage } from '../../src/components/AssistantMessage';
import type { ChatMessage, ProjectFile } from '../../src/types';

afterEach(cleanup);

const FILE_NAME = 'index.html';

function file(): ProjectFile {
  return {
    name: FILE_NAME,
    path: FILE_NAME,
    size: 4096,
    mtime: 1_700_000_005,
    kind: 'html',
    mime: 'text/html',
  } as ProjectFile;
}

function writeEvents(done: boolean): ChatMessage['events'] {
  return [
    {
      kind: 'tool_use',
      id: 'write-1',
      name: 'Write',
      input: { file_path: FILE_NAME },
    },
    ...(done
      ? [{ kind: 'tool_result', toolUseId: 'write-1', content: 'Wrote index.html', isError: false }]
      : []),
  ] as ChatMessage['events'];
}

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: 'Building the page.',
    startedAt: 1_700_000_000,
    events: [],
    ...overrides,
  } as ChatMessage;
}

function renderMessage(value: ChatMessage, streaming: boolean) {
  return render(
    <AssistantMessage
      message={value}
      streaming={streaming}
      projectId="project-1"
      projectFiles={[file()]}
      isLast
    />,
  );
}

describe('artifact card registration without an optional artifact-focus marker', () => {
  it('registers a pending card from a live Write event', () => {
    renderMessage(
      message({ runStatus: 'running', events: writeEvents(false), producedFiles: undefined }),
      true,
    );

    expect(screen.getByTestId(`artifact-card-${FILE_NAME}`)).toBeTruthy();
    expect(document.querySelectorAll('[data-artifact-card]')).toHaveLength(1);
  });

  it('keeps the card when the Write reaches terminal success before producedFiles reconciliation', () => {
    renderMessage(
      message({
        runStatus: 'succeeded',
        endedAt: 1_700_000_005,
        events: writeEvents(true),
        producedFiles: undefined,
      }),
      false,
    );

    expect(screen.getByTestId(`artifact-card-${FILE_NAME}`)).toBeTruthy();
    expect(document.querySelectorAll('[data-artifact-card]')).toHaveLength(1);
  });

  it('respects an authoritative empty reconciliation even when the turn declared a card', () => {
    renderMessage(
      message({
        runStatus: 'succeeded',
        endedAt: 1_700_000_005,
        events: [
          ...(writeEvents(true) ?? []),
          { kind: 'artifact_focus', show: [FILE_NAME] },
        ] as ChatMessage['events'],
        producedFiles: [],
      }),
      false,
    );

    expect(screen.queryByTestId(`artifact-card-${FILE_NAME}`)).toBeNull();
    expect(document.querySelectorAll('[data-artifact-card]')).toHaveLength(0);
    expect(screen.queryByTestId('file-ops-summary')).toBeNull();
  });

  it('replays the reconciled produced file exactly once after refresh', () => {
    renderMessage(
      message({
        runStatus: 'succeeded',
        endedAt: 1_700_000_005,
        events: writeEvents(true),
        producedFiles: [file()],
      }),
      false,
    );

    expect(screen.getByTestId(`artifact-card-${FILE_NAME}`)).toBeTruthy();
    expect(document.querySelectorAll('[data-artifact-card]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-testid="file-ops-summary"]')).toHaveLength(1);
  });
});
