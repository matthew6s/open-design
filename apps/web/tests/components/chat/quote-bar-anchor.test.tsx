// @vitest-environment jsdom
/**
 * 取词浮条**贴不贴得住选中的那几个字**(设计稿组件 23-1 / 23-2)。
 *
 * 现场缺陷:在「执行计划」的展开列表里选中一行,浮条掉到了几百像素以下的
 * 「运行…」那一行上、几乎压到输入框。两条独立的原因叠在一起:
 *
 * 1. 稿子的默认是**朝上**(`.selbar { bottom: calc(100% + 7px) }`),
 *    翻面才朝下(`.selbar.mod-below { top: calc(100% + 6px) }`);产品反了。
 * 2. 定位读的是 `Range.getBoundingClientRect()` —— 那是**所有** client rect 的并集,
 *    包含选区末端那个**零宽**的光标矩形。拖选稍微过界一点,末端会落在下一个
 *    区块的行首:屏幕上什么都没高亮,并集的下沿却已经跑到那一行去了。
 *
 * 所以这一组问的是同一件事的两半:浮条贴的必须是**看得见的**那块选区矩形。
 */
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QuoteBar } from '../../../src/components/chat/QuoteBar';

const originalResizeObserver = globalThis.ResizeObserver;

beforeEach(() => {
  class ResizeObserverMock {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }
  globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  globalThis.ResizeObserver = originalResizeObserver;
});

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

function unionOf(rects: DOMRect[]): DOMRect {
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  return rect(left, top, right - left, bottom - top);
}

function Harness() {
  const scopeRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={scopeRef} data-testid="chat-scroll-scope">
        <p data-message-id="assistant-1">执行计划里的一行文案</p>
      </div>
      <QuoteBar scopeRef={scopeRef} onQuote={vi.fn()} />
    </>
  );
}

/**
 * `panel` 是 chat-log 可视区,`rects` 是选区的 client rect 列表
 * (顺序即文档顺序,零宽的那些就是末端光标位置)。
 */
function selectWithClientRects(panel: DOMRect, rects: DOMRect[]) {
  render(<Harness />);
  const scope = screen.getByTestId('chat-scroll-scope');
  vi.spyOn(scope, 'getBoundingClientRect').mockImplementation(() => panel);

  const textNode = scope.querySelector('p')?.firstChild;
  if (!textNode) throw new Error('missing selectable message text');
  const range = document.createRange();
  range.selectNodeContents(textNode);
  vi.spyOn(range, 'getClientRects').mockImplementation(
    () => rects as unknown as DOMRectList,
  );
  vi.spyOn(range, 'getBoundingClientRect').mockImplementation(() => unionOf(rects));
  vi.spyOn(window, 'getSelection').mockReturnValue({
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => range,
    toString: () => '执行计划里的一行文案',
  } as unknown as Selection);

  fireEvent(document, new Event('selectionchange'));
  const bar = screen.getByTestId('chat-quote-bar');
  return {
    bar,
    top: Number.parseFloat(bar.style.top),
    left: Number.parseFloat(bar.style.left),
    placement: bar.getAttribute('data-placement'),
  };
}

describe('取词浮条紧贴选中的那几个字', () => {
  /*
   * 稿子 23-1:上方放得下就朝上,7px 缝。产品原来默认朝下 —— 于是浮条挡住
   * 用户接着要读的下一行,而且一旦并集的下沿跑远,它就跟着跑远。
   */
  it('上方放得下时朝上,离选中行 7px', () => {
    const line = rect(120, 300, 200, 24);
    const { top, placement } = selectWithClientRects(rect(0, 100, 480, 800), [line]);
    expect(placement).toBe('above');
    // transform 是 translate(-50%, -100%),所以 top 就是浮条的下沿
    expect(top).toBe(293);
  });

  /*
   * 现场那一发。选中的是 y=300 那一行,但拖选末端落在了下面「运行…」行的行首,
   * 留下一个零宽矩形(屏幕上没有任何高亮)。并集的下沿因此是 820 ——
   * 浮条原来就贴着它,于是掉到输入框上沿。
   */
  it('末端那个零宽光标矩形不能把浮条拽到几百像素以下', () => {
    const visibleLine = rect(120, 300, 200, 24);
    const trailingCaret = rect(40, 800, 0, 20); // 「运行…」那一行的行首
    const { top, left, placement } = selectWithClientRects(
      rect(0, 100, 480, 800),
      [visibleLine, trailingCaret],
    );
    expect(placement).toBe('above');
    expect(top).toBe(293);
    // 居中也只认看得见的那块:并集会把中心拉到 180(40..320)
    expect(left).toBe(220);
  });

  /*
   * 稿子 23-2:只有上方顶到面板边才翻下去,而且是 6px 不是 7px。
   * 翻下去之后贴的必须是**末行**矩形的下沿,同样不能被零宽矩形拽走。
   */
  it('选区贴着面板顶边才翻到下方,离选中行 6px', () => {
    const visibleLine = rect(120, 110, 200, 24);
    const trailingCaret = rect(40, 800, 0, 20);
    const { top, placement } = selectWithClientRects(
      rect(0, 100, 480, 800),
      [visibleLine, trailingCaret],
    );
    expect(placement).toBe('below');
    expect(top).toBe(140);
  });
});
