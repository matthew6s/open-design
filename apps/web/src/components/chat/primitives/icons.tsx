/**
 * chat 用到的图标。**路径数据逐字取自设计稿**(`docs/design/chat-panel-next.html`),
 * 不手抄、不换库 —— 手抄一次就会和稿子漂移,后面再也对不上。
 *
 * 尺寸和颜色一律由 CSS 决定(`.ti > svg` / `.mk svg`),这里只给形状,
 * 所以每个图标都不写 width/height。
 *
 * 笔画则相反 —— 见 `STROKE_ICON` 的注释。
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

/** 读取 —— 眼睛 */
export const ReadIcon = (): ReactElement => (
  <svg {...STROKE_ICON}>
    <path d="M2 12s3.6-6.4 10-6.4S22 12 22 12s-3.6 6.4-10 6.4S2 12 2 12z" />
    <circle cx="12" cy="12" r="2.6" />
  </svg>
);

/** 新建 / 改写 —— 笔 */
export const WriteIcon = (): ReactElement => (
  <svg {...STROKE_ICON}>
    <path d="M17 3a2.83 2.83 0 014 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
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
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d={REMIX_ICON_PATHS['error-warning-line']} />
  </svg>
);

/** 重试 —— 生图失败格上那枚 */
export const RetryIcon = (): ReactElement => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M5.46257 4.43262C7.21556 2.91688 9.5007 2 12 2C17.5228 2 22 6.47715 22 12C22 14.1361 21.3302 16.1158 20.1892 17.7406L17 12H20C20 7.58172 16.4183 4 12 4C9.84982 4 7.89777 4.84827 6.46023 6.22842L5.46257 4.43262ZM18.5374 19.5674C16.7844 21.0831 14.4993 22 12 22C6.47715 22 2 17.5228 2 12C2 9.86386 2.66979 7.88416 3.8108 6.25944L7 12H4C4 16.4183 7.58172 20 12 20C14.1502 20 16.1022 19.1517 17.5398 17.7716L18.5374 19.5674Z" />
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
    case 'write':
    case 'edit': return <WriteIcon />;
    case 'delete': return <DeleteIcon />;
    case 'search': return <SearchIcon />;
    case 'exec': return <ExecIcon />;
    case 'image': return <ImageIcon />;
    default: return <ToolFallbackIcon />;
  }
}
