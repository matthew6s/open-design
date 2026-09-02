// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { forwardRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, ProjectMediaTask } from '@open-design/contracts';
import { ChatPane } from '../../src/components/ChatPane';

const registryMocks = vi.hoisted(() => ({
  fetchProjectMediaTasks: vi.fn(),
}));

vi.mock('../../src/providers/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/registry')>();
  return {
    ...actual,
    fetchProjectMediaTasks: registryMocks.fetchProjectMediaTasks,
  };
});

vi.mock('../../src/i18n', () => ({
  useI18n: () => ({ locale: 'zh-CN', setLocale: () => undefined, t: (key: string) => key }),
  useT: () => (key: string) => key,
}));

vi.mock('../../src/components/AssistantMessage', () => ({
  AssistantMessage: ({
    message,
    mediaTasks = [],
  }: {
    message: ChatMessage;
    mediaTasks?: ProjectMediaTask[];
  }) => (
    <output data-testid={`assistant-media-${message.id}`}>
      {mediaTasks.map((task) => `${task.taskId}:${task.status}`).join(',')}
    </output>
  ),
}));

vi.mock('../../src/components/ChatComposer', () => ({
  ChatComposer: forwardRef((_props, _ref) => <div data-testid="composer" />),
}));

vi.mock('../../src/components/PixelLiquid', () => ({
  PixelLiquid: () => <span aria-hidden />,
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('ChatPane media-task polling', () => {
  it('polls the latest streaming run before ACP emits its terminal media tool_use', async () => {
    registryMocks.fetchProjectMediaTasks.mockResolvedValue({
      tasks: [{
        taskId: 'media-1',
        runId: 'run-media',
        status: 'running',
        surface: 'image',
        startedAt: 100,
        endedAt: null,
        elapsed: 0,
        progress: [],
        progressCount: 0,
      } satisfies ProjectMediaTask],
    });

    render(
      <ChatPane
        messages={[{
          id: 'assistant-1',
          role: 'assistant',
          content: '',
          createdAt: 1,
          runId: 'run-media',
          runStatus: 'running',
          // ACP has exposed its plan, but the media command itself only arrives
          // when the terminal call completes.
          events: [{
            kind: 'tool_use',
            id: 'todo-1',
            name: 'TodoWrite',
            input: { todos: [{ content: '生成配套插图', status: 'in_progress' }] },
          }],
        }]}
        streaming
        error={null}
        projectId="project-1"
        projectFiles={[]}
        onEnsureProject={async () => 'project-1'}
        onSend={vi.fn()}
        onStop={vi.fn()}
        conversations={[]}
        activeConversationId="conversation-1"
        onSelectConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(registryMocks.fetchProjectMediaTasks).toHaveBeenCalledWith('project-1', null);
      expect(screen.getByTestId('assistant-media-assistant-1').textContent).toBe('media-1:running');
    });
  });

  it('keeps a bounded terminal confirmation poll until the completed file is registered', async () => {
    vi.useFakeTimers();
    const baseTask = {
      taskId: 'media-terminal',
      runId: 'run-terminal',
      status: 'done',
      surface: 'image',
      startedAt: 100,
      endedAt: 200,
      elapsed: 0,
      progress: [],
      progressCount: 0,
    } satisfies ProjectMediaTask;
    registryMocks.fetchProjectMediaTasks
      .mockResolvedValueOnce({ tasks: [baseTask] })
      .mockResolvedValue({
        tasks: [{ ...baseTask, file: { name: 'final/generated.png' } }],
      });

    render(
      <ChatPane
        messages={[{
          id: 'assistant-terminal',
          role: 'assistant',
          content: '',
          createdAt: 1,
          endedAt: 300,
          runId: 'run-terminal',
          runStatus: 'succeeded',
          events: [{
            kind: 'tool_use',
            id: 'media-call',
            name: 'Bash',
            input: { command: 'od media generate --output generated.png' },
          }],
        }]}
        streaming={false}
        error={null}
        projectId="project-1"
        projectFiles={[]}
        onEnsureProject={async () => 'project-1'}
        onSend={vi.fn()}
        onStop={vi.fn()}
        conversations={[]}
        activeConversationId="conversation-1"
        onSelectConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(registryMocks.fetchProjectMediaTasks).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(749);
    });
    expect(registryMocks.fetchProjectMediaTasks).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(registryMocks.fetchProjectMediaTasks).toHaveBeenCalledTimes(2);
  });

  it('stops terminal file confirmation after the bounded retry budget', async () => {
    vi.useFakeTimers();
    registryMocks.fetchProjectMediaTasks.mockResolvedValue({
      tasks: [{
        taskId: 'media-unconfirmed',
        runId: 'run-unconfirmed',
        status: 'done',
        surface: 'image',
        startedAt: 100,
        endedAt: 200,
        elapsed: 0,
        progress: [],
        progressCount: 0,
      } satisfies ProjectMediaTask],
    });

    render(
      <ChatPane
        messages={[{
          id: 'assistant-unconfirmed',
          role: 'assistant',
          content: '',
          createdAt: 1,
          endedAt: 300,
          runId: 'run-unconfirmed',
          runStatus: 'succeeded',
          events: [{
            kind: 'tool_use',
            id: 'media-call',
            name: 'Bash',
            input: { command: 'od media generate --output missing.png' },
          }],
        }]}
        streaming={false}
        error={null}
        projectId="project-1"
        projectFiles={[]}
        onEnsureProject={async () => 'project-1'}
        onSend={vi.fn()}
        onStop={vi.fn()}
        conversations={[]}
        activeConversationId="conversation-1"
        onSelectConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(750 * 10);
    });
    expect(registryMocks.fetchProjectMediaTasks).toHaveBeenCalledTimes(9);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(750 * 2);
    });
    expect(registryMocks.fetchProjectMediaTasks).toHaveBeenCalledTimes(9);
  });
});
