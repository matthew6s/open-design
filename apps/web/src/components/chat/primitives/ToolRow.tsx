/**
 * 执行记录里的一行 —— 这一次调用干了什么。
 *
 * 五种写法(逐条对设计稿,不是我编的排列):
 *   读 / 写 / 改文件   动词 + 文件名按钮 + 改动量(有就显示改动量,没有显示耗时)
 *   搜索              「搜索 <模式>」+ 命中数(D23:搜索是一等类别)
 *   跑命令 · 有人话     折叠块:标题是 agent 给的 description,展开是命令与输出(组件 11)
 *   跑命令 · 没人话     「执行 <命令>」单行,输出不在行里(S8;codex 全程没有 description)
 *   失败              两种写法:只给「失败」按钮,或把原因跟在名字后面 —— 是否有意区分 = S1 待设计答
 *
 * ⚠️ **「执行中」这一档 2026-09-02 加回来了**(OPEND-2419,D3 作废)。原来是「调用跑完
 * 才落行」,代价是一次卡住 14.1 分钟的下载在界面上完全不存在,用户看到「转了 40 分钟
 * 什么都没出来」。现在 `row.pending` 为真就先把行画出来:
 *   行首  转着的球(轮次还在跑)/ 中性灰(轮次已经停了 —— 不许继续转圈)
 *   耗时  槽留着但**空的**,照稿子(`<span class="ms"></span>`)—— 值落地时箭头不横跳
 * 稿子刻意不给进行中的行挂跳动的秒数,理由写在 Thinking 那一节,别顺手加回来。
 */
import { useEffect, useRef, type ReactElement, type ReactNode } from 'react';
import { useT } from '../../../i18n';
import type { ToolRow as ToolRowData } from '../../../runtime/chat/contract';
import { formatElapsed } from '../../../runtime/chat/format';
import { openableRecordFilePath, type RecordFileScope } from '../../../runtime/chat/record-file-open';
import { FileButton } from './FileButton';
import { Foldable } from './Foldable';
import { StatusMark } from './StatusMark';
import { toolIcon } from './icons';
import styles from './record.module.css';

export interface ToolRowProps {
  row: ToolRowData;
  onOpenFile?: (path: string) => void;
  /**
   * 判「这个文件名该不该做成打开入口」需要的作用域。不传 = 只有相对路径的写 / 改
   * 还能成链接;判据与理由全在 `runtime/chat/record-file-open.ts`。
   */
  fileScope?: RecordFileScope;
  /** 点「失败」看原因;不传就不出那颗按钮 */
  onShowFailure?: (row: ToolRowData) => void;
  /** Static mirrors can keep collapsed command bodies in the emitted HTML. */
  deferBody?: boolean;
  /**
   * 这一轮还在跑吗 —— 只决定**没回来的调用**画成哪一档标记。
   * 默认 false:轮次停了还转圈是新 bug,拿不到上下文时宁可画中性灰。
   */
  running?: boolean;
}

export function ToolRow({
  row,
  onOpenFile,
  fileScope,
  onShowFailure,
  deferBody = true,
  running = false,
}: ToolRowProps): ReactElement {
  const t = useT();
  const elapsed = formatElapsed(row.elapsedMs);
  /*
   * 行首那一格。没回来的调用换成状态标记 —— 轮次还在跑是转着的球,轮次停了退成
   * 中性灰(和 `markFor` 的「中断时正在跑的:中性灰,红要留给真的错误」同一条规矩;
   * 绿勾是假成功、红叉是假错误,两个都不能用)。
   */
  const icon = row.pending
    ? <StatusMark status={running ? 'running' : 'pending'} />
    : <span className={styles.icon}>{toolIcon(row.tool)}</span>;
  /*
   * 耗时槽。进行中时**留空但保留**,照稿子的 `<span class="ms"></span>` ——
   * 空槽吃掉 `.meta + .chev { margin-left: 0 }` 那条,数值落地时箭头不会横跳。
   */
  const metaSlot = elapsed
    ? <span className={styles.meta}>{elapsed}</span>
    : row.pending ? <span className={styles.meta} /> : null;

  /*
   * 这一行的文件名能不能打开,以及打开的是**哪个项目相对路径**(不是 agent 给的
   * 那个绝对路径 —— 打开回调按项目相对文件名匹配)。算不出来就不做链接:
   * 读取一律不做,写 / 改要拿得到「这个路径属于当前项目」的正面证据。
   */
  const openPath = openableRecordFilePath(row, fileScope);
  const fileName = (): ReactElement | null => (row.file
    ? (
      <FileButton
        path={openPath ?? row.file.path}
        label={row.file.label}
        onOpen={openPath ? onOpenFile : undefined}
        elide
      />
    )
    : null);

  const failButton = row.failed && onShowFailure
    ? <button type="button" className={styles.why} onClick={() => onShowFailure(row)}>{t('chat.record.failed')}</button>
    : row.failed
      ? <span className={styles.why}>{t('chat.record.failed')}</span>
      : null;

  const rowClass = `${styles.tool}${row.failed ? ` ${styles.fail}` : ''}`;

  /* 搜索:显示搜了什么、命中几处。命中数取代耗时 —— 用户关心的是找到没有,不是快不快 */
  if (row.tool === 'search' && row.pattern && !row.failed) {
    return (
      <div className={rowClass}>
        {icon}
        <span className={styles.name}>
          {t('chat.record.verb.search')}{' '}
          <FileButton path={row.pattern} label={row.pattern} />
        </span>
        {row.hits != null
          ? <span className={`${styles.meta} ${styles.num}`}>{t('chat.record.hits', { count: row.hits })}</span>
          : metaSlot}
      </div>
    );
  }

  /* 文件类:动词 + 文件名。改动量和耗时二选一(设计稿:写文件不挂耗时,挂改动量) */
  const verb = fileVerb(row, t);
  if (verb && row.file && !row.failed) {
    return (
      <div className={rowClass}>
        {icon}
        <span className={styles.name}>
          {verb} {fileName()}
        </span>
        {row.delta
          ? <span className={styles.delta}><i>+{row.delta.added}</i><i>−{row.delta.removed}</i></span>
          : metaSlot}
      </div>
    );
  }

  /*
   * Bash 已能确认动作、但目标是多文件 / glob / 动态变量时,不能伪造一个
   * 可点文件。动词仍然应该如实显示,只把剩下的命令摘要当普通文字。
   */
  const semanticVerb = row.tool === 'search' ? t('chat.record.verb.search') : verb;
  if (semanticVerb && row.command && row.rawTitle && !row.failed) {
    return (
      <div className={rowClass}>
        {icon}
        <span className={styles.name}>
          {semanticVerb} <FileButton path={row.command} label={row.title} />
        </span>
        {row.tool === 'search' && row.hits != null
          ? <span className={`${styles.meta} ${styles.num}`}>{t('chat.record.hits', { count: row.hits })}</span>
          : metaSlot}
      </div>
    );
  }

  /* 失败写法二:原因跟在名字后面(有具体原因时才用,没有就走写法一) */
  if (row.failed && row.file && row.failReason) {
    return (
      <div className={rowClass}>
        {icon}
        <span className={styles.name}>
          {verb ?? t('chat.record.verb.write')}{' '}
          {fileName()}
          {' · '}{row.failReason}
        </span>
        {metaSlot}
      </div>
    );
  }

  /* 失败写法一:只给「失败」 */
  if (row.failed && row.file) {
    return (
      <div className={rowClass}>
        {icon}
        <span className={styles.name}>
          {verb ?? t('chat.record.verb.write')}{' '}
          {fileName()}
        </span>
        {failButton}
        {metaSlot}
      </div>
    );
  }

  /*
   * 跑命令 · 有人话标题:折叠块(组件 11)。
   * 成功默认收起 —— 标题那一行已经说了跑没跑通;失败默认展开 —— 报错原文是这时候唯一要读的东西。
   * 正文没有头、没有复制键(W3):这不是代码块,是「刚才那条命令在终端里长什么样」。
   */
  if (row.command && !row.rawTitle) {
    return (
      <Foldable
        summary={<>{icon}<span className={styles.name}>{row.title}</span>{failButton}</>}
        elapsed={elapsed ?? (row.pending ? '' : undefined)}
        defaultOpen={row.failed}
        deferBody={deferBody}
        /*
         * 失败标记要落在**这一行自己**身上,和 `div.tool` 那几支一致
         * (稿子同样是 `class="fold is-fail"`)。少了它,CSS 只能靠 summary 里
         * 那枚「失败」标记反推,而「整行静音灰」的例外(稿子 `:not(.is-fail)`)
         * 正是挂在这个类上的。
         */
        className={row.failed ? styles.fail : undefined}
      >
        <div className={styles.code}>
          <div className={`${styles.term} ${styles.cmd}`}><div>{row.command}</div></div>
          {row.terminal ? <Terminal text={row.terminal} /> : null}
        </div>
      </Foldable>
    );
  }

  /* 跑命令,没有人话标题:「执行 <命令>」单行 */
  if (row.command && row.rawTitle && !row.failed) {
    return (
      <div className={rowClass}>
        {icon}
        <span className={styles.name}>
          {t('chat.record.verb.exec')} <FileButton path={row.command} label={row.title} />
        </span>
        {metaSlot}
      </div>
    );
  }

  /* 兜底:标题原样一行。元工具(ToolSearch 等)走这里,按工具名显示,不硬归类(T4) */
  return (
    <div className={rowClass}>
      {icon}
      <span className={styles.name}>
        {row.tool === 'other' ? `${row.name} ` : null}
        {row.rawTitle ? <code>{row.title}</code> : row.title}
      </span>
      {failButton}
      {metaSlot}
    </div>
  );
}

type Translate = ReturnType<typeof useT>;

function fileVerb(row: ToolRowData, t: Translate): ReactNode {
  if (row.tool === 'write') return t('chat.record.verb.write');
  if (row.tool === 'edit') return t('chat.record.verb.edit');
  if (row.tool === 'delete') return t('common.delete');
  if (row.tool === 'read') return t('chat.record.verb.read');
  return null;
}

/**
 * 终端输出。限高滚动并**贴到底部** —— 一段构建日志里要读的永远是最后几行。
 *
 * 绿 / 红只按行首那个符号判(`✓` / `✗`)。设计稿给的是成品截图,没有给判定规则:
 * 我们的事件流里没有任何「这一行是成功还是失败」的结构化信息,输出就是一整块文本。
 * 认符号是能站得住的最小规则,认不出来就按普通行画(和设计稿的中性色一致),
 * 不去猜「哪一行像报错」。这条规则待设计确认。
 */
function Terminal({ text }: { text: string }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <div className={styles.term} ref={ref}>
      {text.replace(/\s+$/, '').split('\n').map((line, i) => (
        <div key={i} className={lineTone(line)}>{line}</div>
      ))}
    </div>
  );
}

function lineTone(line: string): string | undefined {
  const head = line.trimStart().charAt(0);
  if (head === '\u2713' || head === '\u2714') return styles.ok;      // ✓ ✔
  if (head === '\u2717' || head === '\u2718' || head === '\u2716') return styles.er;  // ✗ ✘ ✖
  return undefined;
}
