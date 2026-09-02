// @vitest-environment jsdom
/**
 * OPEND-2417:**那条竖直的灰色轨道线不许压在状态标记上。**
 *
 * 用户原话:「2417 这个好像主要问题是我们的竖的灰线,有时候会覆盖到绿色带勾号的 icon 上,
 * 发生重叠了」。绿色带勾的那枚就是 `StatusMark status="ok"`(`.mark.ok`),
 * 执行记录里每条做完的 todo / 执行计划的行首都是它。
 *
 * ── 「有时候」是哪时候 ──────────────────────────────────────────────
 *
 * 线的起点写死在 `top: 25px`(照抄稿子),而标记是**居中**摆的
 * (`.fold > summary { align-items: center }`)。于是标记的下边缘跟着**行高**走:
 *
 *   一行的行:内容盒 13 × 1.5 = 19.5 → 标记 top = 5 + (19.5 − 15) / 2 = 7.25,底 22.25
 *             25 > 22.25,让开了 2.75px —— 看着没事
 *   两行的行:内容盒 39        → 标记 top = 5 + (39 − 15) / 2 = 17,   底 32
 *             25 < 32,**线压进标记 7px** —— 用户看到的就是这一下
 *
 * 所以它不是「偶发」,是**行一旦高过一行就必然发生**。而且这个余量还在被动地变薄:
 * 本轮把步骤标题从 12px 提到 13px(PR #7170 的排版),一行的余量就从 3.5px 掉到 2.75px。
 * 稿子那句话说得很清楚:「线不是被点盖住,是**让位给点**」——25 这个数是让位的结果,
 * 不是让位的原因,把结果写死,原因一变它就不成立了。
 *
 * ── 修法 ────────────────────────────────────────────────────────────
 *
 * 两条一起,少一条都还会漂:
 *  ① 标记**不再居中**,改成贴行首 + 一枚常量微调(`align-self: flex-start` +
 *     `margin-top`)。稿子的计划卡本来就是这么写的:`.steps li .tk { margin-top: 1.5px }`
 *     —— 1.5 正好等于 12/1.5 那一行的居中偏移 `(18 − 15) / 2`,但它是**常量**,
 *     行变高时点不跟着往下走。于是标记的盒子不再是行高的函数。
 *  ② 线的起点由**同一组数**算出来,不再写 25:
 *     `行内边距 + 标记微调 + 标记边长 + 气口`。单行时仍然等于 25(视觉零变化),
 *     但从此不可能和标记错身。
 *
 * ⚠️ jsdom 不做布局,量不到真实像素。这里做的是**对声明值做算术** ——
 *    比「规则存在」强,比真机量弱。真机复验记在交付说明里。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CSS = readFileSync(
  resolve(__dirname, '../../../src/components/chat/primitives/record.module.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

/** 只切顶层逗号:`:is(.fold, .tool)` 里的逗号是参数分隔 */
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

function declsOf(selector: string): string {
  for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const one of splitTopLevel(m[1] ?? '')) {
      if (one.replace(/\s+/g, ' ').trim() === selector) return (m[2] ?? '').replace(/\s+/g, ' ').trim();
    }
  }
  return '';
}

/** 找到那条画轨道线的规则(选择器很长,按声明特征找更稳) */
function railDecls(): string {
  for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const head = (m[1] ?? '').replace(/\s+/g, ' ');
    const body = (m[2] ?? '').replace(/\s+/g, ' ').trim();
    if (!head.includes('::before')) continue;
    if (!/\.body\.stack >/.test(head)) continue;
    if (!/width: 1px/.test(body) || !/top:/.test(body)) continue;
    return body;
  }
  return '';
}

/** 从 `:root` 之外的规则里取一枚自定义属性的字面值(px) */
function pxVar(selector: string, name: string): number {
  const hit = new RegExp(`${name}:\\s*([0-9.]+)px`).exec(declsOf(selector));
  return hit ? Number.parseFloat(hit[1]!) : Number.NaN;
}

const MARK = declsOf('.mark');
const ROW = '.fold.flat > .body.stack';

describe('OPEND-2417 轨道线让位给状态标记', () => {
  it('标记贴行首摆,盒子不再是行高的函数', () => {
    /*
     * 反向对照的靶子就是「居中」:`align-items: center` 会让标记随行高下移,
     * 这正是两行的行上线压过来的原因。
     */
    expect(MARK, '找不到 .mark 规则').not.toBe('');
    expect(MARK).toMatch(/align-self: flex-start/);
    expect(MARK).toMatch(/margin-top:/);
  });

  it('线的起点是算出来的,不是写死的 25px', () => {
    const rail = railDecls();
    expect(rail, '找不到画轨道线那条规则').not.toBe('');
    expect(rail).toMatch(/top: calc\(/);
    // 写死的长度会随字号 / 行高 / 内边距任何一处改动而失配
    expect(rail).not.toMatch(/top: 25px/);
    // 必须吃和标记同一组数,否则「算出来的」也只是换个地方写死
    expect(rail).toMatch(/--row-slot/);
  });

  it('算术:单行和两行的行,线都落在标记下边缘之下', () => {
    const padBlock = pxVar(ROW, '--row-pad-block');
    const slot = pxVar(ROW, '--row-slot');
    const gap = pxVar(ROW, '--chain-gap');
    const nudge = Number.parseFloat(/margin-top:\s*([0-9.]+)px/.exec(MARK)?.[1] ?? 'NaN');
    for (const [name, value] of Object.entries({ padBlock, slot, gap, nudge })) {
      expect(Number.isFinite(value), `${name} 没定义或不是 px`).toBe(true);
    }

    // 标记贴行首:盒子和行高无关
    const markBottom = padBlock + nudge + slot;
    const railTop = padBlock + nudge + slot + gap;
    expect(railTop).toBeGreaterThan(markBottom);

    /*
     * 正向对照:单行时这套算式必须仍然等于稿子那个 25 —— 修的是漂移,不是外观。
     * (5 + 1.5 + 15 + 3.5 = 25)
     */
    expect(railTop).toBe(25);

    /*
     * 关键的那一档:行长到两行。居中摆法下标记底会掉到
     * `padBlock + (2 × 19.5 − 15) / 2 + 15 = 32`,把 25 的线压在身上;
     * 贴行首之后标记底恒为 21.5,线仍在它下面。
     */
    const centeredMarkBottomTwoLines = padBlock + (2 * 19.5 - slot) / 2 + slot;
    expect(centeredMarkBottomTwoLines).toBeGreaterThan(25);   // 旧摆法确实会撞
    expect(railTop).toBeGreaterThan(markBottom);              // 新摆法不会
  });
});
