/**
 * 折叠块 —— 复用密度最高的原子:执行记录本身、每条 todo 抽屉、命令的输出块都是它。
 * 执行记录就是 Foldable 套 Foldable。
 *
 * 两个形态(设计稿):
 *  · flat  最外那层(壳),无框、标题加粗、展开后与正文之间有一条分隔线
 *  · boxed 抽屉层,有底有圆角
 *
 * 三条容易写错的地方:
 *  1. `expandable === false` 时**不出箭头、也打不开**(D35:本轮没有内容的 todo)。
 *     仍然用 `<details>` 而不是换成 div —— 结构一变,父层那些按嵌套层数算缩进的
 *     选择器就全部错位。
 *  2. **用户手点开的不能被重渲染复位**(模拟器踩过:每帧重画把折叠态拨回去)。
 *     所以不传 `open` 时用内部状态记住,不是每次渲染都把属性写回去。
 *  3. 耗时在箭头左边;没有耗时时箭头自己靠右(CSS 里靠 `margin-left:auto` 换手)。
 */
import {
  type ReactElement,
  type Ref,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useState,
} from 'react';
import type { FoldableProps } from './contract';
import { ChevronIcon } from './icons';
import styles from './record.module.css';

export function Foldable({
  summary,
  variant = 'boxed',
  elapsed,
  defaultOpen,
  open,
  onToggle,
  expandable = true,
  scroll,
  stream,
  deferBody = false,
  bodyRef,
  className,
  children,
}: FoldableProps & { stream?: boolean; bodyRef?: Ref<HTMLDivElement>; className?: string }): ReactElement {
  const [selfOpen, setSelfOpen] = useState(Boolean(defaultOpen));
  const [bodyActivated, setBodyActivated] = useState(Boolean(defaultOpen || open));
  const controlled = open != null;
  const hasBody = children != null && children !== false;
  const isOpen = expandable && hasBody && (controlled ? Boolean(open) : selfOpen);
  const shouldMountBody = !deferBody || isOpen || bodyActivated;

  useEffect(() => {
    if (isOpen && !bodyActivated) setBodyActivated(true);
  }, [bodyActivated, isOpen]);

  const handleToggle = useCallback(
    (event: SyntheticEvent<HTMLDetailsElement>) => {
      const next = event.currentTarget.open;
      if (!expandable || !hasBody) {
        if (next) event.currentTarget.open = false;
        return;
      }
      if (next) setBodyActivated(true);
      if (!controlled) setSelfOpen(next);
      onToggle?.(next);
    },
    [controlled, expandable, hasBody, onToggle],
  );

  const classes = [
    styles.fold,
    variant === 'flat' ? styles.flat : null,
    expandable && hasBody ? null : styles.leaf,
    className ?? null,
  ].filter(Boolean).join(' ');

  return (
    <details className={classes} open={isOpen} onToggle={handleToggle}>
      <summary onClick={() => {
        if (deferBody && expandable && hasBody) setBodyActivated(true);
      }}>
        <span className={styles.summaryContent} data-testid="chat-foldable-summary-content">
          {summary}
        </span>
        {/*
          * `!= null` 而不是真值判断:**空字符串要占住这个槽**。稿子给进行中的折叠行画的是
          * `<span class="ms"></span>` —— 槽在、值空,这样耗时落地那一刻箭头不会横跳
          * (空槽同样吃掉 `.meta + .chev { margin-left: 0 }` 那条)。
          * 不需要槽的调用方传 `undefined`,行为和从前一样。
          */}
        {elapsed != null ? (
          <span className={styles.meta} data-testid="chat-foldable-elapsed">{elapsed}</span>
        ) : null}
        {/* 没有东西可展开的时候给个箭头是在骗人 */}
        {expandable && hasBody ? (
          <span className={styles.chev} data-testid="chat-foldable-toggle"><ChevronIcon /></span>
        ) : null}
      </summary>
      {expandable && hasBody && shouldMountBody ? (
        <div
          ref={bodyRef}
          className={[styles.body, stream ? styles.stream : styles.stack, scroll ? styles.scroll : null]
            .filter(Boolean).join(' ')}
        >
          {children}
        </div>
      ) : null}
    </details>
  );
}
