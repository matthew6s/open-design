/**
 * chat 用到的图标。**路径数据逐字取自设计稿**(`docs/design/chat-panel-next.html`),
 * 不手抄、不换库 —— 手抄一次就会和稿子漂移,后面再也对不上。
 *
 * 尺寸和颜色一律由 CSS 决定(`.ti > svg` / `.mk svg`),这里只给形状,
 * 所以每个图标都不写 width/height。
 *
 * 笔画则相反 —— 见 `STROKE_ICON` 的注释。
 *
 * 稿子里有**两族**字形,别把它们混成一族:描边的摊 `STROKE_ICON`,
 * 实心的摊 `FILL_ICON`(「新建」、失败记号、重试箭头)。两族各有各的判据,
 * 见 `tests/components/chat/icon-stroke-weight.test.tsx`。
 */
import type { ReactElement } from 'react';
import type { ToolKind } from '../../../runtime/chat/tool-kind';
import { REMIX_ICON_PATHS } from '../../remix-icon-paths';

/**
 * chat 描边图标的**笔画基线**。所有描边图标都摊开这一份。
 *
 * ## 为什么值在这里,不在一条全局 CSS 规则里
 *
 * 稿子(`docs/design/chat-panel-next.html` 第 476 行)是一条全局重置:
 *
 *     svg { stroke-width: 1.75px; stroke-linecap: round; stroke-linejoin: round; }
 *
 * 本仓库不能照搬这一条:CSS 声明**恒赢** SVG 表现属性(表现属性属于优先级更低的
 * "author presentational hints" 层),而 `apps/web/src` 里有 115 处写死的
 * `strokeWidth={…}`。一条全局 `svg { stroke-width }` 会把它们**全部**盖掉,
 * 而且是静默的。所以基线走表现属性:它只在「这枚图标自己没说」时生效,
 * 任何一条 CSS 规则想为某一格单独调粗细,照样能赢 —— 和稿子里
 * `.tk .ring { stroke-width: 1.5 }` 压过全局 1.75 是同一套层叠关系。
 *
 * 共享的 `components/Icon.tsx` 早就是这个写法(它的 `common` 里带
 * `strokeWidth` + 两个 round),这里跟的是仓库既有的路子,不是新发明。
 *
 * ## 1.75 是**用户单位**,不是设备像素
 *
 * SVG 的 `stroke-width` 跟着 viewBox 缩放。这一族都是 `0 0 24 24`,
 * 所以屏幕上实际画出来的粗细 = 1.75 × 显示边长 ÷ 24:
 *
 *     14px 的行首格   → 1.021px      11px 的折叠箭头 → 0.802px
 *     13px 的引用气泡 → 0.948px
 *
 * 三个数都和真机量稿子的结果逐值相同(无头 Chrome,`getComputedStyle().strokeWidth`
 * × `getScreenCTM().a`)。**不要**给它加 `vector-effect: non-scaling-stroke` ——
 * 稿子只在 `.ck` 和 `.tool .wifi` 两处钉了它,其余一律跟着缩放;钉上之后
 * 1.75 会变成 1.75 设备像素,比稿子粗 1.7 倍。
 *
 * 端头和拐角同样照稿子走 round:1px 以下的线,butt 端头会让笔画两头更淡,
 * miter 拐角在这个粗细上则会甩出毛刺。
 */
export const STROKE_ICON = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

/**
 * chat **填充**图标的基线。和 `STROKE_ICON` 是并列的两族,不是它的变体。
 *
 * 稿子里不是所有字形都描边:`729fa43ce7` 把「新建」那一格换成了实心节点字形
 * (`docs/design/chat-panel/src/body-components.html:909`),同族的还有失败记号和
 * 重试箭头。实心字形**上色靠 `fill`,压根没有 stroke** —— 把 `STROKE_ICON` 摊给
 * 它会得到 `fill="none"`(整枚看不见)外加一组永远画不出来的 `stroke-*`。
 *
 * 所以两族各有各的基线,共存而不互相拆台:
 *
 *   描边族 `fill="none"` + `stroke="currentColor"` + 1.75 那一套
 *   填充族 `fill="currentColor"`,**一个 stroke-* 都不带**
 *
 * 「一个都不带」是有意的:带着 `stroke-width` 却不描边是死属性,会让下一个人
 * 以为这一枚也吃 1.75、照着调却看不出任何变化。判据在
 * `tests/components/chat/icon-stroke-weight.test.tsx` —— 那里按族分别提问,
 * 并且把两族的**成员名单**也钉住,免得哪一格悄悄换族之后从此没人守。
 *
 * 尺寸和颜色仍然由 CSS 决定(`.icon > svg { width: 16px; color: … }`),
 * `currentColor` 让填充族跟着同一个 `color` 走,和描边族在一列里色号一致。
 */
export const FILL_ICON = {
  viewBox: '0 0 24 24',
  fill: 'currentColor',
  'aria-hidden': true,
} as const;

/** 读取 —— 眼睛 */
export const ReadIcon = (): ReactElement => (
  <svg {...STROKE_ICON}>
    <path d="M2 12s3.6-6.4 10-6.4S22 12 22 12s-3.6 6.4-10 6.4S2 12 2 12z" />
    <circle cx="12" cy="12" r="2.6" />
  </svg>
);

/**
 * 改写 —— 笔。**只归改写**,新建另有一枚(见 `CreateIcon`)。
 *
 * 设计 2026-09-02 在 `e8726686ae`(建成品)/ `b51302425b`(源文件)把「新建」
 * 换成了实心节点字形,同一行里的「改写」原样留着这支铅笔。两个 commit 的标题
 * 说的都是别的事,所以判据取的是**稿子里真实的字形**,不是说明文字。
 */
export const WriteIcon = (): ReactElement => (
  <svg {...STROKE_ICON}>
    <path d="M17 3a2.83 2.83 0 014 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
  </svg>
);

/**
 * 新建 —— 实心的「节点 + 加号」。
 *
 * 路径逐字取自稿子 `729fa43ce7`
 * (`docs/design/chat-panel/src/body-components.html:909`,建成品
 * `docs/design/chat-panel-next.html:5214`)。那一行里「新建」出现四次、字形完全相同,
 * 「改写」出现一次、仍是铅笔 —— 4 : 1 就是「这两格分家」的全部证据。
 *
 * ## 这枚字形不是「设计还在犹豫」
 *
 * 上一版稿子 `361b78253e` 里,四处「新建」**已经有一处**是这枚实心字形了
 * (`settings.html` 那一行),另外三处还是铅笔 —— 稿子当时自己是花的。所以
 * `b51302425b`「sync create-file icon source」不是改设计,是**把早就定下来的
 * 那一枚补齐到剩下三处**。计数就是证据:`361b78253e` 是 1 新 : 4 铅笔,
 * `729fa43ce7` 是 4 新 : 1 铅笔 —— 少掉的三支铅笔正好是那三处「新建」。
 *
 * ## 为什么没照抄 `xmlns`
 *
 * 稿子这枚 `<svg>` 上带 `xmlns="http://www.w3.org/2000/svg"`,同族其它图标没有。
 * 那是建成品从独立 svg 文件内联进来的残留,不是设计意图 —— React 挂到 HTML
 * 文档里的 `<svg>` 不需要它(HTML 解析器本来就把它放进 SVG 命名空间)。
 *
 * 这一枚走 `FILL_ICON` 而不是 `STROKE_ICON`:它是实心字形,`fill="none"` 会让它
 * 整枚消失。逐字节判据在 `tests/components/chat/w72-create-icon-glyph.test.tsx`。
 */
export const CreateIcon = (): ReactElement => (
  <svg {...FILL_ICON}>
    <path d="M2.5 7C2.5 9.48528 4.51472 11.5 7 11.5C9.48528 11.5 11.5 9.48528 11.5 7C11.5 4.51472 9.48528 2.5 7 2.5C4.51472 2.5 2.5 4.51472 2.5 7ZM2.5 17C2.5 19.4853 4.51472 21.5 7 21.5C9.48528 21.5 11.5 19.4853 11.5 17C11.5 14.5147 9.48528 12.5 7 12.5C4.51472 12.5 2.5 14.5147 2.5 17ZM12.5 17C12.5 19.4853 14.5147 21.5 17 21.5C19.4853 21.5 21.5 19.4853 21.5 17C21.5 14.5147 19.4853 12.5 17 12.5C14.5147 12.5 12.5 14.5147 12.5 17ZM9.5 7C9.5 8.38071 8.38071 9.5 7 9.5C5.61929 9.5 4.5 8.38071 4.5 7C4.5 5.61929 5.61929 4.5 7 4.5C8.38071 4.5 9.5 5.61929 9.5 7ZM9.5 17C9.5 18.3807 8.38071 19.5 7 19.5C5.61929 19.5 4.5 18.3807 4.5 17C4.5 15.6193 5.61929 14.5 7 14.5C8.38071 14.5 9.5 15.6193 9.5 17ZM19.5 17C19.5 18.3807 18.3807 19.5 17 19.5C15.6193 19.5 14.5 18.3807 14.5 17C14.5 15.6193 15.6193 14.5 17 14.5C18.3807 14.5 19.5 15.6193 19.5 17ZM16 11V8H13V6H16V3H18V6H21V8H18V11H16Z" />
  </svg>
);

/** 删除 —— 垃圾桶。删除不能继续复用「写入」的铅笔图标。 */
export const DeleteIcon = (): ReactElement => (
  <svg {...STROKE_ICON}>
    <path d="M4 7h16" />
    <path d="M9 7V4h6v3" />
    <path d="M6.5 7l.8 13h9.4l.8-13" />
    <path d="M10 11v5.5M14 11v5.5" />
  </svg>
);

/** 搜索 —— 放大镜(D23:搜索是一等类别,有自己的图标) */
export const SearchIcon = (): ReactElement => (
  <svg {...STROKE_ICON}>
    <circle cx="10.8" cy="10.8" r="6.8" />
    <path d="M20.5 20.5l-4.9-4.9" />
  </svg>
);

/** 执行 —— 命令提示符 */
export const ExecIcon = (): ReactElement => (
  <svg {...STROKE_ICON}>
    <path d="M4.5 6.5l5 5.5-5 5.5" />
    <path d="M12.5 18h7" />
  </svg>
);

/** 生成 —— 图片 */
export const ImageIcon = (): ReactElement => (
  <svg {...STROKE_ICON}>
    <rect x="3" y="4.5" width="18" height="15" rx="2" />
    <circle cx="8.6" cy="10" r="1.4" />
    <path d="M21 15.5L16 10.5 7.5 19" />
  </svg>
);

/**
 * 认不出类别时的兜底 —— 一个中性的「工具」记号(六边螺帽 + 中心孔)。
 *
 * 为什么不硬塞进已有的五类:归错比「我认不出来」更糟。把一次子 agent 调度画成
 * 「读取」是**谎报**,而这一格的全部作用就是让人一眼知道刚才干了哪一类事。
 * 为什么不留圆点:产品 2026-08-25 裁决「不许出现圆点,每一格都要能指到图标」——
 * 这推翻了交付稿的 `.ti:empty::before` 兜底。
 *
 * 笔画粗细、圆角、24 视框都跟着同族其它五枚走,放在一列里不会显得是外来的。
 */
export const ToolFallbackIcon = (): ReactElement => (
  <svg {...STROKE_ICON}>
    <path d="M12 3.2l7 4v9.6l-7 4-7-4V7.2l7-4z" />
    <circle cx="12" cy="12" r="2.6" />
  </svg>
);

/**
 * 折叠箭头。展开时由 CSS 旋转 180°,不换图标。
 *
 * 这一枚**自己给尺寸**(稿子 `.chev` 是 11px),所以在摊开基线之后再补 width/height。
 */
export const ChevronIcon = (): ReactElement => (
  <svg {...STROKE_ICON} width="11" height="11">
    <path d="M6 9l6 6 6-6" />
  </svg>
);

/**
 * 出错 —— 生图失败格在**轮次还没停**的时候摆的那枚(OPEND-2544)。
 *
 * ## 路径为什么从 `REMIX_ICON_PATHS` 取,不像同族那样写在这里
 *
 * 产品交付的 `error-warning-line.svg` 是 remix 图标集的 `error-warning-line`,
 * 而仓库**早就有**这一枚:`REMIX_ICON_PATHS['error-warning-line']` 的那条 `d`
 * 和交付件逐字节相同(#5517 起 remix 字形一律内联,打包版 `od://` 加载不了
 * url() 字体)。再抄一份进来就是同一条 380 字符的路径存两处,以后 remix 升版
 * 只会改到其中一处 —— 这一族的文件头写着「不手抄」,正是同一条理由。
 *
 * 表里查不到时 `d` 会是 `undefined`,`<path>` 静默消失、组件不报错,
 * 所以这一枚由 `image-fail-cell-two-states.test.tsx` 逐字节钉住那条 `d`。
 *
 * ## 为什么不直接用共享的 `<Icon name="alert-triangle">`
 *
 * 那个名字映射到的确实是这一枚,但**名字是骗人的**(它画的是圆形感叹号,
 * 不是三角),而且 `Icon` 会挂上 `od-icon` —— 全仓约 35 条选择器盯着这个类,
 * 把它带进执行记录里等于给这一格开一扇没人预料的样式后门。
 */
export const FailIcon = (): ReactElement => (
  <svg {...FILL_ICON}>
    <path d={REMIX_ICON_PATHS['error-warning-line']} />
  </svg>
);

/** 重试 —— 生图失败格上那枚 */
export const RetryIcon = (): ReactElement => (
  <svg {...FILL_ICON}>
    <path d="M5.46257 4.43262C7.21556 2.91688 9.5007 2 12 2C17.5228 2 22 6.47715 22 12C22 14.1361 21.3302 16.1158 20.1892 17.7406L17 12H20C20 7.58172 16.4183 4 12 4C9.84982 4 7.89777 4.84827 6.46023 6.22842L5.46257 4.43262ZM18.5374 19.5674C16.7844 21.0831 14.4993 22 12 22C6.47715 22 2 17.5228 2 12C2 9.86386 2.66979 7.88416 3.8108 6.25944L7 12H4C4 16.4183 7.58172 20 12 20C14.1502 20 16.1022 19.1517 17.5398 17.7716L18.5374 19.5674Z" />
  </svg>
);

/**
 * 调色盘 —— 「设计系统工作区 · 自动创建」那张状态卡左边那一格。
 *
 * 路径逐字取自稿子 `729fa43ce7`
 * (`docs/design/chat-panel/src/body-components.html:47`,建成品
 * `docs/design/chat-panel-next.html:4352` 与它逐字节相同)。
 *
 * 走 `FILL_ICON`:稿子这枚写的就是 `fill="currentColor"` 的实心字形,
 * 摊 `STROKE_ICON` 会得到 `fill="none"`,整枚看不见。
 *
 * ## 两处**没有**照抄
 *
 * · `xmlns` —— 建成品从独立 svg 文件内联进来的残留(`CreateIcon` 同款理由):
 *   React 挂到 HTML 文档里的 `<svg>` 不需要它。
 * · `focusable="false"` —— 那是 IE / 旧 Edge 时代给 `<svg>` 挡 Tab 的补丁;
 *   这一族里没有第二枚带它,而且外层那个 `aria-hidden` 的格子已经把它挡在
 *   辅助技术之外了。
 *
 * ⚠️ 它**不是** `ToolKind` 的一员,所以不进 `toolIcon()`,也不属于
 * `icon-stroke-weight.test.tsx` 里 `DESIGN_FILL_KINDS` 那份名单 ——
 * 那份名单钉的是「行首那一格里谁走填充」,和这枚卡片图标是两件事。
 */
export const PaletteIcon = (): ReactElement => (
  <svg {...FILL_ICON}>
    <path d="M12 2C17.5222 2 22 5.97778 22 10.8889C22 13.9556 19.5111 16.4444 16.4444 16.4444H14.4778C13.5556 16.4444 12.8111 17.1889 12.8111 18.1111C12.8111 18.5333 12.9778 18.9222 13.2333 19.2111C13.5 19.5111 13.6667 19.9 13.6667 20.3333C13.6667 21.2556 12.9 22 12 22C6.47778 22 2 17.5222 2 12C2 6.47778 6.47778 2 12 2ZM10.8111 18.1111C10.8111 16.0843 12.451 14.4444 14.4778 14.4444H16.4444C18.4065 14.4444 20 12.851 20 10.8889C20 7.1392 16.4677 4 12 4C7.58235 4 4 7.58235 4 12C4 16.19 7.2226 19.6285 11.324 19.9718C10.9948 19.4168 10.8111 18.7761 10.8111 18.1111ZM7.5 12C6.67157 12 6 11.3284 6 10.5C6 9.67157 6.67157 9 7.5 9C8.32843 9 9 9.67157 9 10.5C9 11.3284 8.32843 12 7.5 12ZM16.5 12C15.6716 12 15 11.3284 15 10.5C15 9.67157 15.6716 9 16.5 9C17.3284 9 18 9.67157 18 10.5C18 11.3284 17.3284 12 16.5 12ZM12 9C11.1716 9 10.5 8.32843 10.5 7.5C10.5 6.67157 11.1716 6 12 6C12.8284 6 13.5 6.67157 13.5 7.5C13.5 8.32843 12.8284 9 12 9Z" />
  </svg>
);

/**
 * 「这件事过了」那枚勾。**不用 svg**:设计稿把它做成了一整张图
 * (`--chat-tick-img`,盘绿勾挖空),这样深浅两套主题不用各挑一个勾色。
 * 全稿凡是「过了」的记号(折叠块行首、Plan 里打完勾的一步、Plan 卡头)都指同一张图。
 */
export const TICK_IMAGE_VAR = 'var(--chat-tick-img)';

/**
 * 工具类别 → 图标。**每一类都有,永远不返回 null**。
 *
 * 交付稿的兜底是空格子画一颗 5px 圆点;产品 2026-08-25 裁决不许出现圆点,
 * 所以「认不出来」那一档也给图标(`ToolFallbackIcon`)。
 * 相应地 `record.module.css` 里那条 `.icon:empty::before` 已经撤掉 ——
 * 留着会变成一条永远走不到的死规则,以后有人加了新类别忘了配图标,
 * 圆点会悄悄回来(所以改由 `tool-icon.test.tsx` 逐类断言守着)。
 */
export function toolIcon(kind: ToolKind): ReactElement {
  switch (kind) {
    case 'read': return <ReadIcon />;
    /* 新建和改写**不共用图标** —— 稿子 729fa43ce7 只换了新建那一格(W72) */
    case 'write': return <CreateIcon />;
    case 'edit': return <WriteIcon />;
    case 'delete': return <DeleteIcon />;
    case 'search': return <SearchIcon />;
    case 'exec': return <ExecIcon />;
    case 'image': return <ImageIcon />;
    default: return <ToolFallbackIcon />;
  }
}
