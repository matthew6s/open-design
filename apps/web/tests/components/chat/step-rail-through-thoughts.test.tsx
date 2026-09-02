// @vitest-environment jsdom
/**
 * N8:**壳里只有两套列,链穿过顶层的每一格**。
 *
 * ── 用户当天两条(逐字)────────────────────────────────────────
 *
 * ① 指着一张跑完的壳:「这里衔接咋是这样的?」——线沿着上面那条命令步骤的正文走下来,
 *    走到「思考过程」那一格断掉,下面的步骤再重新起一条。
 * ② 指着顶层 Thoughts 左边那个空槽:「这里不是说要动态判断间距吗? 像这里如果是
 *    todo 外面, 不应该有这个缩进? todo 外面的工具调用应该也没这个缩进吧?」
 *
 * **两条是同一个病**:顶层的工具行 / 思考那一格被缩进了 22px,而链的 x 又是照
 * 「顶层贴左」写死的 14.5px —— 于是它们既比邻居右了一格,又接不上那条线。
 *
 * ── 去交付稿里核过的三件事(真 Chrome,`docs/design/chat-panel-next.html`,md5 28ea4c65…)──
 *
 * 1. 稿子里有没有「壳里没有清单、工具行直接平铺」的格子?**没有。**
 *    把整份稿子放进 Chrome 数过:`.fold.mod-flat > .body.mod-stack > .tool` 命中 **0 处**。
 *    组件 9 / 10 / 11 / 12 那几格单独演示工具行时,外面照样套着一层
 *    `details.fold`(带 `.mk` 状态点的**步骤**),工具行住在它里面。
 * 2. 顶层和步骤里面是不是两套列?**是。** 逐行量到:
 *    顶层 `details.fold` 的 `.mk` 落 **0**(宽 15)、步骤名落 22;
 *    步骤**里面**的子行(`.tool` 的图标、`.pk` 的序号、嵌一层的折叠头)一律落 **22**。
 * 3. 那 22px 从哪来?稿子原话:「缩进一格(**状态点 15 + 间距 7 = 22**)」——
 *    让开步骤自己那颗状态点。所以它是「**步骤里面**」的列,不是「工具行」的列;
 *    顶层没有那颗要让的点,自然不该占这一格。
 *
 * 我们的壳头永远是「进行中 / 已完成」,从来不是一个步骤 —— 顶层的工具行 / 思考
 * 没有「谁的子项」可言,它们就是链上的一格,该和步骤同列。
 *
 * ── 这个文件钉四件事 ────────────────────────────────────────
 *
 * N8-a 顶层三种 DOM(步骤 / `div.tool` / 思考)同一列,链一格都不落下
 * N8-b 线的 x **按各行自己的缩进算**,不再一处写 14.5、另一处写 7.5
 * N8-c 顶层和清单抽屉里是**两套**列,各自内部一致(反向对照:两个值不相等)
 * N8-d 选择器真的能命中:壳里确实是这个 DOM
 *
 * jsdom 不做布局,几何**不在这里量**;真机数字在 Chrome 里量,记在
 * `specs/current/chat-panel-feedback.md` §F-18(含 harness 与逐行表)。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { I18nProvider } from '../../../src/i18n';
import { ExecutionShell } from '../../../src/components/chat/ExecutionShell';
import type { ExecutionShell as Shell, ShellItem } from '../../../src/runtime/chat/contract';

afterEach(cleanup);

const CSS = readFileSync(
  resolve(__dirname, '../../../src/components/chat/primitives/record.module.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');   // 注释里有逗号和选择器样子的文字,先剥掉

/**
 * 只切**顶层**逗号。`:is(.fold, .tool)` / `:has(~ :is(.a, .b))` 里面的逗号是参数分隔,
 * 一刀切下去会把一支选择器劈成两条假的(`sandwiched-prose-rail.test.tsx` 里踩过)。
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

interface Rule { selector: string; body: string }

const RULES: Rule[] = CSS.split('}').flatMap((block) => {
  const [head, body] = block.split('{');
  if (head == null || body == null) return [];
  return splitTopLevel(head)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((selector) => ({ selector, body }));
});

/** 某条规则里某个属性的值(取最后一次赋值,和层叠一致) */
function declOf(selector: string, prop: string): string | null {
  let found: string | null = null;
  for (const rule of RULES) {
    if (rule.selector !== selector) continue;
    const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(rule.body);
    if (m?.[1]) found = m[1].trim();
  }
  return found;
}

const valueOf = (rule: Rule, prop: string): string | null => {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(rule.body);
  return m?.[1]?.trim() ?? null;
};

/** 一条规则画的是不是「那条链」:1px 宽、描边色的绝对定位伪元素 */
const isRail = (rule: Rule): boolean => rule.selector.endsWith('::before')
  && /width:\s*1px/.test(rule.body)
  && /background:\s*var\(--chat-border\)/.test(rule.body);

const railRules = RULES.filter(isRail);
/** 链上那一格自己画的那一段(不含夹心正文补的那一段) */
const rowRails = railRules.filter((r) => !r.selector.includes('.think:has('));
const proseRails = railRules.filter((r) => r.selector.includes('.think:has('));

const px = (v: string | null): number => Number.parseFloat(v ?? 'NaN');

/* ── N8-a 顶层每一格都在链上 ────────────────────────────────── */

describe('N8-a 顶层三种 DOM 同一列,链一格都不落下', () => {
  /*
   * ⚠️ **2026-09-02 换判据。** 这一条原来钉的是「链认两种 DOM」——
   * `:is(.fold, .tool)`,把顶层每一格都算成链上的一格。
   * 用户当天指认:顶层的思考左边挂着一条线、整块往右缩了一格,而它排在清单**之前**,
   * 根本不在任何一步里面。原话:「如果是在 todo 外的 toolrow 或者普通文本,或者
   * thinking,不要有任何的缩进了,也不要这个竖着的灰线」。
   * 链因此收回**步骤那一层**:`ExecutionShell` 给 todo / plan 那两种 `Foldable` 挂
   * `stepRow`,CSS 只认它。判据是正面的 —— 以后新增块型默认不在链上。
   */
  it('链的选择器只认**步骤**这一层', () => {
    expect(rowRails.length).toBeGreaterThan(0);               // 正向对照:规则找得到
    for (const rule of rowRails) expect(rule.selector).toMatch(/\.stepRow/);
    // 旧口径不许回来:工具行 / 思考 / 正文都不是一步
    for (const rule of rowRails) expect(rule.selector).not.toMatch(/:is\(\.fold, ?\.tool\)/);
  });

  it('思考那一格**没有被排除**在链外', () => {
    /*
     * 2026-08-27 早些时候这里挂过 `:not(.thoughts)`,链就断在那一格 ——
     * 用户截图指的就是它。推翻的完整理由写在
     * `thinking-embedded.test.tsx` 的「思考那一格**在**步骤链上」那条里。
     */
    for (const rule of railRules) expect(rule.selector).not.toContain(':not(.thoughts)');
  });

  it('不用 `:*-of-type` 判首尾 —— 顶层混着 details 和 div,按标签数会数错', () => {
    /*
     * 稿子顶层清一色 `details`,所以 `:not(:last-of-type)` 够用;产线上顶层混着
     * `div.tool`,`of-type` 按标签各数各的 —— 一条尾随的工具行不会让前一条
     * `details` 失去 `:last-of-type`,链在那里会凭空多一截或少一截。
     */
    for (const rule of rowRails) expect(rule.selector).not.toMatch(/:(first|last)-of-type/);
    // 换成了「后面还有一步」/「前面已经有一步」这两个真判据
    expect(rowRails.some((r) => /:has\(~ \.stepRow\)/.test(r.selector))).toBe(true);
    expect(rowRails.some((r) => /\.stepRow ~ \.stepRow\[open\]/.test(r.selector))).toBe(true);
  });

  it('**反向对照**:抽屉**里面**的工具行照旧一条线都不画', () => {
    /*
     * 少了这一条,把所有 `.tool` 一律打开也能让上面几条绿 —— 那会在每个清单抽屉
     * 内部再画一条链出来。链只属于顶层那一层:每条规则都必须钉死
     * `.fold.flat > .body.stack >` 这段祖先。
     */
    for (const rule of railRules) expect(rule.selector).toContain('.fold.flat');
    for (const rule of railRules) expect(rule.selector).toContain('> .body.stack >');
  });
});

/* ── N8-b 线的 x 按各行自己的缩进算 ─────────────────────────── */

describe('N8-b 线的横向位置不再是写死的常量', () => {
  it('每一条线段用的是**同一个表达式**,不是各写各的数', () => {
    const insets = new Set(
      railRules.map((r) => valueOf(r, 'inset-inline-start')).filter((v): v is string => v != null),
    );
    // 只应该有一种写法 —— 一条线只该有一个来源
    expect([...insets]).toHaveLength(1);
    const only = [...insets][0] ?? '';
    // 而且它是算出来的,不是 14.5px / 7.5px 这种拍出来的常量
    expect(only).toMatch(/^calc\(\s*var\(--chain-x\)\s*\+\s*var\(--row-outdent,\s*0px\)\s*\)$/);
  });

  it('**反向对照**:两种盒子往左探出的距离确实不一样', () => {
    /*
     * 如果所有行的盒子都从同一个 0 点起,「同一个表达式」是白拿的 —— 写死一个常量
     * 也能让上面那条绿。事实是链上那一格挂着 `margin-inline: -7px`,而夹心正文没有:
     * 两者差 7px,只有把这 7px 显式记进变量,同一个式子才可能在两处落到同一条绝对轴上。
     */
    expect(declOf('.fold.flat > .body.stack > :is(.fold, .tool)', 'margin-inline')).toBe('-7px');
    expect(declOf('.fold.flat > .body.stack > :is(.fold, .tool)', '--row-outdent')).toBe('7px');
    expect(declOf('.fold.flat > .body.stack', '--row-outdent')).toBe('0px');

    const prose = RULES.find((r) => r.selector.includes('.think:has(') && !r.selector.endsWith('::before'));
    expect(prose).toBeDefined();
    expect(prose?.body).not.toMatch(/--row-outdent/);       // 它不探出,吃壳 body 上的 0
  });

  it('按规则算出来,两种线段落在**同一条绝对轴**上', () => {
    /*
     * 不是比字符串,是把「盒子左缘 + 伪元素偏移」算出来比。
     * 坐标原点是壳 body 的内容盒左缘(真 Chrome 量到的 origin,§F-18)。
     */
    const chainX = px(declOf('.fold.flat > .body.stack', '--chain-x'));
    expect(chainX).toBe(7.5);

    const rowBox = px(declOf('.fold.flat > .body.stack > :is(.fold, .tool)', 'margin-inline'));
    const rowOutdent = px(declOf('.fold.flat > .body.stack > :is(.fold, .tool)', '--row-outdent'));
    // 链上那一格:盒子在 −7,伪元素偏移 14.5 → 绝对 7.5
    expect(rowBox + (chainX + rowOutdent)).toBeCloseTo(7.5, 5);
    // 夹心正文:盒子在 0,伪元素偏移 7.5 → 绝对 7.5
    expect(0 + (chainX + 0)).toBeCloseTo(7.5, 5);
    // 两个偏移**不相等**(14.5 vs 7.5)—— 正是这一点让「同一个表达式」不是废话
    expect(chainX + rowOutdent).not.toBeCloseTo(chainX, 5);
  });

  it('链的中轴就是行首那一格的中轴 —— 两个数写在一起,不会各走各的', () => {
    /* `--chain-x` 是 `--row-slot` 的一半。哪天行首那一格换了宽度,这条会立刻变红,
       而不是让线悄悄偏出图标半格。 */
    expect(px(declOf('.fold.flat > .body.stack', '--chain-x')))
      .toBeCloseTo(px(declOf('.fold.flat > .body.stack', '--row-slot')) / 2, 5);
  });

  it('缺口只留给行首那一格;夹心正文没有行首格,所以通高', () => {
    /*
     * 缺口的**大小**曾经写死成 `top: 25px`(照抄稿子)。OPEND-2417 之后改成算出来的:
     * `--row-pad-block + 1.5px + --row-slot + --chain-gap`。25 是这几个数的和,不是原因 ——
     * 写死的话,字号 / 行高 / 内边距任何一处一动,线就和行首那枚标记错身
     * (用户:「竖的灰线,有时候会覆盖到绿色带勾号的 icon 上」)。
     * 所以这里钉的是「有缺口、而且缺口盖得住行首那一格」,不再钉那个字面值;
     * 具体算式和两行行的对照在 `rail-clears-status-mark.test.tsx` 里。
     */
    const padBlock = px(declOf('.fold.flat > .body.stack', '--row-pad-block'));
    const slot = px(declOf('.fold.flat > .body.stack', '--row-slot'));
    const gap = px(declOf('.fold.flat > .body.stack', '--chain-gap'));
    for (const rule of rowRails) {
      expect(rule.body).toMatch(/top:\s*calc\(/);
      expect(rule.body).toMatch(/--row-slot/);
    }
    // 缺口必须真的把行首那一格整个让出来
    expect(padBlock + 1.5 + slot + gap).toBeGreaterThan(padBlock + 1.5 + slot);
    // 反向对照:夹心正文没有行首格,通高,一点缺口都不留
    for (const rule of proseRails) expect(rule.body).toMatch(/top:\s*0\s*;/);
  });
});

/* ── N8-c 顶层 vs 清单抽屉:两套列 ──────────────────────────── */

describe('N8-c 顶层和清单抽屉是两套列,各自内部一致', () => {
  /**
   * 真机量到的(§F-18,坐标相对壳 body 内容盒):
   *   顶层    步骤 0 / `div.tool` 0 / 思考 0
   *   抽屉里  子工具行 22 / 思考 22 / 嵌一层的折叠头 22
   * 这里读的是导出这两组数的那几条规则。
   */
  const TOP_ROWS: Array<[string, string]> = [
    ['步骤 / 可展开的工具行', '.fold.flat > .body.stack > .fold > summary'],
    ['不可展开的工具行', '.fold.flat > .body.stack > .tool'],
  ];

  it('顶层:三种行取同一个内边距,思考那一格没有自己的一份', () => {
    for (const [what, selector] of TOP_ROWS) {
      expect(declOf(selector, 'padding'), what).toBe('5px 7px');
    }
    /*
     * 思考那一格的**列**仍然和它们同一档,只是 2026-09-02 起换了个挂法:
     * 它是一只面板(标题栏 + 灰底正文共用一只盒子),列因此挂在**抽屉**的
     * `padding-inline-start` 上、标题栏那份归零 —— 两条加起来还是 7,
     * 标题和图标一个像素没动,动的只有底色那只盒子的左边缘。
     * (为什么必须这么挂:行盒的 `margin-inline: -7px` 把悬停底撑到壳的两侧,
     *  而灰底要落在内容列上,方向相反;一 hover 两块底就错开 7px。
     *  用户 2026-09-02:「这里怎么凸出来了」。)
     * 所以这里钉的不再是「没有专属规则」,而是**两条加起来仍然等于同一档**。
     */
    expect(declOf('.fold.flat > .body.stack > .fold.thoughts', 'padding-inline-start')).toBe('7px');
    expect(declOf('.fold.flat > .body.stack > .fold.thoughts > summary', 'padding-inline-start')).toBe('0');
  });

  it('抽屉里:三种行同为 29px', () => {
    expect(declOf('.fold.flat .body.stack :is(.body.stack, .body.stream) > *', 'padding-inline-start')).toBe('29px');
    expect(declOf('.fold.flat .body.stack .body.stack > .fold > summary', 'padding-inline-start')).toBe('29px');
  });

  it('**反向对照**:同一种行在两处取到的值**不相等**', () => {
    /*
     * 这一条是上两条的照妖镜:只断言「顶层是 7」的话,把所有行一律改成 7 也能绿,
     * 而那会把抽屉里的子行一起拽到最左,清单和它的子项就分不出层级了。
     * 两处的差正好是那颗状态点占的一格:29 − 7 = 22 = 状态点 15 + 间距 7。
     */
    const top = px(declOf('.fold.flat > .body.stack > .fold > summary', 'padding')?.split(/\s+/)[1] ?? null);
    const inner = px(declOf('.fold.flat .body.stack .body.stack > .fold > summary', 'padding-inline-start'));
    expect(top).not.toBeCloseTo(inner, 5);
    expect(inner - top).toBeCloseTo(px(declOf('.fold.flat > .body.stack', '--row-slot')) + 7, 5);
  });
});

/* ── N8-d 选择器真的能命中 ──────────────────────────────────── */

describe('N8-d 壳里确实是「步骤 / 思考 / 步骤 / 工具行」几个平级兄弟', () => {
  const cmd = (id: string, title: string): ShellItem => ({
    kind: 'tool', id, tool: 'bash', title, name: 'Bash', rawTitle: false,
    file: null, delta: null, hits: null, pattern: null, elapsedMs: 400,
    failed: false, failReason: null, command: 'ls -la', terminal: 'total 0',
  } as unknown as ShellItem);
  const readRow = (id: string): ShellItem => ({
    kind: 'tool', id, tool: 'read', title: `读取 ${id}`, name: 'Read', rawTitle: false,
    file: { path: id, label: id }, delta: null, hits: null, pattern: null, elapsedMs: 400,
    failed: false, failReason: null, command: null, terminal: null,
  } as unknown as ShellItem);
  const think = (text: string): ShellItem => ({ kind: 'text', text, thinking: true } as ShellItem);

  const shell = {
    kind: 'shell', seq: 0, status: 'succeeded', segments: [],
    thinking: false, stopped: false, elapsedMs: 130_000, quietMs: null,
    items: [
      cmd('c1', 'List project workspace'),
      think('计划(5 步)…'),
      cmd('c2', 'Write the one-pager'),
      readRow('a.png'),
    ],
  } as unknown as Shell;

  it('四格全是壳 body 的直接子代,且混着 details 和 div', () => {
    const { container } = render(
      <I18nProvider initial="zh-CN">
        <ExecutionShell shell={shell} deferCollapsedBodies={false} />
      </I18nProvider>,
    );
    const body = container.querySelector('details[class*="flat"] > div[class*="body"]');
    expect(body).not.toBeNull();
    const kids = Array.from(body?.children ?? []);
    expect(kids).toHaveLength(4);
    expect(kids.map((el) => el.tagName)).toEqual(['DETAILS', 'DETAILS', 'DETAILS', 'DIV']);
    expect(kids[1]?.className).toMatch(/thoughts/);
    // 混着两种标签 —— `:*-of-type` 数不对的那个前提在这儿是真的
    expect(kids[3]?.className).toMatch(/tool/);
  });
});
