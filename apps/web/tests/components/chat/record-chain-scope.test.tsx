// @vitest-environment jsdom
/**
 * 那条竖线(chain-of-thought 的「链」)和它带来的那一列缩进,到底该罩住谁。
 *
 * ## 用户指认的画面(2026-09-02)
 *
 * > 如果是在 todo 外的 toolrow 或者普通文本,或者 thinking,**不要有任何的缩进了,
 * > 也不要这个竖着的灰线**
 *
 * 现场是「已完成 8m 17s」下面那一格顶层的「思考过程」:左边挂着一条竖线、整块内容
 * 往右缩了一格 —— 而它排在「执行计划」**之前**,根本不在任何一步里面。
 * 同一轮还指认了第二件事:嵌在步骤里的思考,**灰底左边缘比它上下的工具行更靠左**(外凸)。
 *
 * ## 判据:按层级,不按类型
 *
 * 稿子对那条线的原话是「**步骤之间**穿一条竖线」「开头那句…不动:它是整块的开场白,
 * **不在链上**,线也没穿过它」。稿子里壳顶层清一色是步骤,所以它只写到「开场白」
 * 这一种例外就够了;产线上顶层混着思考、工具行、正文、计划卡、步骤五种东西,
 * 「顶层 = 步骤」这个前提**不成立**。
 *
 * 所以判据换成**这一行是不是一步**(`ExecutionShell` 给 todo / plan 那两种 `Foldable`
 * 挂 `styles.stepRow`),而不是「它是不是 thinking / 是不是 toolrow」——
 * 后者是排除法,每加一种新块型就漏一次;前者是正面判据,新块型默认不在链上,
 * 漏的方向是**安全**的那一边。
 *
 * ## 三条列(浅色主题,相对壳 body 的内容盒,单位 px)
 *
 * | 位置 | 行的可见左缘 | 灰底 / 终端块左缘 |
 * |---|---|---|
 * | 壳顶层 | 0 | **0** |
 * | 步骤里面 | 22 | **22** |
 *
 * 灰底容器原来落在 `29 - 8 = 21`(即绝对 14),理由是让**容器里的字**落在 22 那条线上;
 * 代价是**容器自己**比上下的工具行往左探出 8px —— 用户看到的就是这 8px。
 * 2026-09-02 翻过来:对齐**容器的边**,字跟着容器的内距走。
 *
 * ## 量法
 *
 * jsdom 不做布局,所以这里自己走盒模型:
 *   盒左缘(el) = 父内容左缘 + margin-inline-start(el)
 *   内容左缘(el) = 盒左缘(el) + padding-inline-start(el)
 * 每一档的值都真的走一遍层叠决出来(简写 `margin-inline` / `padding-inline` 和
 * 长写 `*-inline-start` 按各自的特异性比,不是谁写在后面谁赢)。
 * 断言钉**具体像素值**,不写「A 和 B 相等」—— 两边都算出同一个继承值时那种断言永远通过。
 */
import { cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { I18nProvider } from '../../../src/i18n';
import { ExecutionShell } from '../../../src/components/chat/ExecutionShell';
import type { ExecutionShell as Shell, ShellItem } from '../../../src/runtime/chat/contract';
import recordStyles from '../../../src/components/chat/primitives/record.module.css';
import chatRootStyles from '../../../src/components/chat/ChatRoot.module.css';
import thinkingStyles from '../../../src/components/chat/ThinkingMarkdown.module.css';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../../../src');
const R = recordStyles as unknown as Record<string, string>;

/* ── CSS Module 哈希 + 层叠(与 `record-muted-ink.test.tsx` 同一副打法)────── */

function hashOf(mod: unknown): string {
  const probe = (mod as Record<string, string>).odHashProbe;
  const m = /^_odHashProbe_(.+)$/.exec(probe ?? '');
  if (!m?.[1]) throw new Error(`拿不到 CSS Module 哈希:${String(probe)}`);
  return m[1];
}

function scopeSelector(prelude: string, hash: string): string {
  const globals: string[] = [];
  let out = prelude.replace(/:global\(([^()]*)\)/g, (_m, inner: string) => {
    globals.push(inner);
    return ` ${globals.length - 1} `;
  });
  out = out.replace(/\.(-?[A-Za-z_][\w-]*)/g, (_m, name: string) => `._${name}_${hash}`);
  return out.replace(/ (\d+) /g, (_m, i: string) => globals[Number(i)] ?? '');
}

function splitSelectorList(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = '';
  for (const ch of list) {
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(buf.trim()); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function specificity(selector: string): [number, number] {
  let b = 0;
  let c = 0;
  let rest = selector;
  for (const m of selector.matchAll(/:(?:not|is|has)\(([^()]*)\)/g)) {
    const inner = splitSelectorList(m[1] ?? '').map(specificity);
    const worst = inner.reduce<[number, number]>(
      (acc, one) => (one[0] !== acc[0] ? (one[0] > acc[0] ? one : acc) : one[1] > acc[1] ? one : acc),
      [0, 0],
    );
    b += worst[0];
    c += worst[1];
    rest = rest.replace(m[0], ' ');
  }
  b += (rest.match(/\.[A-Za-z0-9_-]+|\[[^\]]+\]|:{1}[a-z-]+(?![a-z-]*\()/g) ?? []).length;
  c += (rest.match(/(?:^|[\s>+~(])([a-zA-Z][a-zA-Z0-9-]*)/g) ?? []).length;
  return [b, c];
}

const heavier = (a: [number, number], b: [number, number]): boolean =>
  a[0] !== b[0] ? a[0] > b[0] : a[1] > b[1];

type Rule = { file: string; order: number; selector: string; body: string };

function rulesOf(css: string, file: string, from: number, hash: string | null): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  let order = from;
  const walk = (chunk: string, skip: boolean): void => {
    let i = 0;
    while (i < chunk.length) {
      const open = chunk.indexOf('{', i);
      if (open === -1) break;
      const prelude = chunk.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < chunk.length && depth > 0) {
        if (chunk[j] === '{') depth += 1;
        else if (chunk[j] === '}') depth -= 1;
        j += 1;
      }
      const inner = chunk.slice(open + 1, j - 1);
      if (prelude.startsWith('@')) {
        const dark = /dark|print|prefers-reduced-motion/.test(prelude);
        if (/^@(media|supports|layer|container)/.test(prelude)) walk(inner, skip || dark);
      } else if (!skip && prelude) {
        for (const one of splitSelectorList(prelude)) {
          order += 1;
          const selector = hash == null ? one : scopeSelector(one, hash);
          out.push({ file, order, selector: selector.replace(/\s+/g, ' ').trim(), body: inner });
        }
      }
      i = j;
    }
  };
  walk(text, false);
  return out;
}

function globalFiles(): string[] {
  const index = readFileSync(resolve(SRC, 'index.css'), 'utf-8');
  return [...index.matchAll(/@import\s+'([^']+)'/g)]
    .map((m) => resolve(SRC, m[1] ?? ''))
    .filter((file) => { try { readFileSync(file, 'utf-8'); return true; } catch { return false; } });
}

const MODULES: Array<{ file: string; mod: unknown }> = [
  { file: 'components/chat/ChatRoot.module.css', mod: chatRootStyles },
  { file: 'components/chat/primitives/record.module.css', mod: recordStyles },
  { file: 'components/chat/ThinkingMarkdown.module.css', mod: thinkingStyles },
];

let CASCADE: Rule[] = [];

const declaration = (body: string, prop: string): string | null => {
  let hit: string | null = null;
  for (const m of body.matchAll(new RegExp(`(?:^|[;{])\\s*${prop}\\s*:([^;}]*)`, 'g'))) {
    hit = (m[1] ?? '').trim();
  }
  return hit;
};

type Win = { rule: Rule; value: string; spec: [number, number] };

function winnerOf(el: Element, prop: string): Win | null {
  let best: Win | null = null;
  for (const rule of CASCADE) {
    const value = declaration(rule.body, prop);
    if (value == null) continue;
    if (/:hover\b|::/.test(rule.selector)) continue;
    let hit = false;
    try { hit = el.matches(rule.selector); } catch { continue; }
    if (!hit) continue;
    const spec = specificity(rule.selector);
    if (!best || heavier(spec, best.spec) || (!heavier(best.spec, spec) && rule.order > best.rule.order)) {
      best = { rule, value, spec };
    }
  }
  return best;
}

function splitVar(inside: string): { name: string; fallback: string | null } {
  let depth = 0;
  for (let i = 0; i < inside.length; i += 1) {
    const ch = inside[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      return { name: inside.slice(0, i).trim(), fallback: inside.slice(i + 1).trim() };
    }
  }
  return { name: inside.trim(), fallback: null };
}

/** 把 `var()` 展开成具体值 —— 包括嵌在 `calc()` 里的那些 */
function expandVars(el: Element, value: string, depth = 0): string {
  if (depth > 8) return value;
  const at = value.indexOf('var(');
  if (at === -1) return value;
  let d = 0;
  let end = -1;
  for (let i = at + 3; i < value.length; i += 1) {
    if (value[i] === '(') d += 1;
    else if (value[i] === ')') { d -= 1; if (d === 0) { end = i; break; } }
  }
  if (end === -1) return value;
  const { name, fallback } = splitVar(value.slice(at + 4, end));
  const got = getComputedStyle(el).getPropertyValue(name).trim();
  const replacement = got || fallback || '0px';
  return expandVars(el, value.slice(0, at) + replacement + value.slice(end + 1), depth + 1);
}

/** `12px` / `calc(29px - 8px)` / `5px 7px` 的**起始**分量 → 数字 */
function pxStart(raw: string): number {
  const value = raw.trim();
  const calc = /^calc\(\s*(-?[\d.]+)px\s*([-+])\s*(-?[\d.]+)px\s*\)$/.exec(value);
  if (calc) return Number(calc[1]) + (calc[2] === '-' ? -1 : 1) * Number(calc[3]);
  const first = value.split(/\s+/)[0] ?? '';
  const m = /^(-?[\d.]+)px$/.exec(first);
  if (m) return Number(m[1]);
  if (first === '0') return 0;
  return Number.NaN;
}

/**
 * 一个方向上的最终值。**简写和长写按各自的特异性比** ——
 * `padding-inline: 0` (0,7,0) 和 `padding-inline-start: 29px` (0,6,0) 谁赢是真的比出来的。
 * 简写的「起始」分量取 `margin-inline: A B` 的 A(只有一个值时就是它自己)。
 */
function edge(el: Element, side: 'margin' | 'padding'): number {
  const longhand = winnerOf(el, `${side}-inline-start`);
  const shorthand = winnerOf(el, `${side}-inline`);
  const box = side === 'padding' ? winnerOf(el, 'padding') : winnerOf(el, 'margin');
  const candidates = [longhand, shorthand, box].filter(Boolean) as Win[];
  if (!candidates.length) return 0;
  let best = candidates[0] as Win;
  for (const one of candidates.slice(1)) {
    if (heavier(one.spec, best.spec) || (!heavier(best.spec, one.spec) && one.rule.order > best.rule.order)) best = one;
  }
  // `padding: 5px 7px` / `margin: 0` 这种四值简写,起始分量是第二个(上下 / 左右)
  const raw = expandVars(el, best.value);
  const isBox = best === box;
  const parts = raw.trim().split(/\s+(?![^(]*\))/);
  const pick = isBox ? (parts[1] ?? parts[0] ?? '0') : (parts[0] ?? '0');
  const n = pxStart(pick);
  return Number.isNaN(n) ? 0 : n;
}

/** 盒左缘(border-box):父内容左缘 + 自己的 margin-start */
function boxLeft(el: Element, stop: Element): number {
  const parent = el.parentElement;
  const base = !parent || parent === stop ? 0 : contentLeft(parent, stop);
  return base + edge(el, 'margin');
}
/** 内容左缘:盒左缘 + 自己的 padding-start */
function contentLeft(el: Element, stop: Element): number {
  return boxLeft(el, stop) + edge(el, 'padding');
}

/** 这一格头上挂没挂那条竖线(`::before` 规则真的命中了没有) */
function hasRail(el: Element): boolean {
  for (const rule of CASCADE) {
    if (!rule.selector.endsWith('::before')) continue;
    if (!/content/.test(rule.body) || !/position: *absolute/.test(rule.body)) continue;
    if (!/background: *var\(--chat-border\)/.test(rule.body)) continue;
    try { if (el.matches(rule.selector.replace(/::before$/, ''))) return true; } catch { /* nwsapi 认不出的写法 */ }
  }
  return false;
}

/* ── 夹具 ────────────────────────────────────────────────────────── */

const say = (text: string): ShellItem => ({ kind: 'text', text, thinking: false } as ShellItem);
const think = (text: string, elapsedMs: number | null = 6500): ShellItem =>
  ({ kind: 'text', text, thinking: true, elapsedMs } as unknown as ShellItem);
const readRow = (id: string): ShellItem => ({
  kind: 'tool', id, tool: 'read', title: `读取 ${id}`, name: 'Read', rawTitle: false,
  file: { path: id, label: id }, delta: null, hits: null, pattern: null, elapsedMs: 400,
  failed: false, failReason: null, command: null, terminal: null,
} as unknown as ShellItem);
const cmdRow = (id: string, title: string, failed = false): ShellItem => ({
  kind: 'tool', id, tool: 'bash', title, name: 'Bash', rawTitle: false,
  file: null, delta: null, hits: null, pattern: null, elapsedMs: 8400,
  failed, failReason: null, command: 'python3 render.py', terminal: 'done',
} as unknown as ShellItem);
const plan = (steps: string[]): ShellItem => ({ kind: 'plan', steps } as ShellItem);
const todoSeg = (content: string, items: ShellItem[]): ShellItem => ({
  kind: 'todo',
  segment: {
    content, status: 'completed', recalled: false, abandoned: false,
    implicit: false, items, elapsedMs: 143_000,
  },
} as unknown as ShellItem);

const shellOf = (items: ShellItem[], over: Partial<Shell> = {}): Shell => ({
  kind: 'shell', seq: 0, status: 'succeeded', items, segments: [],
  thinking: false, stopped: false, elapsedMs: 497_000, quietMs: null, ...over,
} as Shell);

/**
 * 用户截图那一幕:一条步骤里 命令行 / 思考 / 命令行 / 思考 交替,
 * 而**顶层**还压着一格思考、一张计划卡、两条步骤和夹在中间的小结。
 */
const SCENE = shellOf([
  think('顶层这一段推理排在清单之前,它不在任何一步里面。'),
  plan(['Run Design Jury review', 'Export the folio']),
  todoSeg('Run Design Jury review and apply must-fix items', [
    cmdRow('c1', '执行 python3'),
    think('Optimizing single render pass'),
    cmdRow('c2', 'export the folio', true),
    think('Planning accent usage across the folio', null),
  ]),
  say('两步之间的一句小结。'),
  todoSeg('Export the folio', [readRow('folio.html')]),
  say('收尾那一句,后面没有步骤了。'),
]);

/** 完全没有清单的壳 —— 顶层清一色是工具行和正文,一步都没有 */
const NO_STEPS = shellOf([
  say('开场白。'),
  readRow('brand-spec.md'),
  say('夹在两条工具行中间的一句。'),
  cmdRow('c3', '构建产物'),
  say('收尾那一句。'),
]);

/** 还在想的那一格(顶层) */
const LIVE = shellOf(
  [think('还在往里写的推理。', null)],
  { status: 'running', thinking: true },
);

function mount(shell: Shell): HTMLElement {
  const { container } = render(
    <I18nProvider initial="zh-CN">
      <ExecutionShell shell={shell} deferCollapsedBodies={false} />
    </I18nProvider>,
  );
  const app = document.createElement('div');
  app.className = 'app';
  const seam = document.createElement('div');
  seam.className = (chatRootStyles as unknown as Record<string, string>).root as string;
  seam.setAttribute('data-chat-root', '');
  app.appendChild(seam);
  seam.appendChild(container);
  document.body.appendChild(app);
  return seam;
}

const bodyOf = (root: HTMLElement): HTMLElement => {
  const el = root.querySelector<HTMLElement>(`details.${R.flat} > div.${R.stack}`);
  if (!el) throw new Error('壳的 body 没渲染出来');
  return el;
};

/** 壳 body 的直接子代里,文字含 `needle` 的那一格 */
function topChild(root: HTMLElement, needle: string): HTMLElement {
  const body = bodyOf(root);
  const hit = [...body.children].find((c) => (c.textContent ?? '').includes(needle));
  if (!hit) {
    throw new Error(`顶层找不到「${needle}」;实际是 ${
      [...body.children].map((c) => `${c.tagName}:${(c.textContent ?? '').slice(0, 14)}`).join(' | ')
    }`);
  }
  return hit as HTMLElement;
}

/** 某条步骤抽屉的 body 里,文字含 `needle` 的那一格 */
function stepChild(root: HTMLElement, step: string, needle: string): HTMLElement {
  const drawer = topChild(root, step);
  const body = drawer.querySelector<HTMLElement>(`:scope > div.${R.stack}`);
  if (!body) throw new Error(`「${step}」这条步骤没有 body`);
  const hit = [...body.children].find((c) => (c.textContent ?? '').includes(needle));
  if (!hit) {
    throw new Error(`「${step}」里找不到「${needle}」;实际是 ${
      [...body.children].map((c) => `${c.tagName}:${(c.textContent ?? '').slice(0, 14)}`).join(' | ')
    }`);
  }
  return hit as HTMLElement;
}

/** 思考那一格的灰底容器(还在想是 `.stream`,想完了是 `.stack`,同一只容器) */
const thoughtsBox = (drawer: HTMLElement): HTMLElement => {
  const box = drawer.querySelector<HTMLElement>(':scope > div');
  if (!box) throw new Error('思考那一格没有 body');
  return box;
};

beforeAll(() => {
  document.documentElement.setAttribute('data-theme', 'light');
  for (const file of globalFiles()) {
    const style = document.createElement('style');
    style.textContent = readFileSync(file, 'utf-8');
    document.head.appendChild(style);
  }
  for (const { file, mod } of MODULES) {
    const style = document.createElement('style');
    style.textContent = readFileSync(resolve(SRC, file), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/([^{}]+)\{/g, (m, prelude: string) => (
        prelude.trim().startsWith('@') ? m : `${scopeSelector(prelude, hashOf(mod))}{`
      ));
    document.head.appendChild(style);
  }
  CASCADE = buildCascade();
});

function buildCascade(): Rule[] {
  const out: Rule[] = [];
  for (const file of globalFiles()) out.push(...rulesOf(readFileSync(file, 'utf-8'), file, out.length, null));
  for (const { file, mod } of MODULES) {
    out.push(...rulesOf(readFileSync(resolve(SRC, file), 'utf-8'), file, out.length, hashOf(mod)));
  }
  return out;
}

afterEach(() => {
  cleanup();
  document.querySelectorAll('.app').forEach((n) => n.remove());
});

/* ── 1 · 顶层不挂线 ─────────────────────────────────────────────── */

describe('那条竖线只穿步骤,顶层的东西一概不挂', () => {
  it('顶层的思考不挂线', () => {
    const root = mount(SCENE);
    expect(hasRail(topChild(root, '顶层这一段推理'))).toBe(false);
  });

  it('顶层的工具行不挂线(没有清单的壳里顶层清一色是工具行)', () => {
    const root = mount(NO_STEPS);
    expect(hasRail(topChild(root, 'brand-spec.md'))).toBe(false);
    expect(hasRail(topChild(root, '构建产物'))).toBe(false);
  });

  it('顶层的普通正文不挂线', () => {
    const root = mount(NO_STEPS);
    expect(hasRail(topChild(root, '夹在两条工具行中间'))).toBe(false);
    expect(hasRail(topChild(root, '开场白'))).toBe(false);
  });

  /* ⚠️ 反向守卫:线不能连着步骤一起摘掉,那是把这块的顺序语义整个删了 */
  it('**步骤仍然挂线** —— 链是步骤之间的那根链', () => {
    const root = mount(SCENE);
    expect(hasRail(topChild(root, 'Run Design Jury review and apply'))).toBe(true);
    expect(hasRail(topChild(root, '执行计划'))).toBe(true);
  });

  it('**夹在两步中间的小结仍然挂线**,并且仍是 22px 那一列', () => {
    const root = mount(SCENE);
    const mid = topChild(root, '两步之间的一句小结');
    expect(hasRail(mid)).toBe(true);
    expect(contentLeft(mid, bodyOf(mount(SCENE)))).toBe(22);
  });

  it('收尾那一句后面没有步骤,不挂线', () => {
    const root = mount(SCENE);
    expect(hasRail(topChild(root, '收尾那一句'))).toBe(false);
  });
});

/* ── 2 · 顶层不缩进 ─────────────────────────────────────────────── */

describe('顶层的东西一律站在第 0 列', () => {
  it('顶层思考的灰底容器左缘落在 0,和同层工具行的可见左缘同列', () => {
    const root = mount(SCENE);
    const body = bodyOf(root);
    const box = thoughtsBox(topChild(root, '顶层这一段推理'));
    expect(boxLeft(box, body)).toBe(0);
  });

  it('顶层工具行的可见左缘就是 0 —— 上面那条对齐的是它', () => {
    const root = mount(NO_STEPS);
    const body = bodyOf(root);
    const row = topChild(root, 'brand-spec.md');
    expect(contentLeft(row, body)).toBe(0);
  });

  it('顶层命令行的终端块也落在 0,不再缩一格', () => {
    const root = mount(NO_STEPS);
    const body = bodyOf(root);
    const code = topChild(root, '构建产物').querySelector<HTMLElement>(`div.${R.code}`);
    expect(code, '终端块没渲染出来').toBeTruthy();
    expect(boxLeft(code!, body)).toBe(0);
  });

  it('顶层普通正文落在 0(开场白一直就是这样,别被一起推走)', () => {
    const root = mount(NO_STEPS);
    expect(contentLeft(topChild(root, '开场白'), bodyOf(root))).toBe(0);
  });

  it('还在想那一态的灰底容器同样落在 0 —— 两态不许换列', () => {
    const root = mount(LIVE);
    const body = bodyOf(root);
    const box = thoughtsBox(topChild(root, '还在往里写的推理'));
    expect(boxLeft(box, body)).toBe(0);
  });

  /*
   * 灰底**里面**的字只吃容器那 8px 内距,不再多一层缩进。
   * 稿子逐字:`thinking-stream.css` 的 `--stream-pad: 8px` + 容器 `padding: var(--stream-pad)`,
   * 而窗里的正文是 `… > .think { padding: 0 }` —— 一层内距,不是两层。
   * 用户 2026-09-02 并排对比时箭头指的就是「灰底左边缘到文字之间那段空白」。
   */
  it('顶层思考的**正文**落在 8 —— 只有容器那一份 --stream-pad,没有第二层缩进', () => {
    const root = mount(SCENE);
    const body = bodyOf(root);
    const md = topChild(root, '顶层这一段推理').querySelector<HTMLElement>('[data-testid="thinking-markdown"]');
    expect(md, '思考正文没渲染出来').toBeTruthy();
    expect(contentLeft(md!, body)).toBe(8);
  });

  it('还在想那一态的正文同样落在 8', () => {
    const root = mount(LIVE);
    const body = bodyOf(root);
    const md = topChild(root, '还在往里写的推理').querySelector<HTMLElement>('[data-testid="thinking-markdown"]');
    expect(md, '思考正文没渲染出来').toBeTruthy();
    expect(contentLeft(md!, body)).toBe(8);
  });

  it('容器那份内距就是稿子的 --stream-pad,值是 8px', () => {
    const root = mount(LIVE);
    const box = thoughtsBox(topChild(root, '还在往里写的推理'));
    expect(edge(box, 'padding')).toBe(8);
  });
});

/* ── 3 · 步骤里面那一列 ─────────────────────────────────────────── */

describe('嵌在步骤里:灰底左缘和同层工具行对齐', () => {
  const STEP = 'Run Design Jury review and apply';

  it('步骤里的工具行可见左缘是 22', () => {
    const root = mount(SCENE);
    const body = bodyOf(root);
    const row = stepChild(root, STEP, '执行 python3');
    const summary = row.querySelector<HTMLElement>(':scope > summary')!;
    expect(contentLeft(summary, body)).toBe(22);
  });

  it('**第一块**思考的灰底左缘也是 22 —— 不再比工具行往左探出 8px', () => {
    const root = mount(SCENE);
    const body = bodyOf(root);
    const box = thoughtsBox(stepChild(root, STEP, 'Optimizing single render pass'));
    expect(boxLeft(box, body)).toBe(22);
  });

  it('**第二块**思考的灰底左缘同样是 22 —— 两块之间不许错位', () => {
    const root = mount(SCENE);
    const body = bodyOf(root);
    const box = thoughtsBox(stepChild(root, STEP, 'Planning accent usage'));
    expect(boxLeft(box, body)).toBe(22);
  });

  it('步骤里思考的正文落在 30(22 那一列 + 容器的 8px 内距),不是再缩一格', () => {
    const root = mount(SCENE);
    const body = bodyOf(root);
    const md = stepChild(root, STEP, 'Optimizing single render pass')
      .querySelector<HTMLElement>('[data-testid="thinking-markdown"]');
    expect(md, '思考正文没渲染出来').toBeTruthy();
    expect(contentLeft(md!, body)).toBe(30);
  });

  it('步骤里命令行的终端块也是 22 —— 同一列上三种盒子对齐', () => {
    const root = mount(SCENE);
    const body = bodyOf(root);
    const code = stepChild(root, STEP, '执行 python3').querySelector<HTMLElement>(`div.${R.code}`);
    expect(code, '终端块没渲染出来').toBeTruthy();
    expect(boxLeft(code!, body)).toBe(22);
  });

  it('步骤里的东西**不各自再挂一条线** —— 链在外面那一层,不在里面重画', () => {
    const root = mount(SCENE);
    expect(hasRail(stepChild(root, STEP, '执行 python3'))).toBe(false);
    expect(hasRail(stepChild(root, STEP, 'Optimizing single render pass'))).toBe(false);
  });
});

/* ── 4 · 两条渲染路径 ───────────────────────────────────────────── */

describe('思考只有一条渲染路径,普通正文是另一回事', () => {
  it('同一条步骤里的两格思考走同一个组件、同一套 DOM', () => {
    const root = mount(SCENE);
    const STEP = 'Run Design Jury review and apply';
    const a = stepChild(root, STEP, 'Optimizing single render pass');
    const b = stepChild(root, STEP, 'Planning accent usage');
    // 同一个类名组合 = 同一条路径。第二格没有耗时(`sumElapsed` 缺一段就整格算不出),
    // 但那只改 summary 里有没有 `.meta` 槽,不该改 body 的形态。
    expect(a.className).toBe(b.className);
    expect(thoughtsBox(a).className).toBe(thoughtsBox(b).className);
    expect(a.querySelector('[data-testid="thinking-markdown"]')).toBeTruthy();
    expect(b.querySelector('[data-testid="thinking-markdown"]')).toBeTruthy();
  });

  it('有没有耗时只影响 summary 的槽位,不影响 body', () => {
    const root = mount(SCENE);
    const STEP = 'Run Design Jury review and apply';
    const a = stepChild(root, STEP, 'Optimizing single render pass');
    const b = stepChild(root, STEP, 'Planning accent usage');
    expect(a.querySelector('[data-testid="chat-foldable-elapsed"]')).toBeTruthy();
    expect(b.querySelector('[data-testid="chat-foldable-elapsed"]')).toBeNull();
  });

  /*
   * 这一条钉的是**边界**,不是缺口:普通过程叙述(`SayText` → `p.think`)
   * 和思考(`ThoughtsRow` → `ThinkingMarkdown`)是两种内容,长得就该不一样。
   * 用户截图里那段没有灰底、深色的文字如果是叙述,它本来就不该进灰底容器 ——
   * 给它套上思考的壳才是新 bug。
   */
  it('普通过程叙述不套灰底容器 —— 它不是推理', () => {
    const root = mount(SCENE);
    const tail = topChild(root, '收尾那一句');
    expect(tail.tagName).toBe('P');
    expect(tail.querySelector('[data-testid="thinking-markdown"]')).toBeNull();
  });
});

/*
 * ⚠️ 这一条钉的是 CSS Module 的**静默失效**:类名只有在样式表里真的出现过,
 * 打包器才会把它发出来。`ExecutionShell` 一直在传 `className={styles.stepRow}`,
 * 一旦 CSS 里没有 `.stepRow` 这条选择器,`styles.stepRow` 就是 `undefined`,
 * 类一次都上不了 DOM,而上面所有渲染断言在 vitest 的 CSS Module 代理下**照旧全绿**
 * (代理对任何键都返回类名)。`.thoughts` 就这么空转过一整轮,`.hasTodo` 的注释里
 * 也记着同一个坑 —— 所以只能直接读源文件。
 */
describe('`.stepRow` 真的在样式表里', () => {
  it('样式表里有 `.stepRow` 这条选择器 —— 否则这个类根本不会被发出来', () => {
    const css = readFileSync(
      resolve(SRC, 'components/chat/primitives/record.module.css'),
      'utf-8',
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(/\.stepRow[\s,.:[>+~{]/);
  });

  it('失败的命令行图标转红 —— 稿子 `.fold.is-fail > summary .ti > svg`(2219)', () => {
    const css = readFileSync(
      resolve(SRC, 'components/chat/primitives/record.module.css'),
      'utf-8',
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(/\.fold\.fail > summary \.icon[\s,]/);
    expect(css).toMatch(/\.fold\.fail > summary \.icon > svg[\s,{]/);
  });
});

/* ── 5 · 没有清单的壳:一步都没有,就没有链 ─────────────────────── */

describe('没有清单的壳:顶层清一色不挂线、不缩进', () => {
  it('夹在两条工具行中间的正文也不挂线 —— 工具行不是步骤', () => {
    const root = mount(NO_STEPS);
    const body = bodyOf(root);
    const mid = topChild(root, '夹在两条工具行中间');
    expect(hasRail(mid)).toBe(false);
    expect(contentLeft(mid, body)).toBe(0);
  });
});
