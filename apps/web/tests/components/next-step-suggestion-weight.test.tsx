// @vitest-environment jsdom
/**
 * OPEND-2558「next step 视觉重心加强」—— 下一步建议行的字重。
 *
 * 最新设计基准 PR #7170 @ `8015870` 的 `.nexts button` 写的是:
 *
 *   .nexts button {
 *     display:flex; align-items:center; gap:8px; width:100%;
 *     padding: 9px 11px; border:none; background:none;
 *     font-size: var(--t-mini); font-weight: 500; color: var(--text); text-align:left;
 *   }
 *
 * 我们这一档其余度量早已 1:1(内距、间隙、字号、hover 换底、箭头 12px),
 * **只差 `font-weight: 500`** —— 三行建议现在继承 400,和它们上面那段正文
 * 一样轻,整块在收尾处压不住。这一条就是补这一档。
 *
 * ## 为什么这么测
 *
 * jsdom 跑层叠但不解析 `var()`,而字重恰好是个**裸数值**,层叠算得出来。
 * 所以把 CSS Module 文件当普通样式表注入(文件里的选择器是未哈希的原名),
 * 用稿子的 DOM 形状挂上去,直接问最终计算值。真实像素另有无头 Chrome 量;
 * 这一层要挡的是「补了一条规则,却被同文件后面某处覆盖掉」。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const MODULE_CSS = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../src/components/NextStepActions.module.css',
  ),
  'utf-8',
);

/** 稿子的形状:外层无框容器 → 三条建议行,每行一枚箭头 + 一句话。 */
const SUGGESTIONS = `
  <div class="root">
    <div class="suggestions">
      <button type="button" class="suggestionRow" id="row-0">
        <svg viewBox="0 0 24 24"></svg><span class="suggestionText">再加一页订单列表</span>
      </button>
      <button type="button" class="suggestionRow" id="row-1">
        <svg viewBox="0 0 24 24"></svg><span class="suggestionText">把商品卡换成两列布局</span>
      </button>
      <button type="button" class="suggestionRow" id="row-2">
        <svg viewBox="0 0 24 24"></svg><span class="suggestionText">补一套深色模式</span>
      </button>
    </div>
  </div>`;

beforeAll(() => {
  const style = document.createElement('style');
  style.textContent = MODULE_CSS;
  document.head.appendChild(style);
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('下一步建议行的视觉重心(OPEND-2558)', () => {
  it('每一行都落在稿子的 medium(500),不是继承来的 400', () => {
    document.body.innerHTML = SUGGESTIONS;
    for (const id of ['row-0', 'row-1', 'row-2']) {
      const row = document.getElementById(id)!;
      expect(getComputedStyle(row).fontWeight).toBe('500');
    }
  });

  /*
   * 加重是**一档**,不是往上顶到标题那一档。这一块自己的标题行(`.label`,
   * 稿子里没有、是我们多出来的)是 600;建议行必须停在它下面,否则收尾处会
   * 冒出第二个标题级重量,跟刚交付的产物卡抢注意力 —— 而稿子对这一块的原话
   * 是「不画框、不画分割线……静止时不显形」。
   */
  it('只加一档,不越过这一块自己的标题行', () => {
    document.body.innerHTML = `<div class="root"><div class="label" id="label">标题</div>${SUGGESTIONS}</div>`;
    const row = document.getElementById('row-0')!;
    const label = document.getElementById('label')!;
    expect(Number(getComputedStyle(row).fontWeight)).toBeLessThan(
      Number(getComputedStyle(label).fontWeight),
    );
  });
});
