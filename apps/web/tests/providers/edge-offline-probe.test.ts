/**
 * PROBE (temporary): does the LIVE-SEND path (`streamViaDaemon`) surface the
 * reconnect ladder when the tab goes offline mid-stream?
 *
 * Every existing reconnect test drives `reattachDaemonRun`. This one drives the
 * path a normal "type a prompt and hit send" turn actually uses.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DAEMON_STREAM_RECONNECT_LIMIT,
  streamViaDaemon,
  type DaemonReconnectState,
} from '../../src/providers/daemon';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const FIRST_EVENT = 'id: 1\nevent: stdout\ndata: {"chunk":"hello"}\n\n';

/** A stream that delivers one run event and then dies the way a dropped tab dies. */
function sseThenNetworkDrop(): Response {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(FIRST_EVENT));
        // The browser fails the in-flight body read once the tab is offline.
        setTimeout(() => controller.error(new TypeError('Failed to fetch')), 10);
      },
    }),
    text: () => Promise.resolve(FIRST_EVENT),
  } as unknown as Response;
}

describe('probe: live-send reconnect ladder when the tab drops', () => {
  it('reports reconnect attempts and then exhaustion', async () => {
    vi.useFakeTimers();
    const states: DaemonReconnectState[] = [];
    let eventsCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/runs') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ runId: 'run-1' }),
          text: async () => '{"runId":"run-1"}',
        } as unknown as Response;
      }
      if (url.includes('/events')) {
        eventsCalls += 1;
        if (eventsCalls === 1) return sseThenNetworkDrop();
        // Offline: every later request fails before it leaves the tab.
        throw new TypeError('Failed to fetch');
      }
      // Status probes fail the same way.
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);

    const settled = streamViaDaemon({
      agentId: 'mock',
      history: [{ id: '1', role: 'user', content: 'hello' }],
      signal: new AbortController().signal,
      handlers: {
        onDelta: () => {},
        onDone: () => {},
        onError: () => {},
        onAgentEvent: () => {},
        onReconnect: (state) => { states.push(state); },
      },
      projectId: 'proj-1',
      conversationId: 'conv-1',
    } as never).catch(() => {});

    await vi.advanceTimersByTimeAsync(180_000);
    await settled;

    // eslint-disable-next-line no-console
    console.log('PROBE states:', JSON.stringify(states));
    expect(states.filter((s) => s.phase === 'reconnecting').map((s) => s.attempt))
      .toEqual([1, 2, 3, 4, 5]);
    expect(states.at(-1)).toEqual({
      attempt: DAEMON_STREAM_RECONNECT_LIMIT,
      max: DAEMON_STREAM_RECONNECT_LIMIT,
      phase: 'exhausted',
    });
  });
});
