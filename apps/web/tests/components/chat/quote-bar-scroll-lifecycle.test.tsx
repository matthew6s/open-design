// @vitest-environment jsdom
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QuoteBar } from '../../../src/components/chat/QuoteBar';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
  it('会在会话容器开始滚动时关闭，并等待下一次 selectionchange 才重新出现', () => {
    render(<QuoteBarHarness />);
    const scope = screen.getByTestId('chat-scroll-scope');
    vi.spyOn(scope, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 480, 640));

    const textNode = scope.querySelector('p')?.firstChild;
    if (!textNode) throw new Error('missing selectable message text');
    const range = document.createRange();
    range.selectNodeContents(textNode);
    vi.spyOn(range, 'getBoundingClientRect').mockReturnValue(rect(120, 180, 160, 24));
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => range,
      toString: () => '添加到对话的选中文案',
    } as unknown as Selection);

    fireEvent(document, new Event('selectionchange'));
    expect(screen.getByTestId('chat-quote-bar')).toBeInTheDocument();

    // scroll 不冒泡；QuoteBar 必须从捕获阶段覆盖滚轮、触控板、滚动条和程序化滚动。
    fireEvent.scroll(scope);
    expect(screen.queryByTestId('chat-quote-bar')).not.toBeInTheDocument();

    fireEvent(document, new Event('selectionchange'));
    expect(screen.getByTestId('chat-quote-bar')).toBeInTheDocument();
  });
});
