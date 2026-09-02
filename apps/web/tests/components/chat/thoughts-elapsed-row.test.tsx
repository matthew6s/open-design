// @vitest-environment jsdom
/**
 * **想完了的那一格思考,右边挂自己的耗时;正在想的那一格不挂。**
 *
 * 用户 2026-08-27 真机指认:「thought 是不是本身右边也要显示一个耗时?
 * 为啥 todo 外的一个耗时都没显示?」「todo 内的倒是每个工具调用都有耗时,
 * thought 也要有耗时」。
 *
 * `ThoughtsRow` 原来的注释写着「不挂耗时:推理的时长在壳头的总耗时里」——
 * 那句话的**前提是假的**:壳头的跨度只由带时刻的事件撑开,第一个工具之前的推理
 * 根本不在里面(见 `runtime/chat/shell-elapsed-includes-thinking.test.ts`)。
 *
 * ⚠️ **「正在想不挂」那一半 2026-09-02 被产品推翻了**(有意偏离设计稿)。
 * 稿子的理由是「这一行只活到第一个字落地为止」,而那个前提对推理模型不成立:
 * 真实数据里有单轮思考 28.5 分钟的案例(诊断包 run `3fc3b3ae`),用户的实感是
 * 「跑了 40 分钟什么都没出来」。产品原话:「为啥思考中不会有计时?我感觉
 * **进行中的 toolrow 都得有计时**吧?」完整因果与三类行的守卫在
 * `tests/components/chat/live-row-elapsed.test.tsx`;这个文件只留「想完了那一格」
 * 这一半,以及「拿不到就不编数」那条纪律。
 *
 * ⚠️ 两个用例的**数据完全一样**,只有「在不在想」这一位不同 ——
 * 否则「显示了」这条断言可以靠挂一个常量蒙混过去。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { I18nProvider } from '../../../src/i18n';
import { ExecutionShell } from '../../../src/components/chat/ExecutionShell';
import type { ExecutionShell as Shell, ShellItem } from '../../../src/runtime/chat/contract';

afterEach(cleanup);

/** 一段跑完的推理 —— 带着 `build-turn-blocks` 算出来的耗时 */
const thought = (text: string, elapsedMs: number): ShellItem => ({
  kind: 'text', text, thinking: true, elapsedMs,
});

function show(over: Partial<Shell>): HTMLElement {
  const shell = {
    kind: 'shell', id: 'shell-1', status: 'done', items: [], segments: [],
    thinking: false, stopped: false, elapsedMs: 371_631, quietMs: null,
    ...over,
  } as unknown as Shell;
  return render(
    <I18nProvider initial="zh-CN">
      <ExecutionShell shell={shell} deferCollapsedBodies={false} />
    </I18nProvider>,
  ).container;
}

describe('思考那一格的耗时(设计稿组件 3 · 用户 2026-08-27 裁决)', () => {
  it('想完了:右边写着这一格自己的耗时', () => {
    const root = show({ items: [thought('先想清楚要动哪几个文件。', 154_000)] });
    expect(root.textContent).toContain('2m 34s');
  });

  it('**正在想**:同一份数据,同样写出来(产品 2026-09-02 推翻了稿子那一条)', () => {
    const root = show({
      status: 'running',
      thinking: true,
      items: [thought('先想清楚要动哪几个文件。', 154_000)],
    });
    expect(root.textContent).toContain('思考中');
    expect(root.textContent).toContain('2m 34s');
  });

  it('同一摞里两格并存:两格**各报各的**,不是共用一个数', () => {
    const root = show({
      status: 'running',
      thinking: true,
      items: [
        thought('第一段想完了。', 5_400),
        {
          kind: 'tool', id: 't1', tool: 'read', name: 'Read',
          title: 'Read', rawTitle: false,
          file: { path: 'index.html', label: 'index.html' },
          pattern: null, hits: null, delta: null, elapsedMs: 300,
          failed: false, failReason: null, command: null, terminal: null,
        } as ShellItem,
        thought('第二段还在想。', 8_900),
      ],
    });
    expect(root.textContent).toContain('5.4s');
    expect(root.textContent).toContain('8.9s');
  });

  it('拿不到耗时的那一格什么都不写 —— 不用 `0.0s` 顶上', () => {
    const root = show({
      items: [{ kind: 'text', text: '这一段算不出耗时。', thinking: true } as ShellItem],
    });
    expect(root.textContent).toContain('这一段算不出耗时。');
    expect(root.textContent).not.toContain('0.0s');
  });
});
