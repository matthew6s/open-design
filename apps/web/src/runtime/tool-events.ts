import type { AgentEvent } from '../types';

import { isSnapshotTool } from './chat/tool-kind';

/**
 * 同一次 `tool_use` 被送两遍时只留第一条 —— SSE 重放会这样。
 *
 * **快照型工具除外**(`isSnapshotTool`):它们每次调用都是把整份状态替换一遍,
 * 有的 agent 干脆把「计划」建模成一个反复改写的条目,五次推进共用同一个 tool id。
 * 按 id 去重会把除第一次以外的状态推进全部丢掉 —— 真机撞到过:一轮跑完了,
 * 四条 todo 还全是虚线圈的「未开始」,第一条同时挂着 35.1s 的耗时和「未开始」的记号。
 * 重复的快照多留一份没有代价:落块是原地更新,同一份状态应用两次结果一样。
 */
export function dedupeToolUsesById(events: AgentEvent[] | undefined): AgentEvent[] {
  if (!events || events.length === 0) return [];

  const seen = new Set<string>();
  let deduped: AgentEvent[] | null = null;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!;
    if (event.kind === 'tool_use' && !isSnapshotTool(event.name)) {
      if (seen.has(event.id)) {
        if (!deduped) deduped = events.slice(0, i);
        continue;
      }
      seen.add(event.id);
    }
    if (deduped) deduped.push(event);
  }

  return deduped ?? events;
}

/**
 * 「入参还在传」的那一档写文件调用,在 `input` 上带的记号。
 *
 * daemon 在路径刚够完整时发一条 `tool_input_target`(几十字节,原始入参一个字节
 * 都不出 daemon);`providers/daemon.ts` 把它翻成**同一次调用的早期形态** ——
 * 一个只带 `file_path` 的 `tool_use`。这样动词、图标、文件名按钮全部复用已有的
 * `buildToolRow` / `ToolRow`,不新增文案 key,也不新增渲染分支:提前那一行长得
 * 就是最终那一行**减去** `+N −M`(那个要 `content` 才算得出来)。
 *
 * 记号放在 `input` 里而不是事件顶层,是因为 `input` 是 `unknown` ——
 * 早期形态因此是一个**合法的** `tool_use`,不用把 `PersistedAgentEvent` 撑宽成
 * 一个「落了库就不成立」的形状。它也从来不落库(daemon 那边
 * `runSseEventToPersistedAgentEvent` 直接丢掉 `tool_input_target`)。
 */
export const IN_FLIGHT_TOOL_INPUT_MARKER = 'od_input_streaming';

/** 这条 `tool_use` 是不是「入参还没传完」的早期形态。 */
export function isInFlightToolUse(event: AgentEvent): boolean {
  if (event.kind !== 'tool_use') return false;
  const input = event.input;
  return (
    typeof input === 'object' &&
    input !== null &&
    (input as Record<string, unknown>)[IN_FLIGHT_TOOL_INPUT_MARKER] === true
  );
}

/**
 * 真的 `tool_use` 一到,就把同一个 id 的早期形态丢掉。
 *
 * 必须跑在 `dedupeToolUsesById` **之前**:那个函数按 id 留**第一条**,早期形态
 * 排在前面,不先摘掉的话真货会被它顶掉 —— 于是 `+N −M` 永久消失,
 * 所有读 `input.content` 的下游也永远只看得到那份没有正文的入参。
 *
 * 摘干净之后「先显示一个、后变成另一个」不可能发生:daemon 保证早期那个 `path`
 * 就是最终的 `file_path`,而且一次调用只剩一条事件,也就只画一行。
 */
export function dropSupersededInFlightToolUses(events: AgentEvent[] | undefined): AgentEvent[] {
  if (!events || events.length === 0) return [];

  let sawInFlight = false;
  const settledIds = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'tool_use') continue;
    if (isInFlightToolUse(event)) sawInFlight = true;
    else settledIds.add(event.id);
  }
  if (!sawInFlight) return events;

  const kept = events.filter(
    (event) => !(isInFlightToolUse(event) && settledIds.has((event as { id: string }).id)),
  );
  return kept.length === events.length ? events : kept;
}
