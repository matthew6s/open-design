// @vitest-environment node
/**
 * 【**有意偏离设计稿**】进行中的行也要报耗时 —— 数据面。
 *
 * ── 稿子怎么说的 ──────────────────────────────────────────────────────
 *
 * `docs/design/chat-panel/src/body-components.html` 的 Thinking 那一格写死了理由:
 *   「**不挂耗时**:这一行**只活到第一个字落地为止**,给一个马上要消失的状态配一个
 *     跳动的秒数,只会把注意力钉在一个从此不再相关的数字上;总耗时在任务进度那一格里。」
 * 于是全稿 10/10 条进行中都没有 `.ms`,14/14 条已完成都有。
 *
 * ── 产品为什么推翻 ────────────────────────────────────────────────────
 *
 * 「只活到第一个字落地为止」这个前提对推理模型**不成立**。我们自己的真实数据里
 * 有**单轮思考 28.5 分钟**、**单个 Bash 卡住 14.1 分钟**(诊断包 run `3fc3b3ae`)
 * 的案例。一个要持续半小时的状态,说它「马上要消失」是错的 —— 用户当时的实感是
 * 「跑了 40 分钟什么都没出来」,而那 40 分钟里执行记录上**一个数字都没有**。
 *
 * 产品原话:「为啥思考中不会有计时?我感觉**进行中的 toolrow 都得有计时**吧?」
 * 裁决:思考中 / 工具行 / 步骤行,**所有进行中的行**都要显示实时递增的耗时。
 *
 * ── 怎么落的:零新增 timer ────────────────────────────────────────────
 *
 * 秒表**早就有了** —— `AssistantMessage` 的 `useTickingNow` 每秒把 `nowMs` 喂进
 * `buildTurnBlocks`(一个 message 一个 `setInterval`,`live-timer.test.tsx` 钉着)。
 * 这一整个特性因此在**数据层**算完:没有新的 `setInterval` / `rAF`,也没有组件 state。
 * 「多行同时跑只有一个 timer」和「卸载要清 timer」在构造上就满足了。
 *
 * 渲染面的断言在 `tests/components/chat/live-row-elapsed.test.tsx`。
 */
import { describe, expect, it } from 'vitest';
import type { PersistedAgentEvent } from '@open-design/contracts';
import { buildTurnBlocks } from '../../../src/runtime/chat/build-turn-blocks';
import { groupThinking, type ThoughtsGroup } from '../../../src/runtime/chat/group-thinking';
import type {
  BuildTurnInput,
  ExecutionShell,
  TodoSegment,
  ToolRow,
} from '../../../src/runtime/chat/contract';

const T0 = 1_800_000_000_000;

const shellOf = (input: BuildTurnInput): ExecutionShell => {
  const shells = buildTurnBlocks(input).filter((b): b is ExecutionShell => b.kind === 'shell');
  return shells[shells.length - 1]!;
};

const toolsIn = (shell: ExecutionShell): ToolRow[] =>
  shell.items.filter((i): i is ToolRow => i.kind === 'tool');

/** 壳顶层那几格思考(跑完收拢的那一格和还在写的那一格走同一个字段) */
const thoughtsIn = (shell: ExecutionShell, live = false): ThoughtsGroup[] =>
  groupThinking(shell.items, live).filter((g): g is ThoughtsGroup => g.kind === 'thoughts');

const segOf = (shell: ExecutionShell, content: string): TodoSegment | undefined =>
  shell.segments.find((s) => s.content === content);

/** 一次还没回来的调用:只有 `startedAt`,没有 `tool_result` */
const pendingCall = (id = 't1', startedAt = T0): PersistedAgentEvent =>
  ({ kind: 'tool_use', id, name: 'Bash', input: { command: 'curl -O big.png' }, startedAt } as PersistedAgentEvent);

const call = (id: string, startedAt: number, completedAt: number): PersistedAgentEvent[] => ([
  { kind: 'tool_use', id, name: 'Bash', input: { command: 'ls' }, startedAt } as PersistedAgentEvent,
  { kind: 'tool_result', toolUseId: id, content: 'ok', isError: false, completedAt } as PersistedAgentEvent,
]);

const todoWrite = (id: string, items: Array<[string, string]>, startedAt?: number): PersistedAgentEvent => ({
  kind: 'tool_use',
  id,
  name: 'TodoWrite',
  input: { todos: items.map(([content, status]) => ({ content, status })) },
  ...(startedAt != null ? { startedAt } : {}),
} as PersistedAgentEvent);

describe('进行中的工具行 · 实时耗时', () => {
  const live = (nowMs: number): ToolRow =>
    toolsIn(shellOf({ events: [pendingCall()], runStatus: 'running', startedAtMs: T0, nowMs }))[0]!;

  it('调用还没回来:耗时随虚拟时钟递增', () => {
    expect(live(T0 + 3_000).pending).toBe(true);
    expect(live(T0 + 3_000).elapsedMs).toBe(3_000);
    // 同一份事件流,只把「现在」往前拨 —— 数字必须跟着走
    expect(live(T0 + 9_000).elapsedMs).toBe(9_000);
    expect(live(T0 + 847_000).elapsedMs).toBe(847_000);   // 真机那次 14.1 分钟的下载
  });

  it('起点拿不到就不编数 —— §2.2b「拿不到就不显示,不估算」', () => {
    const rows = toolsIn(shellOf({
      events: [{ kind: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } } as PersistedAgentEvent],
      runStatus: 'running',
      startedAtMs: T0,
      nowMs: T0 + 9_000,
    }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.elapsedMs).toBeNull();
  });

  it('没有「现在」可用(历史消息重渲染)也不编数', () => {
    expect(toolsIn(shellOf({ events: [pendingCall()], runStatus: 'running', startedAtMs: T0 }))[0]!.elapsedMs)
      .toBeNull();
  });

  it('不到 100ms 的那一档仍然当「不知道」,不显示 `0.0s`', () => {
    expect(live(T0 + 40).elapsedMs).toBeNull();
  });

  it('轮次停了:钉在轮次收尾,不许继续跟着 `nowMs` 走', () => {
    const stopped = toolsIn(shellOf({
      events: [pendingCall()],
      runStatus: 'canceled',
      startedAtMs: T0,
      endedAtMs: T0 + 5_000,
      // 客户端的钟还在往前走,但这一轮已经停了 —— 秒数必须停在收尾那一刻
      nowMs: T0 + 99_000,
    }))[0]!;
    expect(stopped.pending).toBe(true);
    expect(stopped.elapsedMs).toBe(5_000);
  });
});

describe('还在想的那一段 · 实时耗时', () => {
  const events: PersistedAgentEvent[] = [
    ...call('t1', T0, T0 + 2_000),
    { kind: 'thinking', text: '还在想…' } as PersistedAgentEvent,
  ];
  const live = (nowMs: number): number | null =>
    thoughtsIn(shellOf({ events, runStatus: 'running', startedAtMs: T0, nowMs }), true)
      .slice(-1)[0]!.elapsedMs;

  it('推理还没收口:耗时随虚拟时钟递增', () => {
    expect(live(T0 + 30_000)).toBe(28_000);
    expect(live(T0 + 90_000)).toBe(88_000);
    expect(live(T0 + 1_712_000)).toBe(1_710_000);   // 真机那轮 28.5 分钟的思考
  });

  it('那段空白不止它一个(中间落过正文)时照旧不给数', () => {
    const shell = shellOf({
      events: [
        ...call('t1', T0, T0 + 2_000),
        { kind: 'thinking', text: '想一下。' } as PersistedAgentEvent,
        { kind: 'text', text: '我先说一句。' } as PersistedAgentEvent,
        { kind: 'thinking', text: '再想想…' } as PersistedAgentEvent,
      ],
      runStatus: 'running',
      startedAtMs: T0,
      nowMs: T0 + 30_000,
    });
    expect(thoughtsIn(shell, true).map((g) => g.elapsedMs)).toContain(null);
  });
});

describe('进行中的那条 todo · 实时耗时', () => {
  const events: PersistedAgentEvent[] = [
    todoWrite('p1', [['复刻列表页', 'in_progress'], ['抽出商品卡', 'pending']], T0),
    ...call('t1', T0, T0 + 2_000),
    { kind: 'thinking', text: '接着想…' } as PersistedAgentEvent,
  ];
  const live = (nowMs: number): number | null =>
    segOf(shellOf({ events, runStatus: 'running', startedAtMs: T0, nowMs }), '复刻列表页')!.elapsedMs;

  it('这条还在跑:耗时随虚拟时钟递增,不冻在最后一个带时刻的事件上', () => {
    expect(live(T0 + 30_000)).toBe(30_000);
    expect(live(T0 + 90_000)).toBe(90_000);
  });

  it('还没开工的那几条不编造耗时', () => {
    const seg = segOf(shellOf({ events, runStatus: 'running', startedAtMs: T0, nowMs: T0 + 30_000 }), '抽出商品卡');
    expect(seg?.elapsedMs).toBeNull();
  });
});

/**
 * ── 终态切换不许回退 ──────────────────────────────────────────────────
 *
 * 实时值和结算值必须从**同一个表达式**推:`终点 − 起点`,只有终点从哪来不同。
 * 一旦两边各用一套算法,切换那一帧就会**塌**:进行中报的是「到现在为止」,
 * 结算报的却是「到最后一个带时刻的事件为止」——「跑了 1m 2s」当场变成「2.0s」。
 * 下面几条把两边钉在同一个终点上。
 */
describe('终态切换不回退', () => {
  it('进行中的那条 todo:轮次收尾时结算到**同一个终点**,不塌回最后一次调用', () => {
    // 这条 todo 名下只有一次很短的调用,之后是 60 秒纯推理(推理不带时刻)
    const events: PersistedAgentEvent[] = [
      todoWrite('p1', [['复刻列表页', 'in_progress']], T0),
      ...call('t1', T0, T0 + 2_000),
      { kind: 'thinking', text: '想了很久…' } as PersistedAgentEvent,
    ];
    const running = segOf(shellOf({
      events, runStatus: 'running', startedAtMs: T0, nowMs: T0 + 62_000,
    }), '复刻列表页')!.elapsedMs;
    const settled = segOf(shellOf({
      events, runStatus: 'succeeded', startedAtMs: T0, endedAtMs: T0 + 62_000,
    }), '复刻列表页')!.elapsedMs;

    expect(running).toBe(62_000);
    // 塌回 2_000 就是「1m 2s → 2.0s」那一跳
    expect(settled).toBe(62_000);
    expect(settled!).toBeGreaterThanOrEqual(running!);
  });

  it('还在想的那一段:同一份录制,`nowMs` 与 `endedAtMs` 落在同一刻就是同一个数', () => {
    const events: PersistedAgentEvent[] = [
      ...call('t1', T0, T0 + 2_000),
      { kind: 'thinking', text: '想了很久…' } as PersistedAgentEvent,
    ];
    const running = thoughtsIn(shellOf({
      events, runStatus: 'running', startedAtMs: T0, nowMs: T0 + 62_000,
    }), true).slice(-1)[0]!.elapsedMs;
    const settled = thoughtsIn(shellOf({
      events, runStatus: 'succeeded', startedAtMs: T0, endedAtMs: T0 + 62_000,
    })).slice(-1)[0]!.elapsedMs;
    expect(running).toBe(60_000);
    expect(settled).toBe(60_000);
  });

  it('工具行结算之后只认结算值 —— `nowMs` 再往前走,数字也不再动', () => {
    const events = call('t1', T0, T0 + 18_000);
    const at = (nowMs: number): number | null =>
      toolsIn(shellOf({ events, runStatus: 'running', startedAtMs: T0, nowMs }))[0]!.elapsedMs;
    expect(at(T0 + 20_000)).toBe(18_000);
    // 秒表不许在跑完的行上继续跳:实时终点被结算终点顶掉了
    expect(at(T0 + 90_000)).toBe(18_000);
  });

  it('`completedAt` 早于最后一次 tick:换成结算值,但**起点是同一个**,只差一个终点', () => {
    /*
     * 结果帧比最后一次 tick 晚到时,`completedAt` 会落在那次 tick **之前**。
     * 这一帧的数字确实会往回收一格,收的幅度**恰好等于两个终点的差**
     * —— 也就是结果帧的投递延迟,不会因为「两套算法」被放大。
     *
     * ⚠️ 想把这一格也彻底钉死,得给每一行记一个「已经报到过哪」的水位线,
     * 那是组件 state;而这一整个特性的前提就是零 state、零 timer(秒数全部从
     * `nowMs` 推)。所以这里钉的是**幅度**:回退不许超过两个终点之差。
     */
    const startedAt = T0;
    const lastTick = T0 + 14 * 60_000 + 22_000;
    const completedAt = T0 + 14 * 60_000 + 18_000;

    const beforeResult = toolsIn(shellOf({
      events: [pendingCall('t1', startedAt)],
      runStatus: 'running', startedAtMs: T0, nowMs: lastTick,
    }))[0]!.elapsedMs;
    const afterResult = toolsIn(shellOf({
      events: [
        pendingCall('t1', startedAt),
        { kind: 'tool_result', toolUseId: 't1', content: 'ok', isError: false, completedAt } as PersistedAgentEvent,
      ],
      runStatus: 'running', startedAtMs: T0, nowMs: lastTick + 1_000,
    }))[0]!.elapsedMs;

    expect(beforeResult).toBe(lastTick - startedAt);
    expect(afterResult).toBe(completedAt - startedAt);
    // 同一个起点、只差一个终点:回退幅度 = 终点之差,一毫秒不多
    expect(beforeResult! - afterResult!).toBe(lastTick - completedAt);
    // 反向守卫:值不许直接消失(掉回「没有数」比往回跳更糟)
    expect(afterResult).not.toBeNull();
  });
});
