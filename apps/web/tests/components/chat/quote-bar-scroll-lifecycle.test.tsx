// @vitest-environment jsdom
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QuoteBar } from '../../../src/components/chat/QuoteBar';

const originalResizeObserver = globalThis.ResizeObserver;
const resizeCallbacks: ResizeObserverCallback[] = [];

beforeEach(() => {
  resizeCallbacks.length = 0;
  class ResizeObserverMock {
    constructor(callback: ResizeObserverCallback) {
      resizeCallbacks.push(callback);
    }
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
  };
}

function QuoteBarHarness() {
  const scopeRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={scopeRef} data-testid="chat-scroll-scope">
        <p data-message-id="assistant-1">一段可以添加到对话的选中文案</p>
      </div>
      <QuoteBar scopeRef={scopeRef} onQuote={vi.fn()} />
    </>
  );
}

describe('Add to chat 选区浮层的滚动生命周期', () => {
  function selectText(options: {
    scopeBottom?: number;
    selectionTop?: number;
    selectionBottom?: number;
  } = {}) {
    render(<QuoteBarHarness />);
    const scope = screen.getByTestId('chat-scroll-scope');
    const geometry = {
      scopeBottom: options.scopeBottom ?? 640,
      selectionTop: options.selectionTop ?? 180,
      selectionBottom: options.selectionBottom ?? 204,
    };
    vi.spyOn(scope, 'getBoundingClientRect').mockImplementation(
      () => rect(0, 0, 480, geometry.scopeBottom),
    );

    const textNode = scope.querySelector('p')?.firstChild;
    if (!textNode) throw new Error('missing selectable message text');
    const range = document.createRange();
    range.selectNodeContents(textNode);
    vi.spyOn(range, 'getBoundingClientRect').mockImplementation(
      () => rect(120, geometry.selectionTop, 160, geometry.selectionBottom - geometry.selectionTop),
    );
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => range,
      toString: () => '添加到对话的选中文案',
    } as unknown as Selection);

    fireEvent(document, new Event('selectionchange'));
    expect(screen.getByTestId('chat-quote-bar')).toBeInTheDocument();
    return { geometry, scope };
  }

  it('保留没有改变 chat viewport / Range 几何的 nested 或 no-op scroll', () => {
    const { scope } = selectText();

    // scroll 是捕获阶段的全页信号；如果 log 与选区都没动，它不能把仍在原位的操作浮层关掉。
    fireEvent.scroll(scope);
    expect(screen.getByTestId('chat-quote-bar')).toBeInTheDocument();
  });

  it('chat viewport 真正位移时关闭，并等待下一次 selectionchange 才重新出现', () => {
    const { scope } = selectText();

    scope.scrollTop = 48;
    fireEvent.scroll(scope);
    expect(screen.queryByTestId('chat-quote-bar')).not.toBeInTheDocument();

    fireEvent(document, new Event('selectionchange'));
    expect(screen.getByTestId('chat-quote-bar')).toBeInTheDocument();
  });

  it('queue / composer 改变 log 可用高度但没有 scroll 时重新翻面', () => {
    const { geometry } = selectText({
      scopeBottom: 640,
      selectionTop: 570,
      selectionBottom: 594,
    });
    expect(screen.getByTestId('chat-quote-bar')).toHaveAttribute('data-placement', 'below');

    geometry.scopeBottom = 600;
    expect(resizeCallbacks).toHaveLength(1);
    act(() => {
      resizeCallbacks[0]!([], {} as ResizeObserver);
    });

    expect(screen.getByTestId('chat-quote-bar')).toHaveAttribute('data-placement', 'above');
  });
});
