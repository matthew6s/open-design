/**
 * 正文取词的纯判据。这一层不碰 DOM,所以能把规则一条条钉死。
 */
import { describe, expect, it } from 'vitest';
import {
  appendQuote,
  isQuotable,
  normalizeQuoteText,
  quoteBarPlacement,
  quoteBarPosition,
  quotePromptPrefix,
  splitQuotedPrompt,
} from '../../../src/runtime/chat/quote-selection';

describe('浮条翻面(稿子 23-1 / 23-2)', () => {
  it('上方放得下就摆上方', () => {
    expect(quoteBarPlacement({ selectionTop: 400, panelTop: 100 })).toBe('above');
  });

  it('选区贴着面板顶边,上方放不下,翻到下方', () => {
    expect(quoteBarPlacement({ selectionTop: 110, panelTop: 100 })).toBe('below');
  });

  it('判据是「浮条高度 + 那道缝」,不是拍脑袋的阈值', () => {
    // 正好差一像素放不下 → 翻
    expect(quoteBarPlacement({ selectionTop: 140, panelTop: 100, barHeight: 34, gap: 7 })).toBe('below');
    // 正好放得下 → 不翻
    expect(quoteBarPlacement({ selectionTop: 141, panelTop: 100, barHeight: 34, gap: 7 })).toBe('above');
  });

  it('选区贴着 composer 时下方放不下,保持在上方', () => {
    expect(quoteBarPlacement({
      selectionTop: 450,
      selectionBottom: 480,
      panelTop: 100,
      panelBottom: 500,
    })).toBe('above');
  });

  it('上下都放不下时选择空间更大的一侧', () => {
    expect(quoteBarPlacement({
      selectionTop: 115,
      selectionBottom: 130,
      panelTop: 100,
      panelBottom: 170,
    })).toBe('below');
  });
});

describe('浮条位置夹取', () => {
  it('靠左右边选择时把完整浮条夹在聊天栏内', () => {
    const left = quoteBarPosition({
      selectionLeft: 100,
      selectionRight: 120,
      selectionTop: 300,
      selectionBottom: 320,
      panelLeft: 100,
      panelRight: 400,
      panelTop: 100,
      panelBottom: 500,
      barWidth: 120,
    });
    const right = quoteBarPosition({
      selectionLeft: 380,
      selectionRight: 400,
      selectionTop: 300,
      selectionBottom: 320,
      panelLeft: 100,
      panelRight: 400,
      panelTop: 100,
      panelBottom: 500,
      barWidth: 120,
    });
    expect(left.left).toBe(168);
    expect(right.left).toBe(332);
  });

  it('底部选区的浮条坐标不会落进 composer 一侧', () => {
    const position = quoteBarPosition({
      selectionLeft: 180,
      selectionRight: 260,
      selectionTop: 450,
      selectionBottom: 480,
      panelLeft: 100,
      panelRight: 400,
      panelTop: 100,
      panelBottom: 500,
      barHeight: 34,
    });
    expect(position.placement).toBe('above');
    expect(position.top).toBeLessThan(480);
  });
});

describe('选中的文字', () => {
  it('跨行选择折成单行', () => {
    expect(normalizeQuoteText('商品卡已经\n  抽成共享组件 ')).toBe('商品卡已经 抽成共享组件');
  });

  it('空白和一两个字符不值得占一枚芯片', () => {
    expect(isQuotable('   ')).toBe(false);
    expect(isQuotable('好')).toBe(false);
    expect(isQuotable('好的')).toBe(true);
  });
});

describe('入列', () => {
  const q = (id: string, text: string) => ({ id, text, messageId: 'm1' });

  it('同一段话选两次只进一条 —— 判据是规整后的正文,不是 Range 对象', () => {
    const once = appendQuote([], q('a', '商品卡已经抽成共享组件'));
    const twice = appendQuote(once, q('b', '  商品卡已经抽成共享组件 '));
    expect(twice).toHaveLength(1);
    expect(twice[0]?.id).toBe('a');
  });

  it('不同的段落各占一条(稿子 23-5:只是数字变)', () => {
    let list = appendQuote([], q('a', '第一段'));
    list = appendQuote(list, q('b', '第二段'));
    list = appendQuote(list, q('c', '第三段'));
    expect(list).toHaveLength(3);
  });
});

/**
 * 引用在**发送时**被折进正文(`> 原文` 的 markdown 引用块),在**取回编辑时**
 * 要原样拆出来。这一对必须由同一个函数定义前缀,否则两边各写各的、
 * 早晚对不上 —— 那时候拆出来的正文会被啃掉一截,还没人看得出为什么。
 */
describe('引用折进正文 / 从正文拆回来', () => {
  const q = (id: string, text: string) => ({ id, text, messageId: 'm1' });

  it('没有引用就没有前缀,正文一个字都不动', () => {
    expect(quotePromptPrefix([])).toBe('');
    expect(splitQuotedPrompt('把首屏文案改短一点', [])).toBe('把首屏文案改短一点');
  });

  it('折进去再拆回来,拿到的还是原来那段正文', () => {
    const quotes = [q('a', '商品卡已经抽成共享组件'), q('b', '第二段')];
    const folded = `${quotePromptPrefix(quotes)}把首屏文案改短一点`;
    // 折出来的确实是 markdown 引用块 —— agent 靠它区分「我上轮说的」和「新指令」。
    expect(folded).toBe('> 商品卡已经抽成共享组件\n> 第二段\n\n把首屏文案改短一点');
    expect(splitQuotedPrompt(folded, quotes)).toBe('把首屏文案改短一点');
  });

  it('前缀对不上就一个字都不拆 —— 宁可多留一段引文,也不能啃掉用户的正文', () => {
    const quotes = [q('a', '商品卡已经抽成共享组件')];
    // 用户把队列里那条话改过了,开头已经不是我们折进去的那一段。
    const edited = '> 我自己敲的引用\n\n把首屏文案改短一点';
    expect(splitQuotedPrompt(edited, quotes)).toBe(edited);
  });

  it('正文本身就以 `> ` 开头也不会被误伤', () => {
    const plain = '> 这一行是用户自己敲的';
    expect(splitQuotedPrompt(plain, [])).toBe(plain);
  });

  it('只选了引用、一个字没敲:发送那头的收尾 trim 会吃掉末尾空行,照样拆得干净', () => {
    const quotes = [q('a', '商品卡已经抽成共享组件')];
    // `submit()` 的写法是 `${prefix}${draft.trim()}`.trim() —— 正文为空时
    // 末尾那个 `\n\n` 被 trim 掉了,于是整条正文正好等于前缀去掉尾部空白。
    const folded = `${quotePromptPrefix(quotes)}`.trim();
    expect(folded).toBe('> 商品卡已经抽成共享组件');
    // 拆出来必须是空字符串 —— 拆不掉的话这段引文会在输入框里和芯片重复一遍。
    expect(splitQuotedPrompt(folded, quotes)).toBe('');
  });
});
