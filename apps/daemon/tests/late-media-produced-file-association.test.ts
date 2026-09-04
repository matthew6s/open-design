/**
 * 媒体产物是**在这一轮结束之后**才落盘的 —— Plane OPEND-2608 / OPEND-2609。
 *
 * `run-produced-files.ts` 那道地板跑在 run 的 terminal chokepoint 上,吃的是这一轮
 * 自己的文件系统 diff。可媒体生成是 202 异步的:`handleGenerate` 立刻返回,
 * provider 的 promise 晚几十秒才 resolve,文件是在**快照拍完之后**才写进项目的。
 * 于是那一刻的 diff 是空的,地板第一行 `touchedPaths.length === 0` 直接 return。
 *
 * 客户端那一半同样够不着:`ProjectView` 的 `onDone` 也是在 terminal 那一刻算
 * `computeProducedFiles`,晚到的文件不在它的 `authoritativeArtifactPaths` 里、也
 * 不在它刚拉的文件列表里。所以它会给这条消息写一份**不含该媒体文件**的清单
 * (常常是 `[]`)—— 这正是 2609 的症状:音频生成出来了、右侧能播,聊天里没有卡。
 *
 * 这条测试把顺序本身钉死,而不是相信推理:
 *   1. 一轮真的 run,agent 只做一件事 —— 用 run 自己的 `OD_TOOL_TOKEN` 打
 *      `POST /api/tools/media/generate`,拿到 202 就退出(真实里就是 `od media
 *      generate` 25s 轮询预算耗尽后的那条 "still running" 交接)。
 *   2. 等 `runStatus` 变成 terminal,**当场断言文件还没落盘** —— 这一步是事实
 *      本身,不是断言风格问题:它证明这一轮的 diff 里不可能有这个文件。
 *   3. 等媒体任务 done,断言该文件已经关联到这条 assistant message 上。
 *
 * provider 用的是 `custom-image`(OpenAI 兼容、baseUrl 可配),指向测试自己起的
 * 一个**故意慢**的本地 HTTP server。这样「晚于 terminal」是构造出来的,不是赌
 * 出来的;stub fallback 全程关闭,provider 出问题就直接红,不会悄悄写占位字节。
 */

import type http from 'node:http';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { startServer } from '../src/server.js';

/** provider 回一张真 1x1 PNG —— `sniffImageExt` 认它,写盘也是真字节。 */
const ONE_BY_ONE_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * provider 至少要慢这么久。
 *
 * run 的 terminal 只差「子进程退出 + 一次项目快照」,量级是几十毫秒;把 provider
 * 压到秒级,顺序就不再是竞态而是构造。
 */
const PROVIDER_DELAY_MS = 4_000;

let baseUrl: string;
let server: http.Server;
let providerServer: http.Server;
let providerUrl: string;
let dataDir: string;
const tempDirs: string[] = [];

async function withFakeAgent<T>(binName: string, script: string, run: () => Promise<T>): Promise<T> {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'od-late-media-bin-'));
  tempDirs.push(dir);
  const oldPath = process.env.PATH;
  try {
    if (process.platform === 'win32') {
      const runner = join(dir, `${binName}-test-runner.cjs`);
      await fsp.writeFile(runner, script);
      await fsp.writeFile(join(dir, `${binName}.cmd`), `@echo off\r\nnode "${runner}" %*\r\n`);
    } else {
      const bin = join(dir, binName);
      await fsp.writeFile(bin, `#!/usr/bin/env node\n${script}`);
      await fsp.chmod(bin, 0o755);
    }
    process.env.PATH = `${dir}${delimiter}${oldPath ?? ''}`;
    return await run();
  } finally {
    process.env.PATH = oldPath;
  }
}

interface StoredMessage {
  id: string;
  role: string;
  runId?: string;
  runStatus?: string;
  producedFiles?: Array<{ name: string; kind?: string; mime?: string; size?: number }>;
}

async function readMessages(projectId: string, conversationId: string): Promise<StoredMessage[]> {
  const res = await fetch(
    `${baseUrl}/api/projects/${projectId}/conversations/${conversationId}/messages`,
  );
  expect(res.ok).toBe(true);
  return ((await res.json()) as { messages: StoredMessage[] }).messages;
}

async function waitFor<T>(
  probe: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await probe();
  while (!predicate(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    last = await probe();
  }
  return last;
}

const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'canceled']);

describe('a media file that lands after the run terminal still reaches its message', () => {
  beforeAll(async () => {
    // A deliberately slow OpenAI-compatible image endpoint.
    providerServer = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: [{ b64_json: ONE_BY_ONE_PNG_B64 }] }));
        }, PROVIDER_DELAY_MS);
      });
    });
    await new Promise<void>((done) => providerServer.listen(0, '127.0.0.1', () => done()));
    const address = providerServer.address();
    if (!address || typeof address === 'string') throw new Error('provider server has no port');
    providerUrl = `http://127.0.0.1:${address.port}/v1`;

    // Keep the provider credential out of the shared vitest data dir so no other
    // suite in this process inherits it.
    const configDir = await fsp.mkdtemp(join(tmpdir(), 'od-late-media-config-'));
    tempDirs.push(configDir);
    vi.stubEnv('OD_MEDIA_CONFIG_DIR', configDir);

    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
    dataDir = process.env.OD_DATA_DIR!;

    const configured = await fetch(`${baseUrl}/api/media/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providers: {
          'custom-image': {
            apiKey: 'late-media-test-key',
            baseUrl: providerUrl,
            model: 'slow-image-model',
          },
        },
      }),
    });
    expect(configured.ok, 'the custom-image provider must be configured').toBe(true);
  }, 60_000);

  afterAll(async () => {
    if (server) await new Promise<void>((done) => server.close(() => done()));
    if (providerServer) await new Promise<void>((done) => providerServer.close(() => done()));
    for (const dir of tempDirs.splice(0)) {
      await fsp.rm(dir, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
  });

  it('associates the late media output with the run\'s assistant message', async () => {
    const projectId = `proj-${randomUUID()}`;
    const assistantMessageId = `assistant-${randomUUID()}`;
    const created = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: 'late media fixture' }),
    });
    expect(created.ok).toBe(true);

    const conversations = await fetch(`${baseUrl}/api/projects/${projectId}/conversations`);
    expect(conversations.ok).toBe(true);
    const conversationId = ((await conversations.json()) as {
      conversations: Array<{ id: string }>;
    }).conversations[0]?.id;
    expect(conversationId).toBeTruthy();

    // The agent does exactly what `od media generate` does when its polling
    // budget runs out: dispatch, take the 202, hand off, exit. It writes
    // nothing itself, so this run's own diff is empty.
    const script = `
(async () => {
  const daemonUrl = process.env.OD_DAEMON_URL;
  const token = process.env.OD_TOOL_TOKEN;
  let line = 'taskid=none=taskid';
  try {
    const resp = await fetch(daemonUrl + '/api/tools/media/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({
        surface: 'image',
        model: 'custom-image',
        prompt: 'a poster that lands late',
        output: 'poster.png',
      }),
    });
    const text = await resp.text();
    let taskId = 'none';
    try { taskId = JSON.parse(text).taskId || 'none'; } catch {}
    line = 'status=' + resp.status + '=status taskid=' + taskId + '=taskid';
  } catch (err) {
    line = 'dispatcherror=' + String(err && err.message ? err.message : err) + '=dispatcherror';
  }
  console.log(JSON.stringify({ type: 'step_start' }));
  console.log(JSON.stringify({ type: 'text', part: { text: line } }));
  console.log(JSON.stringify({ type: 'step_finish', part: { tokens: { input: 1, output: 1 } } }));
  process.exit(0);
})();
`;

    const body = await withFakeAgent('opencode', script, async () => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: 'opencode',
          projectId,
          conversationId,
          assistantMessageId,
          message: '生成一张海报',
        }),
      });
      expect(response.ok).toBe(true);
      return await response.text();
    });

    expect(body, 'the agent could not reach the media dispatcher').not.toContain('dispatcherror=');
    expect(/status=202=status/.test(body), `media dispatch was not accepted: ${body.slice(0, 2000)}`)
      .toBe(true);
    const taskId = /taskid=([0-9a-f-]{36})=taskid/.exec(body)?.[1];
    expect(taskId, 'the run must have queued a media task').toBeTruthy();

    // ---- the fact: the run reaches terminal before the file exists ----
    const terminal = await waitFor(
      async () =>
        (await readMessages(projectId, conversationId!)).find((m) => m.id === assistantMessageId),
      (m) => Boolean(m?.runStatus && TERMINAL_RUN_STATUSES.has(m.runStatus)),
    );
    expect(terminal?.runStatus).toBe('succeeded');

    const outputPath = join(dataDir, 'projects', projectId, 'poster.png');
    expect(
      existsSync(outputPath),
      'the media file already existed at the run terminal — the ordering premise of this test does not hold',
    ).toBe(false);

    // ---- the media task finishes on its own timeline ----
    let status = '';
    for (let attempt = 0; attempt < 30 && status !== 'done' && status !== 'failed'; attempt += 1) {
      const waited = await fetch(`${baseUrl}/api/media/tasks/${taskId}/wait`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ timeoutMs: 2_000 }),
      });
      expect(waited.status).toBe(200);
      status = ((await waited.json()) as { status: string }).status;
    }
    expect(status, 'the media task never completed').toBe('done');
    expect(existsSync(outputPath), 'the provider never wrote the file').toBe(true);

    // ---- the assertion this ticket is about ----
    const message = await waitFor(
      async () =>
        (await readMessages(projectId, conversationId!)).find((m) => m.id === assistantMessageId),
      (m) => (m?.producedFiles ?? []).some((f) => f.name === 'poster.png'),
      10_000,
    );
    expect(
      (message?.producedFiles ?? []).map((f) => f.name),
      '晚落盘的媒体产物没有关联到这一轮的 assistant message',
    ).toContain('poster.png');

    const card = message!.producedFiles!.find((f) => f.name === 'poster.png')!;
    expect(card.kind).toBe('image');
    expect(card.mime).toContain('image');
    expect(card.size).toBeGreaterThan(0);
  }, 90_000);
});

// Keep `resolve` referenced for the data-dir join above on every platform.
void resolve;
