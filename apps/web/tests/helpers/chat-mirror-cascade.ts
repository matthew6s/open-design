/**
 * 微型层叠解析器 —— chat-mirror 这一族「量最终计算值」的共用底座。
 *
 * ── 为什么不能用 `getComputedStyle` ──────────────────────────────────
 * 三件事 jsdom 都不做:(1) 特异性层叠,(2) `var()` 解析,(3) **逻辑属性**
 * (写了 `padding-inline: 14px`,`getComputedStyle().paddingLeft` 读回的是上一条
 * 物理简写留下的值)。而这一族要照的恰恰就是「哪条规则最终赢了」——
 * 规则文本两边一个字不差、只有层叠结果不同,是这一族反复出现的事故形态。
 *
 * 所以本模块按产品 `index.css` 的导入顺序把真实样式表读进来,用 `element.matches()`
 * 做匹配、按 (特异性, 顺序) 排序,自己算出胜出声明,再解一层 `var()`。
 *
 * ── 调用方必须自己传两样东西 ────────────────────────────────────────
 * 1. `parts`:够得着目标元素的那几张表,**顺序照 `index.css`**,CSS Module 排在
 *    全局之后并且**先过 `hashed()`** —— 全局表里的 `.button` 在产线上不匹配
 *    module 类,照抄这件事,否则量出来的是一颗根本不存在的按钮。
 * 2. `targets`:要比哪几个属性。**故意不给默认值** —— 各测试文件用 `toEqual`
 *    整表比对,共用一张属性表会让「另一个文件加了一项」变成这个文件的假失败。
 */

export interface Rule {
  selector: string;
  body: string;
  order: number;
}

export function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 顶层规则。`@media` / `@supports` 这类块整体跳过 —— 本族比的是声明文本,不是解析后的颜色。 */
export function parseRules(css: string, start: number): { rules: Rule[]; next: number } {
  const rules: Rule[] = [];
  let order = start;
  let i = 0;
  const src = stripComments(css);
  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i] ?? '')) i += 1;
    if (i >= src.length) break;
    if (src[i] === '@') {
      let j = i;
      while (j < src.length && src[j] !== '{' && src[j] !== ';') j += 1;
      if (j >= src.length || src[j] === ';') {
        i = j + 1;
        continue;
      }
      let depth = 0;
      let k = j;
      for (; k < src.length; k += 1) {
        if (src[k] === '{') depth += 1;
        else if (src[k] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      i = k + 1;
      continue;
    }
    const brace = src.indexOf('{', i);
    if (brace < 0) break;
    const end = src.indexOf('}', brace);
    if (end < 0) break;
    rules.push({
      selector: src.slice(i, brace).trim().replace(/\s+/g, ' '),
      body: src.slice(brace + 1, end),
      order: (order += 1),
    });
    i = end + 1;
  }
  return { rules, next: order };
}

/** CSS Module 的类名换成真哈希 —— 全局表里的 `.button` 在产线上**不匹配** module 类,照抄这件事。 */
export function hashed(css: string, map: Record<string, string>): string {
  const locals = new Set<string>();
  for (const m of stripComments(css).matchAll(/\.([A-Za-z][\w-]*)/g)) locals.add(m[1]!);
  let out = css;
  for (const local of locals) {
    const generated = map[local];
    if (!generated || local === generated) continue;
    out = out.replace(new RegExp(`\\.${local}\\b`, 'g'), `.${generated}`);
  }
  return out;
}

export function specificity(selector: string): number {
  // `:where(…)` 整段计 0 —— 少了这一步,`:where([data-chat-root]) button` 会被算成
  // (0,1,1) 压过共享 Button 的 `.button`,量出来就是 13px / 无圆角 / 无内距的裸按钮档。
  const cleaned = selector
    .replace(/:where\(([^()]|\([^()]*\))*\)/g, ' ')
    .replace(/::[\w-]+/g, ' ');
  const ids = (cleaned.match(/#[\w-]+/g) ?? []).length;
  const classes =
    (cleaned.match(/\.[\w-]+/g) ?? []).length +
    (cleaned.match(/\[[^\]]*\]/g) ?? []).length +
    (cleaned.match(/:(?!:)(?!where\b)[\w-]+/g) ?? []).length;
  const elements = (
    cleaned.replace(/\.[\w-]+|#[\w-]+|\[[^\]]*\]|:[\w-]+(\([^)]*\))?/g, ' ').match(
      /\b[a-zA-Z][\w-]*\b/g,
    ) ?? []
  ).length;
  return ids * 10_000 + classes * 100 + elements;
}

/**
 * 简写展开。**逻辑属性在这里落到物理格子上** —— `padding-inline: 14px` 变成
 * `padding-left/right: 14px`,于是「共享 Button 的 `.sm` 给了 11px」和
 * 「我们又盖了一层 14px」能在同一把尺子上比。
 */
export function expand(prop: string, value: string): Array<[string, string]> {
  const v = value.trim();
  switch (prop) {
    case 'background':
      // `none` / `transparent` / 单色都只落在 background-color 上;渐变不出现在这几条规则里
      return [['background-color', v === 'none' ? 'transparent' : v]];
    case 'background-color':
      return [['background-color', v]];
    case 'border': {
      if (/^0(px)?$/.test(v) || v === 'none') {
        return [
          ['border-top-width', '0px'],
          ['border-top-style', 'none'],
          ['border-top-color', 'currentcolor'],
        ];
      }
      const parts = v.split(/\s+(?![^(]*\))/);
      return [
        ['border-top-width', parts[0] ?? 'medium'],
        ['border-top-style', parts[1] ?? 'none'],
        ['border-top-color', parts[2] ?? 'currentcolor'],
      ];
    }
    case 'border-width':
      return [['border-top-width', v]];
    case 'border-style':
      return [['border-top-style', v]];
    case 'border-color':
      return [['border-top-color', v]];
    case 'border-radius':
      return [['border-radius', v]];
    case 'padding': {
      const p = v.split(/\s+(?![^(]*\))/);
      const [t, r = t, b = t, l = r] = p as [string, string?, string?, string?];
      return [
        ['padding-top', t!],
        ['padding-right', r!],
        ['padding-bottom', b!],
        ['padding-left', l!],
      ];
    }
    case 'padding-block': {
      const p = v.split(/\s+/);
      return [
        ['padding-top', p[0]!],
        ['padding-bottom', p[1] ?? p[0]!],
      ];
    }
    case 'padding-inline': {
      const p = v.split(/\s+/);
      return [
        ['padding-left', p[0]!],
        ['padding-right', p[1] ?? p[0]!],
      ];
    }
    case 'padding-inline-start':
      return [['padding-left', v]];
    case 'padding-inline-end':
      return [['padding-right', v]];
    case 'padding-top':
    case 'padding-right':
    case 'padding-bottom':
    case 'padding-left':
    case 'font-weight':
    case 'font-size':
    case 'color':
    case 'cursor':
    case 'opacity':
    case 'width':
    case 'height':
    case 'min-width':
    case 'min-height':
    case 'box-shadow':
      return [[prop, v]];
    default:
      return [];
  }
}

/** 没有任何规则给出这个属性 —— 和「给了但值是 auto」是两件事,必须分得开。 */
export const UNSET = '<unset>';

export interface Resolver {
  rules: Rule[];
  /** 元素上每个目标属性的胜出值(已解 var);没人给的读回 {@link UNSET}。 */
  resolved: (el: Element) => Record<string, string>;
  /** 所有匹配到该元素、且声明了 `prop` 的规则(按层叠顺序)—— 用来指认「是谁写的」。 */
  declaring: (el: Element, prop: string) => Rule[];
}

/**
 * @param parts 样式表内容,顺序照 `index.css`;CSS Module 先过 {@link hashed}。
 * @param tokenSheets 供 `var()` 解析的表(取其 `:root` 块,产品强制亮色)。
 * @param targets 要比哪几个属性。
 */
export function createResolver(
  parts: string[],
  tokenSheets: string[],
  targets: readonly string[],
): Resolver {
  const rules: Rule[] = [];
  let order = 0;
  for (const part of parts) {
    const parsed = parseRules(part, order);
    rules.push(...parsed.rules);
    order = parsed.next;
  }

  /** 一层 `var()` 解析,变量表取自 token 表的 `:root`。 */
  const tokens: Record<string, string> = {};
  for (const css of tokenSheets) {
    const root = /:root\s*\{([\s\S]*?)\}/.exec(stripComments(css));
    for (const decl of (root?.[1] ?? '').split(';')) {
      const m = /^\s*(--[\w-]+)\s*:\s*([\s\S]+)$/.exec(decl);
      if (m) tokens[m[1]!] = m[2]!.trim();
    }
  }

  const deref = (value: string): string => {
    let out = value;
    for (let i = 0; i < 4; i += 1) {
      const next = out.replace(
        /var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g,
        (whole, name: string, fallback?: string) => tokens[name] ?? fallback?.trim() ?? whole,
      );
      if (next === out) break;
      out = next;
    }
    // 无单位的 0 归一成 0px,免得 `padding-inline: 0` 和 `padding: 4px 0px` 比出假差异
    return out.trim().replace(/(^|\s)0(?=$|\s)/g, '$10px');
  };

  const matchingBranch = (rule: Rule, el: Element): string | undefined =>
    rule.selector
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .find((s) => {
        try {
          return el.matches(s);
        } catch {
          return false;
        }
      });

  const resolved = (el: Element): Record<string, string> => {
    const winners = new Map<string, { spec: number; order: number; value: string }>();
    for (const rule of rules) {
      const branch = matchingBranch(rule, el);
      if (!branch) continue;
      const spec = specificity(branch);
      for (const decl of rule.body.split(';')) {
        const m = /^\s*([\w-]+)\s*:\s*([\s\S]+)$/.exec(decl);
        if (!m) continue;
        for (const [prop, value] of expand(m[1]!.toLowerCase(), m[2]!)) {
          const current = winners.get(prop);
          if (!current || spec > current.spec || (spec === current.spec && rule.order >= current.order)) {
            winners.set(prop, { spec, order: rule.order, value });
          }
        }
      }
    }
    const out: Record<string, string> = {};
    for (const prop of targets) out[prop] = deref(winners.get(prop)?.value ?? UNSET);
    return out;
  };

  const declaring = (el: Element, prop: string): Rule[] =>
    rules.filter((rule) => {
      if (!matchingBranch(rule, el)) return false;
      return rule.body.split(';').some((decl) => {
        const m = /^\s*([\w-]+)\s*:\s*([\s\S]+)$/.exec(decl);
        if (!m) return false;
        return expand(m[1]!.toLowerCase(), m[2]!).some(([p]) => p === prop);
      });
    });

  return { rules, resolved, declaring };
}
