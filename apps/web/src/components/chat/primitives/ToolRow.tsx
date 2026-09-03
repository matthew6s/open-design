/**
 * 执行记录里的一行 —— 这一次调用干了什么。
 *
 * 五种写法(逐条对设计稿,不是我编的排列):
 *   读 / 写 / 改文件   动词 + 文件名按钮 + 改动量(跑完的行:有改动量就显示改动量,
 *                     没有才显示耗时;**还在跑的行两个都显示** —— 见下面写文件那一支)
 *   搜索              「搜索 <模式>」+ 命中数(D23:搜索是一等类别)
 *   跑命令 · 有人话     折叠块:标题是 agent 给的 description,展开是命令与输出(组件 11)
 *   跑命令 · 没人话     「执行 <命令>」单行,输出不在行里(S8;codex 全程没有 description)
 *   失败              两种写法:只给「失败」按钮,或把原因跟在名字后面 —— 是否有意区分 = S1 待设计答
 *
 * ⚠️ **「执行中」这一档 2026-09-02 加回来了**(OPEND-2419,D3 作废)。原来是「调用跑完
 * 才落行」,代价是一次卡住 14.1 分钟的下载在界面上完全不存在,用户看到「转了 40 分钟
 * 什么都没出来」。现在 `row.pending` 为真就先把行画出来:
 *   行首  转着的球(轮次还在跑)/ 中性灰(轮次已经停了 —— 不许继续转圈)
 *   耗时  槽照旧留着,而且**填上实时递增的秒数**(见下面那一段)
 *
 * ── 进行中的行也报耗时(**有意偏离设计稿**,产品 2026-09-02)─────────────
 *
 * 稿子明确**不给**进行中的行挂耗时,理由逐字写在 Thinking 那一格:
 *   「**不挂耗时**:这一行**只活到第一个字落地为止**,给一个马上要消失的状态配一个
 *     跳动的秒数,只会把注意力钉在一个从此不再相关的数字上;总耗时在任务进度那一格里。」
 * 所以上一轮(G2)只按稿子留了个**空的** `.ms` 槽(`<span class="ms"></span>`),
 * 目的是数值落地那一刻箭头不横跳。
 *
 * 产品推翻的是它的**前提**:「只活到第一个字落地为止」对推理模型不成立。真实数据里
 * 有**单轮思考 28.5 分钟**、**单个 Bash 卡住 14.1 分钟**的案例(诊断包 run `3fc3b3ae`)。
 * 一个要持续半小时的状态,说它「马上要消失」是错的 —— 用户的实感正是
 * 「跑了 40 分钟什么都没出来」,而那 40 分钟里执行记录上一个数字都没有。
 * 产品原话:「为啥思考中不会有计时?我感觉**进行中的 toolrow 都得有计时**吧?」
 * 裁决覆盖三类行:思考中 / 工具行 / 步骤行。稿子留的那个空槽正好接住这个值,
 * 箭头一格都不用挪。
 *
 * 秒数**不在这一层算**,也没有新起定时器:`build-turn-blocks` 用轮次共用的实时终点
 * (`liveEndMs`)把它算进 `row.elapsedMs`,这里照旧只画。
 * ⚠️ 那个 span 不许挂 `aria-live` —— 挂了读屏会每秒念一遍。
 * 判据钉在 `tests/components/chat/live-row-elapsed.test.tsx`。
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
   * 耗时槽。进行中时**已经有值了**(实时递增,见文件头那一段偏离设计稿的说明);
   * 只有连起点都拿不到的那一档才留空 —— 空槽照旧吃掉 `.meta + .chev { margin-left: 0 }`
   * 那条,数值落地时箭头不会横跳。
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

  /*
   * 文件类:动词 + 文件名。**跑完**的行改动量和耗时二选一(设计稿:写文件不挂耗时,
   * 挂改动量)——稿子里每一行要么 `.dst` 要么 `.ms`,从来没有同时出现过。
   *
   * ⚠️ **在途那一行两个都挂**(有意偏离设计稿,产品 2026-09-03)。稿子根本没画过
   * 「正在写文件」这一态:它假设写文件是一瞬间的事,行一出现就已经写完了,所以
   * 只需要一个结果数字。真机把这个前提推翻了 —— 一个 27.6KB 的页面,入参逐字符
   * 流过来花了 140 秒,那一百多秒里行上只有一个秒表在转。产品原话:
   * 「写入的行数能否动态增加,外加一个增长的计时?」两个数字回答的是两个问题:
   * 行数说「写到哪了」,秒数说「还在动」。少任何一个都答不完整。
   *
   * 排布不用新写:`.delta` 自带 `margin-inline-end: auto`、`.meta` 自带
   * `margin-left: auto`,两个 auto 把空白让给中间 —— 改动量贴着文件名,耗时靠右,
   * 正好是稿子里那两格各自本来的位置。
   */
  const verb = fileVerb(row, t);
  if (verb && row.file && !row.failed) {
    return (
      <div className={rowClass}>
        {icon}
        <span className={styles.name}>
          {verb} {fileName()}
        </span>
        {row.delta
          ? (
            <>
              <span className={styles.delta}><i>+{row.delta.added}</i><i>−{row.delta.removed}</i></span>
              {row.pending ? metaSlot : null}
            </>
          )
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
