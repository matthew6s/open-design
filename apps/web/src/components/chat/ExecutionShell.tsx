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
import { groupThinking, isThinking, type GroupedShellItem } from '../../runtime/chat/group-thinking';
import type { RecordFileScope } from '../../runtime/chat/record-file-open';
import { Foldable } from './primitives/Foldable';
import { ImageRow } from './primitives/ImageRow';
import { useThinkingFollow } from './primitives/useThinkingFollow';
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

/**
 * 等到多久才说「还在等首批输出」。同样来自 `error-ux-design.md:21`
 * (「超过 60 秒没动静,转圈旁边要说『在等什么、等了多久』;**不到超时不报错**」),
 * 稿子第 44 行把真正的失败门槛定在 10 分钟静默 —— 这一行只是等待期间的回音。
 *
 * ⚠️ **和上面那个常量数值相同,但量的不是同一件事,别合并。**
 *   · `SLOW_UPSTREAM_AFTER_MS` 配的是 `shell.quietMs` —— **上游最近一帧什么时候到的**。
 *     claude 每 1.4 秒一帧空 `thinking_delta`,这个数永远长不到 60 秒。
 *   · 这一个配的是「壳里**一件事都还没落下来**已经多久」,判据是 `shell.items` 为空
 *     加上壳头那个总耗时,心跳一概不清零。用户报的正是后者:帧一直在到,屏幕一直是空的。
 * 合成一个常量,下一次谁调其中一个门槛就会顺手改坏另一个场景。
 */
export const WAITING_FIRST_OUTPUT_AFTER_MS = 60_000;

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
  /*
   * ⚠️ **`<details>` 的 `toggle` 事件不区分是谁掀开的**(OPEND-2557 的真因)。
   *
   * 我们是受控方,React 每次把 `open` 写回 DOM,浏览器都会照样派发一次 `toggle`。
   * 这里原来收到就 `setUserToggled(true)` —— 而**壳跑起来那一帧**就有这么一次
   * (`open` 从无到有),于是这一轮还没跑完就已经算「用户点过」,后面 run 结束时
   * 那次收起同步被自己屏蔽掉。用户截图:「Done 2m 12s ^」,整条记录还全摊着。
   *
   * 判据是**值**:受控方写回去的那一次,`next` 必然等于我们此刻的状态;
   * 用户点的那一次,DOM 先自己翻面,`next` 必然和我们的状态相反。
   * 用 ref 读当前值而不是闭包,免得回声事件排到下一帧时读到过期的 `open`。
   */
  const openRef = useRef(open);
  openRef.current = open;
  const onToggle = useCallback((next: boolean) => {
    if (next !== openRef.current) setUserToggled(true);
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
   * 还卡在**首个输出之前** —— 这一轮还在跑,壳里却一件会落行的事都没有。
   *
   * ── 补的是哪个画面(真机,打包版 beta 2026-09-03)────────────────────
   *
   * ACP 那一家(`vela` / `devin` / `hermes` / `kilo` / `kimi` / `kiro` / `vibe`)在首个
   * token 之前一条会落行的事件都不发,壳身子是**全空的**,屏幕上只剩壳头「进行中 1m 7s」。
   * 而 daemon 这一刻正逐字发着
   * `{"type":"status","label":"waiting_for_first_output","elapsedMs":27217}`
   * (`apps/daemon/src/agent-protocol/acp/session.ts:849`)—— 它知道在等什么,屏幕不说。
   * 稿子 `docs/design/run-errors/error-ux-design.md:21` 要的就是这一句:
   * 「超过 60 秒没动静,**转圈旁边**要说『在等什么、等了多久』;**不到超时不报错**」。
   *
   * ── 三条边界 ─────────────────────────────────────────────────────────
   *
   *  · **不读 daemon 那个 label。** 判据是壳自己的形状,所以对**不发**这个 label 的
   *    agent 同样成立(claude 走 `claude-stream-json`,全仓只有 ACP 发它);而且
   *    daemon 在落库时就把这个 label 丢掉了(`chat-run-messages.ts` 的
   *    `TRANSIENT_ACP_PERSISTED_STATUS_LABELS`),照着它渲染会让实时和重放两条路分叉。
   *  · **只管首个输出之前。** `items` 一旦有东西就不再是这回事 —— 那是 S12
   *    「等太久没动静」,产品 2026-08-27 把它的展现撤了(见上面 `head` 里的裁决原文),
   *    这一行不许换个名字替它回来。
   *  · **不带秒数。** 壳头那句「进行中 1m 7s」说的就是同一段时间,产品 2026-09-04 刚
   *    因为「重复」把头一格思考的计时收掉(`stackOwningFirstThoughts`)。
   */
  const waitingForFirstOutput =
    running
    && shell.items.length === 0
    && (shell.elapsedMs ?? 0) >= WAITING_FIRST_OUTPUT_AFTER_MS;
  /**
   * 连续的推理收成「思考过程」那一格(用户裁决,见 `groupThinking` 的注释)。
   * 壳里有进行中的 todo 时,还在写的那一格在**那条 todo 里**,不在这一层。
   *
   * 等首批输出那一档借的是同一格:壳里空着,`groupThinking` 会补出一格空的 live 思考
   * (它本来就是为「claude 的 thinking 全是空串」准备的),下面只把词换掉。
   * 一个球、一行字,不另起第二种形态。
   */
  const items = groupThinking(shell.items, (thinkingNow || waitingForFirstOutput) && !activeTodo);
  /**
   * 整轮头一格推理落在哪一摞里 —— 只有那一格不报时长(产品 2026-09-04)。
   * 在这里算一次、往下传,而不是让每一摞各自猜:「头一格」是**整轮**的概念,
   * 抽屉自己看不见外面还有没有更早的一段。
   */
  const firstThoughtsStack = stackOwningFirstThoughts(shell.items);
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
            firstThoughtsStack,
            mutedThoughtsIndex: mutedThoughtsIndexOf(items, shell.items, firstThoughtsStack),
            /* 模型没在想、壳里也还什么都没有 —— 那一格的词换成「等待首批输出中」 */
            waitingForFirstOutput: waitingForFirstOutput && !thinkingNow,
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

/**
 * 整轮**头一格**推理落在哪一摞里 —— 只有那一摞的第一格「思考」不报时长。
 *
 * 产品 2026-09-04,看着一轮正在跑的执行记录:「这里首次 thinking 我看是有一个计时的,
 * 能不能不要计时, 不然跟上面一行的进行中的计时有点重复」。
 *
 * **这不是样式偏好,是两个数说的同一件事。** thinking 事件一个时刻都不带
 * (`contract.ts` 的 `ShellText.elapsedMs` 逐字记着:daemon 送出的 `thinking_delta`
 * 载荷就是 `{ type, delta }`,落库形态是 `{ kind: 'thinking', text }`),它的时长只能
 * 靠「填掉了哪一段空白」反推 —— 上一件带时刻的事结束到下一件带时刻的事开始。
 * **头一格前面什么都没有**:`build-turn-blocks` 给它的起点是 `input.startedAtMs`
 * (轮次开头),而壳头那句「进行中 1m 9s」的起点(`shellElapsed` 的 `isFirst` 分支)
 * 是同一个时刻,跑着的时候终点也同是 `nowMs`。两行贴着,写的是同一个数。
 * 别再「顺手把丢掉的数字补回来」—— 补回来的是壳头那个数的复读。
 *
 * 后面几格**不能跟着压**:它们填的是两次工具调用之间的空白,那个数是新信息
 * (2026-09-02「进行中的行都得有计时」那条裁决在别的位置一格没动)。
 *
 * **「头一格」是整轮一格,不是每条 todo 抽屉各来一格。** 有清单时推理落进当前那条
 * in_progress 的 todo(`build-turn-blocks` 的 `sink()`),所以整轮头一格完全可能在
 * 抽屉里 —— 它仍然是整轮的头一格,压的就是它;而第二条抽屉里那一段填的是两次调用
 * 之间的空白,照旧报。于是这里按**文档顺序**走:壳顶层从上往下,遇到 todo 先钻进
 * 它的抽屉,找到第一段就停,返回**装着它的那个数组**。
 *
 * 只压**显示**,数据一个字不动:`ShellText.elapsedMs` 照旧算、照旧挂在条目上 ——
 * 壳头和 todo 抽屉的耗时都要把这一段算进去
 * (`tests/runtime/chat/shell-elapsed-includes-thinking.test.ts`)。
 * 判据钉在 `tests/components/chat/first-thoughts-no-elapsed.test.tsx`。
 */
function stackOwningFirstThoughts(items: ShellItem[]): ShellItem[] | null {
  for (const item of items) {
    if (isThinking(item)) return items;
    if (item.kind === 'todo') {
      const nested = stackOwningFirstThoughts(item.segment.items);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * **这一摞**里被压住的那一格排第几;`-1` = 整轮头一格不在这一摞里。
 *
 * 摞的身份用**数组引用**认(顶层是 `shell.items`,抽屉是 `segment.items`)——
 * 上面那个函数返回的就是这个引用。
 */
function mutedThoughtsIndexOf(
  grouped: GroupedShellItem[],
  stack: ShellItem[],
  firstStack: ShellItem[] | null,
): number {
  if (firstStack !== stack) return -1;
  return grouped.findIndex((item) => item.kind === 'thoughts');
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
  /** 整轮头一格推理落在哪一摞里 —— 抽屉要拿它认出自己是不是那一摞(`stackOwningFirstThoughts`) */
  firstThoughtsStack: ShellItem[] | null;
  /** **这一摞**里被压住时长的那一格排第几;`-1` = 不在这一摞 */
  mutedThoughtsIndex: number;
  /**
   * 这一轮还卡在首个输出之前,而且模型也没在想 —— 那一格空思考的词换成
   * 「等待首批输出中」。判据与三条边界在组件里 `waitingForFirstOutput` 那段。
   * 只可能为真于**壳顶层**(抽屉里有 todo 就意味着壳里已经落过东西)。
   */
  waitingForFirstOutput: boolean;
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
        /* 整轮头一格:数照旧算得出,只是不写出来(理由在 `stackOwningFirstThoughts`) */
        muted={index === ctx.mutedThoughtsIndex}
        /*
         * 一段推理都没落下来的那一格才可能是「在等首批输出」——
         * 有正文就说明模型已经在想了,那时候「思考中」才是实话。
         */
        waiting={ctx.waitingForFirstOutput && item.live === true && item.texts.length === 0}
        live={item.live === true}
        t={ctx.t}
        deferBody={ctx.deferCollapsedBodies}
      />
    );
  }
  if (item.kind === 'tool') {
    return (
      <ToolRow
        /* key 只认 tool_use id + 位置:同一次调用从「在跑」变成「跑完」必须是
           **同一行换状态**,不能先出一行 running 再新增一行 done(那就成了重复)。 */
        key={`tool-${item.id}-${index}`}
        row={item}
        onOpenFile={ctx.onOpenFile}
        fileScope={ctx.fileScope}
        deferBody={ctx.deferCollapsedBodies}
        /* 没回来的调用画成转圈还是中性灰,取决于这一轮还在不在跑 */
        running={ctx.running}
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
        /* 没回来的格子画成转圈还是中性灰,取决于这一轮还在不在跑(同 `ToolRow`) */
        running={ctx.running}
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
 * ⚠️ 那枚 brain 是**线性**的(`Icon name="brain"` → remix 的 `brain-line`),
 * 不是实心的 `brain-fill`。产品 2026-09-02 交付的 `brain-line.svg` 逐字节就是
 * 这一条,所以那一轮「换图标」到这里是**零改动**。判据钉在
 * `tests/components/chat/thoughts-row-icon.test.tsx`,别顺手换成 fill 版。
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
 * **正在想的那一格也挂**(产品 2026-09-02,**有意偏离设计稿**)。
 * 这一行原来是 `live ? null : formatElapsed(...)`,依据是稿子里那一格的说明:
 *   「不挂耗时:这一行**只活到第一个字落地为止**,给一个马上要消失的状态配一个跳动的
 *     秒数,只会把注意力钉在一个从此不再相关的数字上;总耗时在任务进度那一格里。」
 * 产品推翻的是它的**前提**:对推理模型来说这一行根本不「马上消失」—— 真实数据里有
 * 单轮思考 28.5 分钟、单个 Bash 卡住 14.1 分钟的案例(诊断包 run `3fc3b3ae`),
 * 用户的实感是「跑了 40 分钟什么都没出来」,而那 40 分钟里执行记录上一个数字都没有。
 * 产品原话:「为啥思考中不会有计时?我感觉**进行中的 toolrow 都得有计时**吧?」
 *
 * 秒数**不是这里算的**,也没有新起定时器:`build-turn-blocks` 用轮次共用的实时终点
 * (`liveEndMs`,由 `AssistantMessage` 那一个既有 interval 每秒喂进来)把它算好,
 * 这一层只负责画。判据钉在 `tests/components/chat/live-row-elapsed.test.tsx`。
 *
 * ⚠️ 这个 span **不许挂 `aria-live`** —— 挂了读屏会每秒念一遍秒数。
 */
function ThoughtsRow({ texts, elapsedMs, muted, waiting, live, t, deferBody }: {
  texts: string[];
  elapsedMs: number | null;
  /**
   * 整轮**头一格** —— 它的数和壳头那个是同一个,写两遍就是复读(产品 2026-09-04)。
   * 判据与完整理由在 `stackOwningFirstThoughts`。
   */
  muted: boolean;
  /**
   * 这一格不是「模型在想」,是「这一轮还没等到第一个输出」—— 只换那一行字,
   * 球、扫光、三个点、右边不写数,一件不动。判据在组件里 `waitingForFirstOutput` 那段。
   */
  waiting: boolean;
  live: boolean;
  t: RenderCtx['t'];
  deferBody: boolean;
}): ReactElement {
  /*
   * 两态同一句话:有数就画。「正在想的不报时长」那条已被产品推翻(见上面的注释),
   * 2026-09-04 只把**整轮头一格**这一个位置收了回去。
   *
   * 压住时给空串而不是 `undefined`:稿子给进行中的折叠行画的就是
   * `<span class="ms"></span>` —— **槽在、值空**(`Foldable` 里 `!= null` 那一条)。
   * 槽留着,思考行和它下面的工具行左右两栏对得上,箭头也不会因为少一个槽而挪位;
   * 而真的**拿不到**数那一档仍然连槽都没有,两件事在 DOM 上分得开。
   */
  const elapsed = muted ? '' : formatElapsed(elapsedMs);
  /*
   * 还在写的时候贴底跟随(用户 2026-09-02)。判据复用 ChatPane 那一套
   * (`runtime/chat/stick-to-bottom.ts`),这里只负责把限高盒子交给它。
   * 想完了那一档不跟随 —— 那是用户专程点开来读的。
   */
  const bodyRef = useRef<HTMLDivElement>(null);
  useThinkingFollow(bodyRef, live);

  /*
   * 两态的行首都占**同一只 16px 图标槽**(`.icon`)。这是「左边缘不会跳」的另一半:
   * 光把整格缩进补齐还不够 —— 球自带 `margin-inline: -2px`(`.orb[data-orb-box='20']`,
   * 下面那行传的就是 `box={20}`),直接摆在 summary 里会比 brain 图标再左 2px,
   * 思考一结束整行横跳一下。
   * 塞进 `place-items: center` 的槽里之后,后面的字只看槽宽,两态一致。
   * (在 Chrome 里量过:补之后两态的字都落在 x=23。)
   *
   * ⚠️ 这段里的数被两次改动挪过,别照着更早的注释回改:
   *   · `93d0f16b93` 把球从 box 24 换成 box 20,负边距跟着 −3px → −2px;
   *   · `629cb3586a` 把槽从 15px 提到 16px(和它装的图标同宽),字的落点 22 → 23。
   *   `.step`(计划序号)和 `.mark`(状态记号)**没跟着动**,两列仍是 15px ——
   *   别把这里的 16 顺手套到那两列上,判据在 `w76-icon-slot.test.tsx`。
   */
  const summary = live
    ? (
      <>
        {/* 不给标签:紧跟着的就是「思考中」那行字 */}
        <span className={styles.icon}><Orb state="composing" box={20} className={styles.orb} /></span>
        <span className={styles.shimmer}>
          {/*
            * 「等待首批输出中」是**已有的文案**,19 个 locale 都在
            * (`i18n/types.ts` 的 `assistant.waitingFirstOutput`),只是一直没人读 ——
            * `docs/design/run-errors/implementation-audit.md` 把它记成死键。
            * 这里是它第一个读者,不新造一句产品文案。
            */}
          {t(waiting ? 'assistant.waitingFirstOutput' : 'chat.record.thinking')}
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
      /* **两态共用同一套限高**:`max-height` + 普通滚动条,用户自己滚。
         用户 2026-08-27:「thought 展开应该有个最高高度, 可以滚动」;
         2026-09-02 又确认进行中那一档同样要:「但我记得 thinking 下面文本不是有最大
         高度吗?就跟那个 thinking 完成后的展示那样,有最大高度」。
         这里曾经写 `scroll={!live}`,把限高当成「想完了」才有的东西 —— 那是把「限高」
         和被推翻的「定高 + 慢速分步滚 + 渐隐」混成了一件事。详见 `.scroll` 的注释。 */
      scroll
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
      /* 计划卡是这条链的头:它和下面几条 todo 一起构成「步骤」那一层(见 `TodoRow` 的注释) */
      className={styles.stepRow}
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
  /**
   * **进行中那一条也挂耗时**(产品 2026-09-02,**有意偏离设计稿**)。
   *
   * 这里原来是 `segment.status === 'in_progress' ? null : …`。稿子确实这么画:
   * 组件 7 全稿 10/10 条进行中都没有 `.ms` 槽,理由写在 Thinking 那一格 ——
   * 「这一行只活到第一个字落地为止,给一个马上要消失的状态配一个跳动的秒数,
   * 只会把注意力钉在一个从此不再相关的数字上;总耗时在任务进度那一格里」,
   * 而那颗会跳的绿点就是秒数的替代品。
   *
   * 推翻的理由是**前提不成立**:一步活能跑上半小时(真实数据:单轮思考 28.5 分钟、
   * 单个 Bash 卡住 14.1 分钟,诊断包 run `3fc3b3ae`),用户的实感是「跑了 40 分钟
   * 什么都没出来」。产品原话:「为啥思考中不会有计时?我感觉**进行中的 toolrow
   * 都得有计时**吧?」—— 裁决覆盖思考中 / 工具行 / 步骤行三类。
   *
   * 秒数由 `build-turn-blocks` 从轮次共用的实时终点推出来(零新增定时器),
   * 这一层只负责画;槽本身不许挂 `aria-live`(读屏会每秒念一遍)。
   * 守卫在 `tests/components/chat/live-row-elapsed.test.tsx`。
   */
  const elapsed = formatElapsed(segment.elapsedMs);
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
      /*
       * **相位,不是初始值**(W24 的 `lifecycleOpen`)。这里原来是 `defaultOpen`,
       * 而 `defaultOpen` 只在挂载那一帧被看一眼 —— 这一行的 key 是
       * `todo-${segment.content}-${index}`,状态从 `in_progress` 翻成 `completed`
       * 时内容和位置一个字都没变,于是同一个实例、同一份内部折叠态,**跑完还摊着**。
       * `lifecycleOpen` 每次变都跟,但用户自己动过之后就不再跟。
       * 守卫在 `tests/components/chat/todo-row-lifecycle-collapse.test.tsx`。
       */
      lifecycleOpen={segment.status === 'in_progress'}
      deferBody={ctx.deferCollapsedBodies}
      /*
       * **这一行是一步** —— 那条竖线和它带来的 22px 那一列只属于步骤这一层。
       *
       * 判据必须是**正面**的:壳顶层混着思考、工具行、正文、计划卡、步骤五种东西,
       * 靠 `:not(.thoughts)` 之类逐个排除,每加一种新块型就漏一次;挂一个 `stepRow`
       * 之后,新块型默认**不在链上**,漏的方向是安全的那一边。
       * 用户 2026-09-02:「如果是在 todo 外的 toolrow 或者普通文本,或者 thinking,
       * 不要有任何的缩进了,也不要这个竖着的灰线」。
       */
      className={styles.stepRow}
    >
      {expandable
        ? items.map((item, i) => renderItem(item, i, {
            ...ctx,
            /* 抽屉里那一摞有自己的顺序:还在写的那一段只可能在**进行中**那条 todo 的末尾 */
            liveTextIndex: liveTextIndexOf(items, ctx.running && segment.status === 'in_progress'),
            /* 整轮头一格可能就落在这条抽屉里(有清单时推理进 in_progress 那条) */
            mutedThoughtsIndex: mutedThoughtsIndexOf(items, segment.items, ctx.firstThoughtsStack),
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
