/**
 * 执行记录 —— 一轮里装「过程」的那一块(设计稿组件 7 / 9 / 10 / 11)。
 *
 * 它是**通用容器,没有类型**(D11):有清单就按 todo 分段,没有就把动作平铺。
 * 内容从哪来、怎么分,全在 `runtime/chat/build-turn-blocks.ts` 里定了;
 * 这个组件只负责画,不做任何归属判断 —— 判断留在纯函数层才能脱离 React 测。
 *
 * 壳头四种样子(设计稿只有三态,手动停止是旗标不是第四态):
 *   进行中   球 + 会扫光的「进行中」+ 秒数,默认展开
 *   思考中   同上但换文案 + 三个点。**靠事件驱动**:claude 的 thinking 全是空串,
 *            靠文字判断永远等不到(S21 / W11)
 *   已完成   纯文本 + 总耗时,**默认收起**
 *   运行失败 红色状态词,默认收起 —— 原因和下一步交给下面的报错卡(B18)
 *   (手动停止:状态词仍是「进行中」、秒数停住,「已手动停止」是下方那行的词)
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { useT } from '../../i18n';
import { Icon } from '../Icon';
import type { ExecutionShell as ShellData, ImageRow as ImageRowData, ShellItem, TodoSegment } from '../../runtime/chat/contract';
import { isExpandable, isStruck } from '../../runtime/chat/contract';
import { formatElapsed, formatShellElapsed } from '../../runtime/chat/format';
import { groupThinking, type GroupedShellItem } from '../../runtime/chat/group-thinking';
import type { RecordFileScope } from '../../runtime/chat/record-file-open';
import { Foldable } from './primitives/Foldable';
import { ImageRow } from './primitives/ImageRow';
import { useThinkingStream } from './primitives/useThinkingStream';
import { ThinkingMarkdown } from './ThinkingMarkdown';
import { Orb } from './primitives/Orb';
import { SayText } from './primitives/SayText';
import { StatusMark } from './primitives/StatusMark';
import { ToolRow } from './primitives/ToolRow';
import styles from './primitives/record.module.css';

/**
 * 多久算「等太久」。60 秒来自 `error-ux-design.md:33`(10 分钟 / Cloud 30 分钟才报超时,
 * 这一句只是等待期间的回音,不改变任何超时判定)。
 *
 * **2026-08-27 起壳头不再读它** —— S12 的那句文案撤回了(裁决与理由见下面 `head` 里
 * 的注释)。门槛本身留着:整条探测逻辑一行没删,产品打算换一种展现形式把它请回来,
 * 到时候不必重新考据这个 60 秒是哪来的。
 *
 * 导出是**故意**的:保留测试直接引用它,谁把它删了
 * `tests/components/chat/s12-copy-revert.test.tsx` 会当场红。
 */
export const SLOW_UPSTREAM_AFTER_MS = 60_000;

export interface ExecutionShellProps {
  shell: ShellData;
  onOpenFile?: (path: string) => void;
  /**
   * 判「工具行里那个文件名该不该做成打开入口」需要的作用域。
   * 读取一律不做链接,写 / 改要拿得到「路径属于当前项目」的正面证据 ——
   * 判据与理由在 `runtime/chat/record-file-open.ts`。
   */
  fileScope?: RecordFileScope;
  /** 生图失败格的「重试」—— 没有回调时那一格只画不点(稿子也允许只画) */
  onRetryImage?: (row: ImageRowData, index: number) => void;
  /** 整轮已进入终态时才允许媒体格开放手动重试。 */
  runTerminal?: boolean;
  imageSrc?: (path: string) => string;
  /**
   * Product history defers collapsed bodies by default. Static design mirrors
   * can disable this so their non-hydrated HTML remains inspectable.
   */
  deferCollapsedBodies?: boolean;
}

export function ExecutionShell({
  shell,
  onOpenFile,
  fileScope,
  onRetryImage,
  runTerminal = false,
  imageSrc,
  deferCollapsedBodies = true,
}: ExecutionShellProps): ReactElement {
  const t = useT();
  const running = shell.status === 'running' && !shell.stopped;
  const elapsed = formatShellElapsed(shell.elapsedMs);
  /**
   * 模型此刻在想 —— **只用来挑出哪一格是「还在写的那一格」**,不再改变壳的形态。
   *
   * ⚠️ 这里曾经是 `const streaming = running && shell.thinking`,而那个值同时干三件事、
   * 三件都作用在**整张壳**上:壳 body 换成 96px 限高窗、整只 body 挂自动滚动、
   * 壳内条目一律不分组。于是壳里原有的工具行、清单、正文全被塞进那只窗里滚走。
   * 用户 2026-08-27 指认:「这个思考中的怎么把原本的进行中卡片给顶掉了卧槽..」
   * 「绝不能 thinking 的时候直接把进行中或原本的东西给替换了啊!!」
   *
   * 现在的落法:思考是壳里的**一个条目**,和工具行平级(`ThoughtsRow`),
   * 限高滚动窗挂在那一格自己身上。壳 body 永远是 `.stack`。
   */
  const thinkingNow = running && shell.thinking;
  /**
   * 推理落在哪一摞里:清单开着的时候进那条 in_progress 的 todo(`build-turn-blocks`
   * 的 `sink()`),没有清单就落在壳自己身上。「还在写的那一格」只可能在这一摞的结尾,
   * 所以 `live` 只发给它,别的地方一律按跑完处理。
   */
  const activeTodo = shell.items.some(
    (item) => item.kind === 'todo' && item.segment.status === 'in_progress',
  );

  /**
   * 折叠态跟着 **run 的生命周期**走(D18):跑着的时候摊开,结束就收起来。
   *
   * 不能只靠 `Foldable` 的 `defaultOpen` —— 那是初始值,run 结束时不会再看它一眼,
   * 壳会一直摊在那儿。也不能每次都把它写回去:用户中途手点收起/展开之后就该听用户的
   * (同一条约束在 `Foldable` 的注释里,老的执行记录卡也是这么做的)。
   */
  const lifecycleOpen = running || shell.stopped;
  const [open, setOpen] = useState(lifecycleOpen);
  const [userToggled, setUserToggled] = useState(false);
  useEffect(() => {
    if (!userToggled) setOpen(lifecycleOpen);
  }, [lifecycleOpen, userToggled]);
  const onToggle = useCallback((next: boolean) => {
    setUserToggled(true);
    setOpen(next);
  }, []);

  const head = (() => {
    if (shell.status === 'failed') {
      return <span className={styles.stFail}>{t('chat.record.failedTurn')}</span>;
    }
    if (shell.stopped) {
      // 停住:不再动,所以不挂扫光也不挂球 —— 秒数就停在那儿(场景稿注释)
      return <span>{t('chat.record.running')}</span>;
    }
    if (running) {
      /**
       * 壳头就是普通的「进行中 / 思考中」。
       *
       * ── S12 文案撤回(2026-08-27,只撤展现,不撤探测)────────────────────
       *
       * 这里曾经在静默超过 `SLOW_UPSTREAM_AFTER_MS` 时把壳头换成
       * 「上游响应慢，已等 N 秒」(S12「等太久没动静」,P1,18,891 次/月、6,372 台,
       * 门槛与文案逐字来自 `docs/design/run-errors/error-ux-design.md:33`)。
       * 产品裁决把它撤了,原话:「这个文案先让 subagent 改回 进行中 吧,跟产品讨论了下,
       * 但背后的探测逻辑先保留,后续可能会用到,只不过用别的展现形式」。
       * 触发裁决的画面是壳头那一行「上游响应慢，已等 411 秒  13m 7s」—— 一句话占满壳头,
       * 右边的总耗时还在说同一段时间,读起来像故障,而它只是在等。
       *
       * **撤的只有这一行取值。** 探测整条链一行没删,而且还在跑:
       *   `providers/daemon.ts` 的 `markUpstreamActivity`(每收到一条真运行帧)
       *     → `runtime/chat/upstream-activity.ts`(按 run 记的到达时刻表)
       *     → `AssistantMessage` 的 `useTickingNow` 每秒喂给 `buildTurnBlocks`
       *     → `build-turn-blocks.ts` 的 `shellQuiet` 算出静默
       *     → `contract.ts` 的 `quietMs` 挂在每张运行中的壳上。
       * 这里只是**暂时不读** `shell.quietMs`;它照旧被算出来、照旧送到这个组件手上,
       * 换个展现形式时接上就行。
       *
       * ⚠️ 想「顺手把死代码清干净」的下一位:这不是死代码。
       * 钉子在 `tests/components/chat/s12-copy-revert.test.tsx` 的「探测保留」一节 ——
       * 删掉 `shellQuiet` / `quietMs` / `SLOW_UPSTREAM_AFTER_MS` 中任何一个都会当场红。
       * 传输层那一截另有 `tests/components/chat/s12-upstream-alive.test.tsx` 钉着。
       */
      /*
       * ── 「思考中」下沉(2026-08-27 用户裁决)────────────────────────────
       *
       * 壳头**只说这一轮在跑**,不再替模型说它在想什么。原来这里会在 `shell.thinking`
       * 时把状态词换成「思考中」、把球换成 `composing`;用户原话
       * 「绝不能 thinking 的时候直接把**进行中**或原本的东西给替换了」——「进行中」
       * 指的就是壳头这三个字。
       *
       * 动画和文案没有丢,是**搬家**了:它们现在挂在壳内那一格思考上
       * (`ThoughtsRow` 的 `live` 形态,球 + 扫光 + 三个点一件不少)。
       * 两处都画就成了同一句话说两遍,所以这里不再读 `shell.thinking`。
       */
      return (
        <>
          {/* 不给标签:紧跟着的就是「进行中」那行字,读屏念一遍就够 */}
          <Orb state="connecting" box={24} className={styles.orb} />
          <span className={`${styles.shimmer} ${styles.head}`}>{t('chat.record.running')}</span>
        </>
      );
    }
    return <span>{t('chat.record.done')}</span>;
  })();

  /**
   * 连续的推理收成「思考过程」那一格(用户裁决,见 `groupThinking` 的注释)。
   * 壳里有进行中的 todo 时,还在写的那一格在**那条 todo 里**,不在这一层。
   */
  const items = groupThinking(shell.items, thinkingNow && !activeTodo);
  /**
   * 这张壳有没有清单 —— 夹心正文对不对齐那条竖线全看它(用户裁决 2026-08-27)。
   * 有清单时顶层正文是清单上面的开场白,不在链上,贴左;没清单时正文和工具行交替
   * 往下走,夹在中间那几段要落回 22px 并接线。判据只挂在 CSS 上,见
   * `record.module.css` 的 `:not(.hasTodo)`。
   */
  const hasTodo = shell.items.some((item) => item.kind === 'todo' || item.kind === 'plan');

  return (
    <Foldable
      summary={head}
      variant="flat"
      elapsed={elapsed ?? undefined}
      open={open}
      onToggle={onToggle}
      expandable={items.length > 0}
      deferBody={deferCollapsedBodies}
      className={hasTodo ? styles.hasTodo : undefined}
    >
      {items.length
        ? items.map((item, i) => renderItem(item, i, {
            t, onOpenFile, fileScope,
            onRetryImage: runTerminal ? onRetryImage : undefined,
            imageSrc, thinkingNow, running,
            deferCollapsedBodies,
            liveTextIndex: liveTextIndexOf(items, running),
          }))
        : null}
    </Foldable>
  );
}

/**
 * 这一摞里「还在往里写」的那一段叙述排第几 —— 逐字化开只发给它。
 *
 * 判据是**排在最后**:壳里的条目按到达顺序排,还在长的那一段只可能是最后一个 `text`,
 * 它后面若已经压上了工具行 / 抽屉,说明那段话早就写完了。
 * 不在跑的时候返回 `-1`,历史消息重渲染时一个字都不化开。
 */
function liveTextIndexOf(items: GroupedShellItem[], running: boolean): number {
  if (!running) return -1;
  const last = items.length - 1;
  return last >= 0 && items[last]?.kind === 'text' ? last : -1;
}

interface RenderCtx {
  t: ReturnType<typeof useT>;
  onOpenFile?: (path: string) => void;
  fileScope?: RecordFileScope;
  onRetryImage?: (row: ImageRowData, index: number) => void;
  imageSrc?: (path: string) => string;
  /** 模型此刻在想 —— 传给 todo 抽屉,让它认出自己那一摞里的 `live` 格 */
  thinkingNow: boolean;
  /** 这一轮还在跑吗 —— 抽屉里那一摞要自己算 `liveTextIndex`,得知道这件事 */
  running: boolean;
  /** Whether initially collapsed historical bodies mount on first expansion. */
  deferCollapsedBodies: boolean;
  /**
   * **这一摞**里「还在往里写」的那一段叙述排第几 —— 只有它逐字化开。
   * 不在跑的时候是 `-1`(历史消息重渲染时不能再化开一遍)。
   */
  liveTextIndex: number;
}

function renderItem(item: GroupedShellItem, index: number, ctx: RenderCtx): ReactElement | null {
  if (item.kind === 'thoughts') {
    /*
     * key 里带上形态:`live` 翻成 false 的那一刻要**换一只 details**,
     * 不然 `Foldable` 内部记着的展开态会跟过来,思考一结束就原地摊开
     * ——「怎么一结束全部释放出来了」正是这个。
     */
    return (
      <ThoughtsRow
        key={`thoughts-${item.live ? 'live' : 'done'}-${index}`}
        texts={item.texts}
        elapsedMs={item.elapsedMs}
        live={item.live === true}
        t={ctx.t}
        deferBody={ctx.deferCollapsedBodies}
      />
    );
  }
  if (item.kind === 'tool') {
    return (
      <ToolRow
        key={`tool-${item.id}-${index}`}
        row={item}
        onOpenFile={ctx.onOpenFile}
        fileScope={ctx.fileScope}
        deferBody={ctx.deferCollapsedBodies}
      />
    );
  }
  if (item.kind === 'text') {
    /*
     * 壳内的过程叙述也逐字化开,但**只有还在往里写的那一段**(用户 2026-08-27:
     * 「包括我们所有普通文本, 都应该有这个流式输出的效果才对」)。
     * 前面几段早就写完了,再化开一遍等于每次重渲染重放一次历史。
     */
    return <SayText key={`text-${index}`} text={item.text} live={index === ctx.liveTextIndex} />;
  }
  if (item.kind === 'image') {
    return (
      <ImageRow
        key={`img-${item.id}-${index}`}
        row={item}
        onRetry={ctx.onRetryImage}
        onOpenImage={ctx.onOpenFile ? (path) => ctx.onOpenFile?.(path) : undefined}
        imageSrc={ctx.imageSrc}
      />
    );
  }
  if (item.kind === 'plan') {
    return (
      <PlanRow
        key={`plan-${index}`}
        steps={item.steps}
        t={ctx.t}
        deferBody={ctx.deferCollapsedBodies}
      />
    );
  }
  return <TodoRow key={`todo-${item.segment.content}-${index}`} segment={item.segment} ctx={ctx} />;
}

/**
 * 思考那一格。**两种形态、同一只 `Foldable`** —— 这是「左边缘不能跳」的实现方式:
 * 同一种 DOM(壳 body 里的 `details.fold`,和可展开的命令工具行一模一样),
 * 于是 `record.module.css` 那套缩进规则对三者一视同仁,不必再写一套。
 *
 *   live  还在想:球 + 扫光的「思考中」+ 三个点(从壳头原样搬下来的那一套),
 *         正文走 96px 限高窗、自己一行行往上走(D46' —— 窗子挂在这一格,不是壳 body)
 *   done  想完了:brain 图标 + 「思考过程」一行,默认收起,点开才读细节
 *
 * 用户原话:「思考中的时候, 最好是能有现在那个动画加思考中的文案, 然后下面文字也是要
 * 滚动的, 思考完就收起变成 toolrow」「我说的思考完之后, 不是这个绿的, 就变成普通的
 * 这个搜索一样的东西, 只不过可以下拉展开…你可以给这个加一个 brain 的 icon」。
 *
 * ⚠️ 绿勾(`StatusMark status="ok"`)是**故意去掉**的,别顺手加回来:
 * 推理不是「一条做完了的活」,它没有成败可标。
 *
 * **想完了那一格右边挂自己的耗时**(用户 2026-08-27:「thought 是不是本身右边也要
 * 显示一个耗时?」「todo 内的倒是每个工具调用都有耗时, thought 也要有耗时」)。
 * 这里原来写着「不挂耗时:推理的时长在壳头的总耗时里」—— 那句话的**前提是假的**:
 * 壳头的跨度只由带时刻的事件撑开,第一个工具之前的推理根本不在里面
 * (真机 `4347efff`:整轮 6m 12s,壳头当时只写 3m 11s,掐掉的正是开头那 2m 34s 推理)。
 *
 * **正在想的时候不显示** —— 和进行中的 todo 同一条规矩(`TodoRow` 的
 * `status === 'in_progress'` 那一档):还没结束的事报不出时长,报了也只会每帧跳。
 */
function ThoughtsRow({ texts, elapsedMs, live, t, deferBody }: {
  texts: string[];
  elapsedMs: number | null;
  live: boolean;
  t: RenderCtx['t'];
  deferBody: boolean;
}): ReactElement {
  const elapsed = live ? null : formatElapsed(elapsedMs);
  const bodyRef = useRef<HTMLDivElement>(null);
  useThinkingStream(bodyRef, live);

  /*
   * 两态的行首都占**同一只 15px 图标槽**(`.icon`)。这是「左边缘不会跳」的另一半:
   * 光把整格缩进补齐还不够 —— 球自带 `margin-inline: -3px`(`.orb[data-orb-box='24']`),
   * 直接摆在 summary 里会比 brain 图标再左 3px,思考一结束整行横跳一下。
   * 塞进 `place-items: center` 的槽里之后,后面的字只看槽宽,两态一致。
   * (在 Chrome 里量过:补之前 思考中 x=-3 / 思考过程 x=0,补之后都是 22。)
   */
  const summary = live
    ? (
      <>
        {/* 不给标签:紧跟着的就是「思考中」那行字 */}
        <span className={styles.icon}><Orb state="composing" box={20} className={styles.orb} /></span>
        <span className={styles.shimmer}>
          {t('chat.record.thinking')}
          <span className={styles.dots} aria-hidden><i /><i /><i /></span>
        </span>
      </>
    )
    : (
      <>
        <span className={styles.icon}><Icon name="brain" /></span>
        <span className={styles.name}>{t('chat.record.thoughts')}</span>
      </>
    );

  return (
    <Foldable
      summary={summary}
      elapsed={elapsed ?? undefined}
      className={styles.thoughts}
      defaultOpen={live}
      stream={live}
      /* 想完了那一格是用户**专程点开来读**的,所以是 `max-height` + 正常滚动条,
         不是上面那只 96px 定高 + 渐隐 + 自己往上走的窗(用户 2026-08-27:
         「thought 展开应该有个最高高度, 可以滚动」)。两者互斥,见 `.scroll` 的注释。 */
      scroll={!live}
      deferBody={deferBody && !live}
      bodyRef={bodyRef}
      /* 一段都没有就不出箭头也不出 body。claude 的 thinking 全是空串(真实数据:
         本机 14 条 claude 共 1786 帧、非空 0 帧),此时这一行只报「在想」,
         给一只空的 96px 窗是在骗人。 */
    >
      {texts.length ? <ThinkingMarkdown texts={texts} live={live} /> : null}
    </Foldable>
  );
}

/** 「执行计划 · N 步」:清单刚到时的全貌。每一步只有序号,还没跑,没有「哪类调用」可标 */
function PlanRow({ steps, t, deferBody }: {
  steps: string[];
  t: RenderCtx['t'];
  deferBody: boolean;
}): ReactElement {
  return (
    <Foldable
      summary={<><StatusMark status="ok" /><span>{t('chat.record.plan', { count: steps.length })}</span></>}
      deferBody={deferBody}
    >
      {steps.map((step, i) => (
        <div className={styles.tool} key={`${step}-${i}`}>
          <StatusMark status="pending" index={i + 1} />
          <span className={styles.name}>{step}</span>
        </div>
      ))}
    </Foldable>
  );
}

/**
 * 一条 todo 的抽屉。
 *
 * **两件事解耦**:
 *  · 能不能展开 —— 只看**本轮有没有内容**(D25)
 *  · 划不划线 —— 只看**是不是本轮新开的活**(见 `isStruck` 的注释)
 *
 * 所以「**划线 + 可展开**」是合法形态:线说的是「这是旧账」,
 * 展开看到的是本轮新增的那部分。
 * (这里曾经写着「划线表示这一条本轮没有内容」,**说反了**,只描述了 D35 那一条。)
 */
function TodoRow({ segment, ctx }: { segment: TodoSegment; ctx: RenderCtx }): ReactElement {
  const expandable = isExpandable(segment);
  const struck = isStruck(segment);
  const elapsed = segment.status === 'in_progress' ? null : formatElapsed(segment.elapsedMs);
  /**
   * 抽屉里的推理也要收(用户问题二的真因)。
   *
   * 这里曾经直接 `segment.items.map(renderItem)` —— **没有分组**。壳的顶层收得好好的,
   * 一旦本轮有清单,推理就落进当前那条 todo(`build-turn-blocks` 的 `sink()`),
   * 于是一个字都收不起来。真实录制 `.od/runs/0161ef44`(agent=amr):
   * 42,397 字推理里有 38,064 字铺在这条 in_progress 抽屉里 —— 就是用户截图那几屏。
   *
   * 「还在写的那一格」只可能在**进行中**那条 todo 的结尾。
   */
  const items = groupThinking(segment.items, ctx.thinkingNow && segment.status === 'in_progress');

  return (
    <Foldable
      summary={
        <>
          <StatusMark status={markFor(segment)} />
          <span className={struck ? styles.struck : undefined}>{segment.content}</span>
        </>
      }
      elapsed={elapsed ?? undefined}
      expandable={expandable}
      defaultOpen={segment.status === 'in_progress'}
      deferBody={ctx.deferCollapsedBodies}
    >
      {expandable
        ? items.map((item, i) => renderItem(item, i, {
            ...ctx,
            /* 抽屉里那一摞有自己的顺序:还在写的那一段只可能在**进行中**那条 todo 的末尾 */
            liveTextIndex: liveTextIndexOf(items, ctx.running && segment.status === 'in_progress'),
          }))
        : null}
    </Foldable>
  );
}

function markFor(segment: TodoSegment): 'ok' | 'running' | 'pending' | 'skip' {
  if (segment.status === 'in_progress') return 'running';
  if (segment.status === 'stopped') return 'pending';   // 中断时正在跑的:中性灰,红要留给真的错误
  if (segment.abandoned) return 'skip';                 // D16:作废沿用完成态
  if (segment.status === 'completed') return 'ok';
  return 'pending';
}
