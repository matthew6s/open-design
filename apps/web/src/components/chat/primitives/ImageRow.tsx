/**
 * 生图行 —— 组件 12。执行记录里唯一「没跑完也要显形」的一行(D3 的例外)。
 *
 * 为什么它能例外:要出几张是从命令里数出来的(`media generate` 出现几次就是几张),
 * 所以第一张还没出来的时候就知道该摆几个格子,「出一张落一张」才成立。
 * 别的工具调用没有这种先验,只能等结果回来才落行。
 *
 * 三种样子的切换时机是设计同学定的(D34):
 *   还没出完      球 + 「N/M」+ 一排大格,没出的格是占位
 *   全出完、没失败 收成一行 + 小缩略图条 + 耗时
 *   出完了有失败   仍是大格,失败那格给「重试」,**不收行** —— 收了就没地方放重试
 */
import type { ReactElement } from 'react';
import { VisuallyHidden } from '@open-design/components';
import { useT } from '../../../i18n';
import type { ImageRow as ImageRowData } from '../../../runtime/chat/contract';
import { formatElapsed } from '../../../runtime/chat/format';
import { PixelLiquid } from '../../PixelLiquid';
import { ImageIcon, RetryIcon } from './icons';
import { StatusMark } from './StatusMark';
import styles from './record.module.css';

export interface ImageRowProps {
  row: ImageRowData;
  /** 重试第 n 张(从 0 数)。不给就只画不点 —— 与工具行的「失败」按钮同一条约定 */
  onRetry?: (row: ImageRowData, index: number) => void;
  /** 点缩略图看大图 */
  onOpenImage?: (path: string, index: number) => void;
  /** Resolve a project-relative output name to its authenticated preview URL. */
  imageSrc?: (path: string) => string;
  /**
   * 这一轮还在跑吗 —— 只决定**还没回来的格子**画成哪一档标记。
   *
   * `row.pending` 说的是「还有格子没回来」,不是「还在生成」。取消 / 失败之后那几张
   * 确实没回来,但轮次已经停了,再转下去就读成「还在生成」(和 `ToolRow` 同一个 bug)。
   * 默认 false:拿不到上下文时宁可画中性灰,也不要一颗停不下来的球。
   */
  running?: boolean;
}

export function ImageRow({ row, onRetry, onOpenImage, imageSrc, running = false }: ImageRowProps): ReactElement {
  const t = useT();
  const settled = !row.pending && row.done + row.failed >= row.total;

  /* 全出完且一张没砸:收成一行 */
  if (settled && row.failed === 0) {
    return (
      <div className={styles.tool}>
        <span className={styles.icon}><ImageIcon /></span>
        <span className={styles.name}>
          {t('chat.record.imageBatch')} · {t('chat.record.imageCount', { count: row.total })}
        </span>
        <span className={styles.strip}>
          {Array.from({ length: row.total }, (_, i) => {
            const path = row.thumbs[i];
            const label = t('chat.record.viewImage', { index: i + 1 });
            return (
              <button
                key={i}
                type="button"
                className={styles.th}
                aria-label={label}
                onClick={path && onOpenImage ? () => onOpenImage(path, i) : undefined}
              >
                {path && imageSrc
                  ? <img className={styles.mini} src={imageSrc(path)} alt="" loading="lazy" />
                  : <span className={styles.mini} />}
              </button>
            );
          })}
        </span>
        {formatElapsed(row.elapsedMs) ? <span className={styles.meta}>{formatElapsed(row.elapsedMs)}</span> : null}
      </div>
    );
  }

  /* 还在出,或者出完了有失败:大格形态 */
  return (
    <>
      <div className={styles.tool}>
        {row.pending
          ? <StatusMark status={running ? 'running' : 'pending'} />
          : <span className={styles.icon}><ImageIcon /></span>}
        <span className={styles.name}>{t('chat.record.imageBatch')}</span>
        <span className={`${styles.meta} ${styles.num}`}>{row.done}/{row.total}</span>
      </div>
      <div className={styles.imgs}>
        {Array.from({ length: row.total }, (_, i) => {
          const cell = row.cells?.[i];
          const status = cell?.status ?? (i < row.done
            ? 'done'
            : i < row.done + row.failed ? 'failed' : 'pending');
          if (status === 'done') {
            const path = cell?.path ?? row.thumbs[i];
            return (
              <button
                key={i}
                type="button"
                className={styles.shot}
                data-image-cell="done"
                aria-label={t('chat.record.viewImage', { index: i + 1 })}
                onClick={path && onOpenImage ? () => onOpenImage(path, i) : undefined}
              >
                {path && imageSrc
                  ? <img className={styles.mini} src={imageSrc(path)} alt="" loading="lazy" />
                  : <span className={styles.mini} />}
              </button>
            );
          }
          if (status === 'failed') {
            const inner = <><RetryIcon />{t('chat.record.retry')}</>;
            return (
              <span key={i} className={`${styles.shot} ${styles.fail}`} data-image-cell="failed">
                {onRetry
                  ? <button type="button" className={styles.retry} onClick={() => onRetry(row, i)}>{inner}</button>
                  : <span className={styles.retry}>{inner}</span>}
              </span>
            );
          }
          /* 还没出来的格子:设计稿的「像素液体」。这一格什么都还没有,底下没有图
             可以糊,所以液体不指向任何一张具体的图 —— 它只说「这里在动、东西还在长」。
             静止的灰块说不出这句话,产品 2026-08-26 明令不许再用。 */
          return (
            <span key={i} className={`${styles.shot} ${styles.load}`} data-image-cell="loading">
              <PixelLiquid />
              <VisuallyHidden role="status">{t('chat.record.imagePending')}</VisuallyHidden>
            </span>
          );
        })}
      </div>
    </>
  );
}
