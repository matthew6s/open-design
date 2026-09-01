/**
 * 正文取词(设计稿组件 23)的**纯判据**。
 *
 * 放在这一层是为了能脱离 DOM 测:浮条翻不翻面、选中的字要不要收、
 * 多段选择怎么合并计数 —— 这些都是规则,不是画法。
 */

/** 一条被「添加到对话」的引用 */
export interface ChatQuote {
  id: string;
  /** 选中的原文(已折叠空白) */
  text: string;
  /** 出自哪条助手消息 —— 之后要回跳定位就靠它 */
  messageId: string;
}

/**
 * 浮条摆在选区上方还是下方。
 *
 * 默认跟在选区下方；只有下方被 composer 挤住时才翻到上方。
 * 判据是**下方放不下就翻**,不是「离底多少像素」这种拍脑袋的阈值 ——
 * 浮条自己的高度 + 和选区之间那 7px 缝就是它需要的空间。
 */
export function quoteBarPlacement(input: {
  /** 选区矩形的上边(视口坐标) */
  selectionTop: number;
  /** 聊天面板可视区的上边(视口坐标) */
  panelTop: number;
  /** 选区矩形的下边；提供它与 panelBottom 后可避开底部 composer */
  selectionBottom?: number;
  /** 聊天日志可视区的下边（即 composer 上沿） */
  panelBottom?: number;
  /** 浮条高度,默认按稿子的 3px 内距 + 28px 按钮算 */
  barHeight?: number;
  /** 浮条与选区之间的缝,稿子是 7px */
  gap?: number;
}): 'above' | 'below' {
  const bar = input.barHeight ?? 34;
  const gap = input.gap ?? 7;
  const needed = bar + gap;
  const availableAbove = input.selectionTop - input.panelTop;
  if (input.panelBottom == null || input.selectionBottom == null) return 'below';
  const availableBelow = input.panelBottom - input.selectionBottom;
  if (availableBelow >= needed) return 'below';
  if (availableAbove >= needed) return 'above';
  return availableBelow >= availableAbove ? 'below' : 'above';
}

export function quoteBarPosition(input: {
  selectionLeft: number;
  selectionRight: number;
  selectionTop: number;
  selectionBottom: number;
  panelLeft: number;
  panelRight: number;
  panelTop: number;
  panelBottom: number;
  barWidth?: number;
  barHeight?: number;
  gap?: number;
  edgeInset?: number;
}): { left: number; top: number; placement: 'above' | 'below' } {
  const barWidth = input.barWidth ?? 112;
  const barHeight = input.barHeight ?? 34;
  const gap = input.gap ?? 7;
  const edge = input.edgeInset ?? 8;
  const placement = quoteBarPlacement({
    selectionTop: input.selectionTop,
    selectionBottom: input.selectionBottom,
    panelTop: input.panelTop,
    panelBottom: input.panelBottom,
    barHeight,
    gap,
  });

  const center = (input.selectionLeft + input.selectionRight) / 2;
  const minLeft = input.panelLeft + edge + barWidth / 2;
  const maxLeft = input.panelRight - edge - barWidth / 2;
  const left = maxLeft < minLeft
    ? (input.panelLeft + input.panelRight) / 2
    : Math.min(Math.max(center, minLeft), maxLeft);

  const desiredTop = placement === 'above'
    ? input.selectionTop - gap
    : input.selectionBottom + gap;
  const minTop = placement === 'above'
    ? input.panelTop + edge + barHeight
    : input.panelTop + edge;
  const maxTop = placement === 'above'
    ? input.panelBottom - edge
    : input.panelBottom - edge - barHeight;
  const top = maxTop < minTop
    ? (minTop + maxTop) / 2
    : Math.min(Math.max(desiredTop, minTop), maxTop);

  return { left, top, placement };
}

/**
 * 选中的文字规整成一条引用的正文。
 *
 * 跨行选择会带进换行和缩进,原样塞进输入框既难读也难比对;
 * 折成单行、掐掉首尾空白就够 —— 全文在 hover 的浮层里能看到(稿子第 23-4 格)。
 */
export function normalizeQuoteText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** 值得添加吗:空白、或者只选中了一两个字符,都不值得占一枚芯片 */
export function isQuotable(raw: string): boolean {
  return normalizeQuoteText(raw).length >= 2;
}

/**
 * 同一段话被选两次不重复入列 —— 判据是**规整之后的正文**,
 * 不是选区对象(同一句话第二次选,DOM Range 是新的,文字是同一句)。
 */
export function appendQuote(quotes: ChatQuote[], next: ChatQuote): ChatQuote[] {
  const key = normalizeQuoteText(next.text);
  if (quotes.some((q) => normalizeQuoteText(q.text) === key)) return quotes;
  return [...quotes, next];
}

/**
 * 发送时折进正文的那段**引文前缀**(设计稿组件 23)。
 *
 * 折进去是为了让 agent 一眼分得清「这是我上一轮说的话」和「这是新指令」;
 * 但折完之后这一条在结构上就没有引用了 —— 排进发送队列的就是这段散文。
 * 所以取回编辑时得能原样拆开,而**拆的一方必须和折的一方用同一个前缀**。
 * 两边各写各的字符串,早晚会对不上,那时候拆出来的正文会被啃掉一截,
 * 现场只剩「用户的字莫名少了半句」这一个症状。
 */
export function quotePromptPrefix(quotes: ChatQuote[]): string {
  if (quotes.length === 0) return '';
  return `${quotes.map((q) => `> ${q.text}`).join('\n')}\n\n`;
}

/**
 * `quotePromptPrefix` 的逆运算,而且**只在完全对得上时才动手**。
 *
 * 对不上就原样返回。这不是保守,是唯一安全的选择:队列里的正文是可以被改的
 * (就地编辑那条路),用户自己也可能敲出以 `> ` 开头的行。拆错一次就是把
 * 用户写的话啃掉一截,比多留一段引文糟得多 —— 后者看得见,前者看不见。
 */
export function splitQuotedPrompt(prompt: string, quotes: ChatQuote[]): string {
  const prefix = quotePromptPrefix(quotes);
  if (!prefix) return prompt;
  if (prompt.startsWith(prefix)) return prompt.slice(prefix.length);
  // 只有引用、没有正文的那一发:`submit()` 收尾的 trim 会把末尾那个空行吃掉,
  // 于是整条正文正好等于前缀去掉尾部空白。这时候正文本来就是空的。
  if (prompt === prefix.trimEnd()) return '';
  return prompt;
}
