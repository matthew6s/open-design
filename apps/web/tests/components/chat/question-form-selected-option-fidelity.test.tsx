// @vitest-environment jsdom
/**
 * 选项行「选中态」的两处小账 —— 都是上一轮修层叠渗漏
 * (`question-form-option-cascade-leak.test.tsx`)时路过看到、按守住范围没动的。
 *
 * ── ① 选中项的字重跟稿子差一档 ─────────────────────────────────────────
 * 交付稿 `8015870095:docs/design/chat-panel/src/components.css` L1457-1459:
 *   `.opt.is-on { color: var(--select-ink); font-weight: 500; }`
 * 上面那段注释(L1454-1455)写得很明白:「选中态因此只剩两处变化:前面的控件
 * 填实(--pick),**文字使用 500** 并换成 --select-ink」。
 * 我们写的是 600。
 *
 * **600 不是抄错,是稿子改了我们没跟。** 上一版稿子 `1bbdce0b06`(2026-08-21)
 * 同一格写的就是 `font-weight: 600`,注释原文「文字**加粗到 600** 并换成
 * --brand-text」;我们那条是 `38aa03bff4`(2026-08-26,照那一版稿子重建聊天面板)
 * 落的,当时对。2026-09-01 稿子在 `8015870095` 里把这一档降到 500(顺带把
 * --brand-text 换成 --select-ink —— 颜色那一半我们已经跟上了,字重这一半漏了)。
 * 本分支对齐的就是 `8015870095`,所以这一格照 500。
 *
 * ── ② 「自己填」那颗勾的描边:hover 压过了选中 ──────────────────────────
 * 稿子 L1485 `.opt:hover .box { border-color: var(--text-soft) }` 是 (0,3,0),
 * 稳输给 L1493 / L1511 的 `.opts.mod-* .opt.is-on .box`(0,5,0)—— 选中的勾在
 * hover 时不会被描回一圈灰边。
 *
 * 我们搬过来时,固定选项那一路(`.qf-chip-box`)上一轮已经把祖先补回去了
 * (`.qf-options .qf-chip.qf-chip-on .qf-chip-box`,(0,4,0));**「自己填」展开态
 * 用的是另一颗盒子** `.qf-chip-own-box`(稿子是静态 `<span class="box">`,产品
 * 换成真 `<button>` 以便键盘操作),它那一对没跟着改:
 *   `.qf-chip-other:hover .qf-chip-own-box`  → 2 类 + 1 伪类 = (0,3,0)
 *   `.qf-chip-on .qf-chip-own-box`           → 2 类        = (0,2,0)
 * 后者**低一档**,于是鼠标一扫,勾外面就描出一圈 `--text-soft` 的灰边 ——
 * 和缺陷 ② 一模一样的事故,只是换了一颗盒子。
 * (交接口径里把这两条记成「特异性打平、靠源码顺序碰巧赢」——量下来不是打平,
 *  是选中那条真的输了;`:hover` 本身就占一格类级。)
 *
 * 处方同上一轮:把祖先补回去、并且**严格大于**,不打平靠源码顺序
 * (`specs/current/chat-panel-next.md` 踩坑 25)。所以本文件除了盯色值,还
 * 直接把两条规则的**特异性大小关系**钉住 —— 只盯色值的话,哪天有人把它改回
 * 打平,色值仍然是对的(靠写在后面),护栏就漏过去了。
 *
 * ── 量法照 `question-form-maxed-option-hover.test.tsx` ────────────────────
 * 不用 CSS Module 代理;按 `index.css` 的顺序注入整条样式链自己算层叠
 * (`primitives.css` 里的全局 `button { font-weight: 500 }` 是 ① 的另一端,
 *  少注它这条对不上);hover 用真事件并**当场核实**指针位置;断言盯具体值。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { I18nProvider } from '../../../src/i18n';
import { QuestionFormView } from '../../../src/components/QuestionForm';
import type { QuestionForm } from '../../../src/artifacts/question-form';
import chatRootStyles from '../../../src/components/chat/ChatRoot.module.css';
import { createResolver, hashed, specificity, type Rule } from '../../helpers/chat-mirror-cascade';

afterEach(cleanup);

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '../../..');
const read = (p: string): string => readFileSync(resolve(WEB, p), 'utf-8');

const TARGETS = ['font-weight', 'border-top-color'] as const;

/** 产品 `index.css` 的导入顺序(只取够得着选项行的那几张)。 */
const CSS = createResolver(
  [
    read('src/styles/tokens.css'),
    read('src/styles/base.css'),
    readFileSync(resolve(WEB, '../../packages/components/src/styles.css'), 'utf-8'),
    read('src/styles/primitives.css'),
    read('src/styles/chat.css'),
    read('src/styles/viewer/core.css'),
    read('src/styles/viewer/composio.css'),
    hashed(
      read('src/components/chat/ChatRoot.module.css'),
      chatRootStyles as unknown as Record<string, string>,
    ),
  ],
  [read('src/styles/tokens.css'), read('src/styles/base.css')],
  TARGETS,
);

/** 指针停在 `chip` 上时 `target` 的读数;`target` 默认就是 `chip` 自己。 */
function whileHovering(chip: Element, target: Element = chip): Record<string, string> {
  fireEvent.mouseOver(chip);
  if (!chip.matches(':hover')) throw new Error('指针没停上去 —— 这一量是假的');
  return CSS.resolved(target);
}

/** 静息态读数。先把指针挪开并**当场核实** —— `fireEvent.click` 会把指针留在点过的那一颗上。 */
function atRest(chip: Element, target: Element = chip): Record<string, string> {
  fireEvent.mouseOut(chip);
  if (chip.matches(':hover')) throw new Error('指针没挪走 —— 量到的其实是 hover 态');
  return CSS.resolved(target);
}

/** 指认「给这个属性下过声明、且选择器里含 `needle`」的**那一条**规则。 */
function soleRule(el: Element, prop: string, needle: string): Rule {
  const hits = CSS.declaring(el, prop).filter((r) => r.selector.includes(needle));
  if (hits.length !== 1) {
    throw new Error(
      `期望正好一条含 "${needle}" 且声明 ${prop} 的规则,实得 ${hits.length} 条:` +
        hits.map((r) => r.selector).join(' | '),
    );
  }
  return hits[0]!;
}

/* ── 夹具 ───────────────────────────────────────────────────────────── */

const FORM: QuestionForm = {
  id: 'surfaces',
  title: '还需要确认一件事',
  lang: 'zh-CN',
  questions: [
    {
      id: 'surfaces',
      label: '这次要覆盖哪几个端?',
      type: 'checkbox',
      options: [
        { label: '响应式网页(推荐)', value: 'web', description: '一套版式适配桌面和手机。' },
        { label: '桌面网页', value: 'desktop' },
      ],
    },
  ],
};

function mount(form: QuestionForm, submitted?: Record<string, string | string[]>): HTMLElement {
  const { container } = render(
    <I18nProvider initial="zh-CN">
      <div className="app">
        <div className={chatRootStyles.root} data-chat-root="">
          <div className="chat-log">
            <div className="msg assistant">
              <div className="prose-block">
                <QuestionFormView
                  form={form}
                  interactive
                  submittedAnswers={submitted}
                  onSubmit={() => {}}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </I18nProvider>,
  );
  return container;
}

/** 固定选项行(不含「自己填」那一颗 —— 它是 `.qf-chip-other`)。 */
function options(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('.qf-chip:not(.qf-chip-other)')];
}

/** 「自己填」那一项(收起态是 `<button>`,展开态是 `<div>`)。 */
function otherChip(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('.qf-chip-other');
  if (!el) throw new Error('没有「自己填」这一项 —— 夹具或组件变了,先修这里');
  return el;
}

/** 展开「自己填」,返回展开后那一行和它里面那颗勾选圈。 */
function expandOther(container: HTMLElement): { row: HTMLElement; box: HTMLElement } {
  fireEvent.click(otherChip(container));
  const row = otherChip(container);
  if (!row.classList.contains('qf-chip-on')) {
    throw new Error('「自己填」没展开 —— 它展开态才带 qf-chip-on');
  }
  const box = row.querySelector<HTMLElement>('.qf-chip-own-box');
  if (!box) throw new Error('展开态里没有 .qf-chip-own-box —— 组件结构变了,先修这里');
  return { row, box };
}

/* ── 稿子的原值(light,`8015870095` 的 `.opt` 一族) ─────────────────── */

/*
 * ⚠️ **400 是我们的现状,不是稿子的值。**
 *
 * 稿子 `8015870095:components.css:151-153` 的 `body { font-weight: 500 }` 是全局基线,
 * 而 `.opt` 一个字重都不写 —— 在稿子里它**继承 500**。我们这边基线另算,量出来是 400。
 *
 * 这条断言的作用是**钉住现状、并把偏差记在案**,不是宣称我们和稿子一致。
 * 产品字重基线已在 `0334a6599d` 抬到 500(chat 接缝层),`.qf-*` 一族的字面字重
 * 还没跟着复核 —— 那是一整批要一起动的活(见 W43 审计 §5 第 9 条),
 * 单独改这一格会和相邻几格打架。
 */
const OPT_WEIGHT = '400';
const OPT_WEIGHT_ON = '500'; // `.opt.is-on { font-weight: 500 }`(L1458)
const STALE_WEIGHT_ON = '600'; // 上一版稿子 `1bbdce0b06:1524` 的旧值,选项行已经不在这儿了
const BOX_HOVER = '#848484'; // `.opt:hover .box { border-color: var(--text-soft) }`(L1485)
const BOX_ON = 'transparent'; // `.opts.mod-* .opt.is-on .box { border-color: transparent }`

describe('① 选中的选项行照交付稿的 500,不是上一版稿子的 600', () => {
  it('防真空:解析器确实看得见全局原语那条 `button { font-weight: 500 }`', () => {
    // 它是「没选中 = 400」这一档真正要压的对手。解析器要是根本没读到
    // primitives.css,下面「没选中是 400」会在解析器瞎了的时候假绿。
    const container = mount(FORM);
    const sources = CSS.declaring(options(container)[0]!, 'font-weight').map((r) => r.selector);
    expect(sources).toContain('button');
  });

  it('防真空:没选中那一档确实是稿子的 400(比较的另一端不是空读数)', () => {
    const container = mount(FORM);
    const chip = options(container)[0]!;
    expect(chip.getAttribute('aria-checked')).toBe('false');
    expect(atRest(chip)['font-weight']).toBe(OPT_WEIGHT);
  });

  it('点中之后是 500', () => {
    const container = mount(FORM);
    fireEvent.click(options(container)[0]!);
    const on = options(container)[0]!;
    expect(on.getAttribute('aria-checked')).toBe('true');

    const weight = atRest(on)['font-weight'];
    expect(weight).not.toBe(STALE_WEIGHT_ON);
    expect(weight).toBe(OPT_WEIGHT_ON);
  });

  it('已提交表单里选中的那一项,同样是 500', () => {
    const container = mount(FORM, { surfaces: ['web'] });
    const on = options(container).find((chip) => chip.getAttribute('aria-checked') === 'true');
    expect(on).toBeDefined();
    expect(atRest(on!)['font-weight']).toBe(OPT_WEIGHT_ON);
  });

  it('边界:「自己填」那句标题仍停在 600(未迁移)—— 选项行那一改不许漏到它身上', () => {
    /*
     * ⚠️ **600 是我们的现状,不是稿子的值。上一版注释说反了,这里更正。**
     *
     * 交付稿 `8015870095:components.css:1536` 写的是
     * `.opt .own-l { display: block; font-weight: 500 }`;600 出自**上一版**
     * `1bbdce0b06:1524`。同一个 commit(`cac28b1a6f`)在隔壁把 `.opt.is-on`
     * 正确改成了 500,却在这里照旧稿钉死 600,还把它写成"稿子的值"。
     *
     * 这条断言的作用是**隔离**:选项行那一改不许漏到这句标题上。
     * 至于它自己该不该迁到 500 —— 要和 `.qf-*` 一族的字重一起复核(W43 §5 第 9 条),
     * 单独动它会和相邻几格打架。**迁移时这个数要跟着改成 500。**
     */
    const container = mount(FORM);
    const { row } = expandOther(container);
    const label = row.querySelector('.qf-own .qf-own-label');
    expect(label).not.toBeNull();
    expect(CSS.resolved(label!)['font-weight']).toBe('600');
  });
});

describe('② 「自己填」展开后,鼠标扫过不会把勾的描边描出来', () => {
  it('防真空:没选中的固定选项**确实**量得出 hover 描边(否则本组全是假绿)', () => {
    const container = mount(FORM);
    const pickable = options(container)[0]!;
    expect(pickable.getAttribute('aria-checked')).toBe('false');
    expect(whileHovering(pickable, pickable.querySelector('.qf-chip-box')!)['border-top-color']).toBe(
      BOX_HOVER,
    );
  });

  it('静息态那颗勾是无边的(照稿子 `.opts.mod-* .opt.is-on .box`)', () => {
    const container = mount(FORM);
    const { row, box } = expandOther(container);
    expect(atRest(row, box)['border-top-color']).toBe(BOX_ON);
  });

  it('鼠标扫过整行,那颗勾仍然无边', () => {
    const container = mount(FORM);
    const { row, box } = expandOther(container);
    const hovered = whileHovering(row, box)['border-top-color'];
    expect(hovered).not.toBe(BOX_HOVER);
    expect(hovered).toBe(BOX_ON);
  });

  it('护栏:选中那条的特异性**严格大于** hover 那条,不许打平靠源码顺序', () => {
    // 只盯色值挡不住回退成打平 —— 打平时色值仍然是对的(选中那条写在后面)。
    // 踩坑 25 栽的就是这一下,所以这里直接把大小关系钉死。
    const container = mount(FORM);
    const { row, box } = expandOther(container);
    fireEvent.mouseOver(row);
    expect(row.matches(':hover')).toBe(true);

    const hoverRule = soleRule(box, 'border-top-color', ':hover');
    const onRule = soleRule(box, 'border-top-color', 'qf-chip-on');
    expect(hoverRule.selector).toContain('.qf-chip-own-box');
    expect(onRule.selector).toContain('.qf-chip-own-box');
    expect(specificity(onRule.selector)).toBeGreaterThan(specificity(hoverRule.selector));
  });
});
