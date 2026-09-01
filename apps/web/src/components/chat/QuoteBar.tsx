/**
 * 选区浮条(设计稿组件 23 · 第 65 / 66 格)。
 *
 * 在助手正文里选中一段话,这条浮条浮在选区**下方、水平居中**;
 * 下方被 composer 挤住时翻到上方(判据在 `runtime/chat/quote-selection.ts`,能脱离 DOM 测)。
 *
 * 为什么用 `position: fixed` 而不是稿子的 `absolute`:稿子把浮条画在
 * `<mark class="sel">` 里面 —— 那是静态稿唯一能摆的方式。真实的选区是 DOM Range,
 * 没法给它包一层标签,所以按选区矩形定位。位置一样,承载方式不同。
 */
import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { useT } from '../../i18n';
import { isQuotable, normalizeQuoteText, quoteBarPosition } from '../../runtime/chat/quote-selection';
import styles from './QuoteBar.module.css';

export interface QuoteBarProps {
  /** 只在这个容器里的选区才算数 —— 输入框、侧栏里的选中不该弹这条 */
  scopeRef: React.RefObject<HTMLElement | null>;
  /** 「添加到对话」 */
  onQuote: (text: string, messageId: string | null) => void;
  /** 有效正文选区会临时暂停 chat 的流式追尾，避免下一 token 把选区滚走。 */
  onSelectionActivityChange?: (active: boolean) => void;
}

interface BarState {
  left: number;
  top: number;
  placement: 'above' | 'below';
  text: string;
  messageId: string | null;
  measuredWidth: number;
  measuredHeight: number;
}

interface SelectionGeometry {
  range: Range;
  rangeRect: DOMRect;
  panelRect: DOMRect;
  scrollTop: number;
  text: string;
}

const DEFAULT_BAR_WIDTH = 112;
const DEFAULT_BAR_HEIGHT = 34;
const GEOMETRY_EPSILON = 0.5;

function readSelectionGeometry(scope: HTMLElement): SelectionGeometry | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!scope.contains(range.commonAncestorContainer)) return null;
  const text = normalizeQuoteText(selection.toString());
  if (!isQuotable(text)) return null;
  const rangeRect = range.getBoundingClientRect();
  if (rangeRect.width === 0 && rangeRect.height === 0) return null;
  return {
    range,
    rangeRect,
    panelRect: scope.getBoundingClientRect(),
    scrollTop: scope.scrollTop,
    text,
  };
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < GEOMETRY_EPSILON;
}

function sameVisibleGeometry(a: SelectionGeometry, b: SelectionGeometry): boolean {
  return (
    near(a.scrollTop, b.scrollTop) &&
    near(a.panelRect.left, b.panelRect.left) &&
    near(a.panelRect.top, b.panelRect.top) &&
    near(a.panelRect.right, b.panelRect.right) &&
    near(a.panelRect.bottom, b.panelRect.bottom) &&
    near(a.rangeRect.left, b.rangeRect.left) &&
    near(a.rangeRect.top, b.rangeRect.top) &&
    near(a.rangeRect.right, b.rangeRect.right) &&
    near(a.rangeRect.bottom, b.rangeRect.bottom)
  );
}

/** 从选区往上找出它落在哪条消息里 —— 之后要回跳定位靠它 */
function messageIdOf(node: Node | null): string | null {
  let el = node instanceof Element ? node : node?.parentElement ?? null;
  while (el) {
    const id = el.getAttribute?.('data-message-id');
    if (id) return id;
    el = el.parentElement;
  }
  return null;
}

export function QuoteBar({
  scopeRef,
  onQuote,
  onSelectionActivityChange,
}: QuoteBarProps): ReactElement | null {
  const t = useT();
  const [bar, setBar] = useState<BarState | null>(null);
  const barRef = useRef<HTMLSpanElement>(null);
  const geometryRef = useRef<SelectionGeometry | null>(null);
  const selectionActiveRef = useRef(false);
  const onSelectionActivityChangeRef = useRef(onSelectionActivityChange);

  useEffect(() => {
    onSelectionActivityChangeRef.current = onSelectionActivityChange;
  }, [onSelectionActivityChange]);

  const setSelectionActive = useCallback((active: boolean) => {
    if (selectionActiveRef.current === active) return;
    selectionActiveRef.current = active;
    onSelectionActivityChangeRef.current?.(active);
  }, []);

  const hideBar = useCallback(() => {
    geometryRef.current = null;
    setBar(null);
  }, []);

  const sync = useCallback(() => {
    const scope = scopeRef.current;
    if (!scope) {
      setSelectionActive(false);
      return hideBar();
    }
    const geometry = readSelectionGeometry(scope);
    if (!geometry) {
      setSelectionActive(false);
      return hideBar();
    }
    setSelectionActive(true);
    geometryRef.current = geometry;
    const measuredBar = barRef.current?.getBoundingClientRect();
    const measuredWidth = measuredBar?.width || DEFAULT_BAR_WIDTH;
    const measuredHeight = measuredBar?.height || DEFAULT_BAR_HEIGHT;
    const position = quoteBarPosition({
      selectionLeft: geometry.rangeRect.left,
      selectionRight: geometry.rangeRect.right,
      selectionTop: geometry.rangeRect.top,
      selectionBottom: geometry.rangeRect.bottom,
      panelLeft: geometry.panelRect.left,
      panelRight: geometry.panelRect.right,
      panelTop: geometry.panelRect.top,
      panelBottom: geometry.panelRect.bottom,
      barWidth: measuredWidth,
      barHeight: measuredHeight,
    });
    setBar({
      left: position.left,
      top: position.top,
      placement: position.placement,
      text: geometry.text,
      messageId: messageIdOf(geometry.range.commonAncestorContainer),
      measuredWidth,
      measuredHeight,
    });
  }, [hideBar, scopeRef, setSelectionActive]);

  // The first selection pass cannot measure a bar that does not exist yet.
  // Re-run once after mount so long localized labels use their real width for
  // edge clamping; the measured dimensions make the second pass idempotent.
  useLayoutEffect(() => {
    if (!bar || !barRef.current) return;
    const measured = barRef.current.getBoundingClientRect();
    if (measured.width <= 0 || measured.height <= 0) return;
    if (near(measured.width, bar.measuredWidth) && near(measured.height, bar.measuredHeight)) return;
    sync();
  }, [bar, sync]);

  useEffect(() => {
    // `selectionchange` 是唯一能同时覆盖鼠标拖选、双击选词、键盘 Shift+方向的信号
    function dismissOnMovedViewport(): void {
      const scope = scopeRef.current;
      const previous = geometryRef.current;
      if (!scope || !previous) return;
      const current = readSelectionGeometry(scope);
      if (!current) {
        setSelectionActive(false);
        hideBar();
        return;
      }
      if (sameVisibleGeometry(previous, current)) return;
      // The viewport really moved. Hide the stale fixed-position bar, but keep
      // the valid Selection active: ChatPane must not resume tail-follow until
      // the user actually clears it (or explicitly jumps to latest).
      hideBar();
    }
    document.addEventListener('selectionchange', sync);
    window.addEventListener('scroll', dismissOnMovedViewport, true);
    window.addEventListener('resize', sync);
    const scope = scopeRef.current;
    const resizeObserver =
      scope && typeof ResizeObserver === 'function'
        ? new ResizeObserver(sync)
        : null;
    if (scope) resizeObserver?.observe(scope);
    return () => {
      document.removeEventListener('selectionchange', sync);
      window.removeEventListener('scroll', dismissOnMovedViewport, true);
      window.removeEventListener('resize', sync);
      resizeObserver?.disconnect();
      setSelectionActive(false);
    };
  }, [hideBar, scopeRef, setSelectionActive, sync]);

  if (!bar) return null;
  return (
    <QuoteBarView
      ref={barRef}
      placement={bar.placement}
      style={{
        left: `${bar.left}px`,
        top: `${bar.top}px`,
        transform: bar.placement === 'above' ? 'translate(-50%, -100%)' : 'translateX(-50%)',
      }}
      onQuote={() => onQuote(bar.text, bar.messageId)}
    />
  );
}

/**
 * 浮条的**呈现层** —— 只管长什么样,不碰选区。
 *
 * 拆出来是为了能静态渲染:陈列页要照这一格,而真实浮条的位置来自 DOM Range,
 * `renderToStaticMarkup` 里根本没有选区。行为那一半仍然在 `QuoteBar` 上,
 * 由 `runtime/chat/quote-selection` 的纯判据驱动。
 */
export const QuoteBarView = forwardRef<HTMLSpanElement, {
  placement: 'above' | 'below';
  style?: CSSProperties;
  onQuote?: () => void;
}>(function QuoteBarView({ placement, style, onQuote }, ref): ReactElement {
  const t = useT();
  /*
   * 根节点是 `<span>` 不是 `<div>` —— 稿子的 `.selbar` 也是 span。
   * 理由不只是对齐:浮条会被摆进正文里(居中于被划线的那几个字),
   * 而 `<div>` 放进 `<p>` 会让浏览器**当场把 `<p>` 截断**,DOM 被重排、
   * 浮条落到别处 —— 陈列页第 65 格照出来就是浮条整个不见了。
   */
  return (
    <span
      ref={ref}
      className={styles.bar}
      data-testid="chat-quote-bar"
      data-placement={placement}
      style={style}
      // 鼠标按在浮条上会先清掉选区,按钮的 click 就永远等不到
      onMouseDown={(event) => event.preventDefault()}
    >
      <button type="button" className={styles.action} onClick={onQuote}>
        {t('chat.quote.add')}
      </button>
    </span>
  );
});
