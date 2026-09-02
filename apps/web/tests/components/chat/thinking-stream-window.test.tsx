// @vitest-environment jsdom
/**
 * 思考正文**和外面的普通正文一样**:自然高度、随内容长,不裁剪、不自动滚、不渐隐。
 *
 * ⚠️ 这条**推翻了设计稿**(2026-09-02 产品 + 设计线下裁决)。稿子的
 * `thinking-stream.css` / `.js` 画的是一扇 96px 定高、自己往上走、上下渐隐的窗;
 * 用户原话:
 *   「先不要这个滚动的了,这里文本就和外面普通文本一样有个流式的效果就行,
 *     不要这个滚动效果了,**滚动太慢了,也很难看清**」
 * 「很难看清」指的就是那两道渐隐 —— 窗口上下各 32px 把首尾两行淡到读不出来,
 * 而那两行恰恰是刚落下的字。
 *
 * 于是这一格现在只剩两件事:
 *   · 一只灰底容器(用户没说要去掉,截图里就是它)
 *   · 逐字化开的流式效果 —— 走**和普通正文同一套** `useCharReveal`,不另造一份
 *
 * 这个文件的正反两面都要钉,因为「去掉」比「加上」更容易假绿:
 *   正:灰底容器还在、推理直接躺在它上面、逐字效果还在
 *   反:没有定高、没有遮罩、没有中间那层滚动视口、没有自动滚的生命周期
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactElement } from 'react';
import { I18nProvider } from '../../../src/i18n';
import { ExecutionShell } from '../../../src/components/chat/ExecutionShell';
import type { ExecutionShell as Shell, ShellItem } from '../../../src/runtime/chat/contract';

afterEach(cleanup);

const SRC = resolve(__dirname, '../../../src/components/chat');
/* 注释里有成对的花括号(这份文件到处引用稿子的规则原文),不先剥掉就切不开规则 */
const CSS = readFileSync(resolve(SRC, 'primitives/record.module.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** 取出一条规则的声明块。选择器按「逗号段完全相等」匹配 */
function declsOf(selector: string): string {
  for (const block of CSS.split('}')) {
    const [head, body] = block.split('{');
    if (head == null || body == null) continue;
    const parts = head.split(',').map((s) => s.replace(/\s+/g, ' ').trim());
    if (parts.includes(selector)) return body;
  }
  return '';
}

const think = (text: string): ShellItem => ({ kind: 'text', text, thinking: true });
function shellOf(items: ShellItem[], over: Partial<Shell> = {}): Shell {
  return {
    kind: 'shell', seq: 0, status: 'done', items, segments: [],
    thinking: false, stopped: false, elapsedMs: null, quietMs: null, ...over,
  } as Shell;
}
const show = (shell: Shell): ReactElement => (
  <I18nProvider initial="zh-CN"><ExecutionShell shell={shell} /></I18nProvider>
);
const thoughtsBody = (root: HTMLElement): HTMLElement | null =>
  root.querySelector('details[class*="thoughts"] > div[class*="body"]');
/** 跑完的壳是收起的,里面的思考格要等壳开了才挂上来 —— 两步,顺序不能并成一次查询 */
const openShellThenThoughts = (root: HTMLElement): void => {
  const shell = root.querySelector('details[class*="flat"] > summary');
  if (shell) fireEvent.click(shell);
  const thoughts = root.querySelector('details[class*="thoughts"] > summary');
  if (thoughts) fireEvent.click(thoughts);
};

const LONG = Array.from({ length: 14 }, (_, i) => `第 ${i + 1} 段推理。`).join('\n\n');

describe('还在想的那一格:一只灰底容器,里面是普通正文', () => {
  it('推理直接躺在灰底上,中间没有滚动视口那一层', () => {
    const { container } = render(show(shellOf([think(LONG)], { status: 'running', thinking: true })));
    const body = thoughtsBody(container);
    // 正向对照:这一格真渲染了(少了它,下面的结构断言在组件没画时也会「通过」)
    expect(body?.textContent).toContain('第 14 段推理');
    expect(body?.className).toMatch(/stream/);

    // 反:那层视口没了
    expect(body!.querySelector('[data-testid="thinking-stream-viewport"]')).toBeNull();
    // 正:推理是灰底容器的直接孩子
    const markdown = body!.querySelector('[data-testid="thinking-markdown"]');
    expect(markdown).not.toBeNull();
    expect(markdown!.parentElement).toBe(body);
  });

  it('流式效果还在,而且走的是普通正文那一套', () => {
    const { container } = render(show(shellOf([think('一段推理。')], { status: 'running', thinking: true })));
    // `useCharReveal` 把逐字 span 铺在 `ThinkingMarkdown` 的根上;和普通正文同一只 hook
    const markdown = container.querySelector('[data-testid="thinking-markdown"]');
    expect(markdown).not.toBeNull();
    expect(markdown!.textContent).toContain('一段推理');
  });

  it('灰底容器留着:圆角 + 四边留白 + 上下气口', () => {
    const decls = declsOf('.stream');
    expect(decls, '找不到 .stream 规则').not.toBe('');
    expect(decls).toMatch(/background:/);
    expect(decls).toMatch(/border-radius:/);
    expect(decls).toMatch(/padding: var\(--stream-pad\)/);
    expect(decls).toMatch(/margin-block: var\(--stream-gap\)/);
  });

  it('自然高度:不定高、不裁剪、不遮罩', () => {
    const decls = declsOf('.stream');
    expect(decls).not.toMatch(/height:/);
    expect(decls).not.toMatch(/overflow: hidden/);
    expect(decls).not.toMatch(/mask-image/);
    // 中间那层视口的规则也不该再有
    expect(declsOf('.streamViewport')).toBe('');
    // 整份样式表里不许再留下那两道渐隐
    expect(CSS).not.toMatch(/--stream-fade/);
  });

  it('自动滚那套生命周期整个删掉,不留死代码', () => {
    expect(existsSync(resolve(SRC, 'primitives/useThinkingStream.ts'))).toBe(false);
    const shellSrc = readFileSync(resolve(SRC, 'ExecutionShell.tsx'), 'utf8');
    expect(shellSrc).not.toMatch(/useThinkingStream/);
  });

  it('反向对照:想完了那一档仍然是「点开来读」的限高滚动,不受这条裁决影响', () => {
    const { container } = render(show(shellOf([think(LONG)], { status: 'done' })));
    openShellThenThoughts(container);
    const body = thoughtsBody(container);
    expect(body?.textContent).toContain('第 14 段推理');
    expect(body?.className).toMatch(/scroll/);
    expect(body?.className).not.toMatch(/stream/);
  });
});
