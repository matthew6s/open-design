// @vitest-environment jsdom
/**
 * 执行记录里的**三档轻重**(PR #7170 的 `components.css`)。
 *
 * 稿子这一版把执行块的排版重排了一遍,原文三条:
 *   「执行计划和步骤标题统一为 13px / 500,进行中、已完成及展开/收起共用。」
 *   「步骤间的小结用 12px;开头说明保留 13px。」
 *   「开头说明沿用正文深色:浅色主题 --text-strong 为 #202020。」
 *
 * 也就是同一只壳里现在有三档:
 *   开场白    13px / 深色      —— Agent 说给你听的一整段话,要读得下来
 *   步骤标题  13px / 500       —— 链上的节点,眼睛顺着往下扫的落点
 *   小结·耗时 12px / 静音灰    —— 围着节点说的注脚
 * 之前是「步骤 600、开场白退成 muted」,主次正好反过来:一整段话被压暗、
 * 一行标题被加粗,读起来是标题在喊、正文在退。
 *
 * ⚠️ **这一族最容易改错的地方是「同一段文字有四种形态」**:它可能是壳的开场白、
 * 两步之间的小结、某条 todo 里的说明,或者干脆是一行工具调用。规则只能靠**位置**
 * 区分它们,所以这个文件分两半:
 *   前半 钉规则文本与它们之间的层叠关系(CSS Module 在 jsdom 里不参与层叠,
 *        只有把规则读出来比才照得出「祖先掉了导致层叠翻转」这类事故 ——
 *        同一副打法见 `record-cascade.test.ts` / `sandwiched-prose-rail.test.ts`)
 *   后半 拿**真实 trace**过一遍,确认规则挂的那几个位置在真数据里真的存在。
 *        只写合成 DOM 的话,规则可能一条都没命中而测试照样绿。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactElement } from 'react';
import type { PersistedAgentEvent } from '@open-design/contracts';
import { I18nProvider } from '../../../src/i18n';
import { ExecutionShell } from '../../../src/components/chat/ExecutionShell';
import { buildTurnBlocks } from '../../../src/runtime/chat/build-turn-blocks';
import type { ExecutionShell as Shell } from '../../../src/runtime/chat/contract';
import claudeShop from '../../fixtures/chat/claude-shop.turn0.json';
import codexTodo from '../../fixtures/chat/codex-todo.turn0.json';

afterEach(cleanup);

const CSS = readFileSync(
  resolve(__dirname, '../../../src/components/chat/primitives/record.module.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * 只切**顶层**逗号。`:is(.fold, .tool)` 里的逗号是参数分隔,一刀切下去会把一支
 * 选择器劈成两条假的(`sandwiched-prose-rail.test.tsx` 的注释记过同一个坑)。
 */
function splitTopLevel(head: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = '';
  for (const ch of head) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  out.push(buf);
  return out;
}

/** 一条规则的声明块 */
function declsOf(selector: string): string {
  for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const one of splitTopLevel(m[1] ?? '')) {
      if (one.replace(/\s+/g, ' ').trim() === selector) return (m[2] ?? '').replace(/\s+/g, ' ').trim();
    }
  }
  return '';
}

const STEP_SUMMARY = '.fold.flat > .body.stack > .fold > summary';
const OPENING = '.fold.flat > .body.stack > .think';
const OPENING_WITH_STEPS = '.fold.flat > .body.stack:has(> .fold) > .think';
const INTERLUDE =
  '.fold.flat:not(.hasTodo) > .body.stack > :is(.fold, .tool) ~ .think:has(~ :is(.fold, .tool))';

describe('执行记录的三档轻重', () => {
  it('步骤标题是 13px / 500,不再是继承来的 12px / 600', () => {
    const decls = declsOf(STEP_SUMMARY);
    expect(decls, `找不到规则 ${STEP_SUMMARY}`).not.toBe('');
    expect(decls).toMatch(/font-size: var\(--chat-t-body\)/);
    expect(decls).toMatch(/font-weight: 500/);
    expect(decls).not.toMatch(/font-weight: 600/);
  });

  it('耗时退到静音灰,和标题拉开一档', () => {
    const decls = declsOf(`${STEP_SUMMARY} .meta`);
    expect(decls, `找不到规则 ${STEP_SUMMARY} .meta`).not.toBe('');
    expect(decls).toMatch(/color: var\(--chat-progress-detail-ink\)/);
    expect(decls).toMatch(/font-weight: 500/);
    // 这枚墨色是这一族注脚共用的,定义挂在壳上
    expect(declsOf('.fold.flat')).toMatch(/--chat-progress-detail-ink:/);
  });

  it('开场白留在正文深色 + 13px —— 它是一整段话,不是标注', () => {
    expect(declsOf(OPENING)).toMatch(/font-size: var\(--chat-t-body\)/);
    const withSteps = declsOf(OPENING_WITH_STEPS);
    expect(withSteps, `找不到规则 ${OPENING_WITH_STEPS}`).not.toBe('');
    expect(withSteps).toMatch(/color: var\(--chat-text-strong\)/);
    // 这一条原来把开场白压成 muted,主次正好反了
    expect(withSteps).not.toMatch(/--chat-text-muted/);
  });

  it('两步之间的小结退到 12px 静音,连里面的行内代码一起', () => {
    const decls = declsOf(INTERLUDE);
    expect(decls, `找不到规则 ${INTERLUDE}`).not.toBe('');
    expect(decls).toMatch(/font-size: var\(--chat-t-mini\)/);
    expect(decls).toMatch(/color: var\(--chat-progress-detail-ink\)/);
    // `.think code` 自带 --chat-text-strong;不接管的话一段静音里会留下几个黑块
    expect(declsOf(`${INTERLUDE} code`)).toMatch(/color: inherit/);
  });

  it('小结那条比开场白那条**更特指** —— 否则 13px 会盖回 12px', () => {
    /*
     * 两条都命中同一段 `.think`,分档全靠特异性。数的是(类 + 伪类 + 属性)那一档:
     * `:is()` / `:has()` 在真浏览器里按参数里最重的一支算,这里两条的参数都是纯类,
     * 所以逐个数就够用了 —— 要的是「严格大于」,平手会退化成按源码顺序判。
     */
    const weigh = (s: string): number =>
      (s.match(/\.[A-Za-z0-9_-]+|\[[^\]]+\]|:[a-z-]+/g) ?? []).length;
    expect(weigh(INTERLUDE)).toBeGreaterThan(weigh(OPENING));
  });
});

describe('真实 trace:规则挂的那几个位置确实存在', () => {
  const shellOf = (fixture: { runStatus?: string; events: unknown[] }): Shell => {
    const blocks = buildTurnBlocks({
      events: fixture.events as PersistedAgentEvent[],
      runStatus: fixture.runStatus as 'succeeded' | 'failed' | 'canceled' | 'running' | undefined,
    });
    const shell = blocks.find((b): b is Shell => b.kind === 'shell');
    if (!shell) throw new Error('这份 trace 没有执行壳');
    return shell;
  };
  const show = (shell: Shell): ReactElement => (
    <I18nProvider initial="zh-CN">
      <ExecutionShell shell={shell} deferCollapsedBodies={false} />
    </I18nProvider>
  );
  const shellBody = (root: HTMLElement): HTMLElement => {
    for (const d of Array.from(root.querySelectorAll('details'))) d.open = true;
    const body = root.querySelector<HTMLElement>('details[class*="flat"] > div[class*="body"]');
    if (!body) throw new Error('壳 body 没渲染出来');
    return body;
  };

  it('claude 的真实一轮:开场白是壳 body 的直接子代,后面跟着工具行', () => {
    const { container } = render(show(shellOf(claudeShop)));
    const body = shellBody(container);
    const kids = Array.from(body.children);
    // 开场白 = 壳 body 的第一个 `.think`
    const first = kids[0];
    expect(first, '壳 body 是空的').toBeTruthy();
    expect(first!.className).toMatch(/think/);
    // 后面确实还有别的行 —— 否则「开场白 / 步骤」这组关系根本不成立
    expect(kids.length).toBeGreaterThan(1);
    expect(kids.slice(1).some((el) => /tool/.test(el.className) || el.tagName === 'DETAILS')).toBe(true);
  });

  it('codex 的真实一轮:开场白和可折叠步骤同时在,`:has(> .fold)` 那条真会命中', () => {
    const { container } = render(show(shellOf(codexTodo)));
    const body = shellBody(container);
    const kids = Array.from(body.children);
    expect(kids.some((el) => /think/.test(el.className))).toBe(true);
    // `:has(> .fold)` 要求壳 body **直接**挂着一个 details.fold
    expect(body.querySelector(':scope > details')).not.toBeNull();
    // 步骤标题这一档就是 `> .fold > summary`,耗时挂在它里面
    expect(body.querySelector(':scope > details > summary')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-foldable-elapsed"]')).not.toBeNull();
  });

  /*
   * 「夹在两步中间的小结」在现有六份 trace 里一次都没出现(逐份数过:claude 那轮
   * 正文只有开头一段,codex / amr 那几轮的正文都落在 todo 里)。所以这一档的 DOM 形态
   * 由 `sandwiched-prose-rail.test.tsx` 用合成壳钉,这里只钉规则本身(上半场那条),
   * **不假装真数据里有**。哪天补进一份带小结的 trace,把它加到这里。
   */
});
