/**
 * 一轮助手消息的事件流 → 界面上的块序列。
 *
 * 这是本次重构的核心。规则密集,每一条都对应一个拍过板的决策,改之前先读:
 *
 *  · D10  执行记录**永远出现**,不等 agent 任何信号;还没内容时是空态
 *  · D11  壳是通用容器,没有类型:有清单就分段,没有就平铺
 *  · D29  ① 第一张壳钉在本轮正文上方  ② 发清单 → 多出第二张,出现在当前位置
 *         ③ 清单期间的输出(工具 / thinking / 正文)收进当前进行中的 todo
 *         ④ todo 全关后工具接在后面,正文回壳外  ⑤ 第一张还空着就来清单 → 它本身变清单卡
 *  · D42  位置维持 ①(评审提过「先正文后工具」,拍板不改位置,靠 D43 解决)
 *  · D43  `done` 之前的正文是**过程叙述**,收进壳里;之后的是**结论**,留在壳外。
 *         done 走正文里的自闭合标记(通道 ②),兜底:清单全关算 done / run 结束提最后一段
 *  · D36  清单里没有 in_progress 时,第一条未完成的当作进行中(codex 全靠这条)
 *  · D26  同一份清单的更新原地改,不新开壳
 *  · D14  不重叠的新清单 = 重新规划:旧的全划线转完成态,仍不新开壳
 *  · D24  每轮只装本轮内容;D25 能不能展开只看本轮有没有内容
 *  · D3   工具调用没有「执行中」档,跑完才落行
 *
 * 一条贯穿始终的约束:**流式下位置不能回溯挪动**。一段话先显示在壳外、后来又挪进壳里,
 * 用户会看到文字跳一下 —— 候选 E 就是因为这个代价被否的。所以所有落点都要「一次到位」,
 * 只有 run 结束那一刻允许有一次重排(liftConclusion)。
 */
import type { PersistedAgentEvent, ProjectMediaTask } from '@open-design/contracts';
import {
  OD_DONE_KEY_ATTR_RE,
  OD_DONE_OPEN_TAG,
  OD_DONE_TAG_RE,
  stripCritiqueGrammar,
} from '@open-design/contracts';
import type {
  BuildTurnInput,
  ExecutionShell,
  ProseBlock,
  ShellItem,
  ShellText,
  TodoSegment,
  ToolRow,
  ImageRow,
  TurnBlock,
} from './contract';
import { computeSkipRanges, rangeContains } from '../../artifacts/markdown-context';
import { UNKNOWN_ELAPSED_BELOW_MS, diffStat } from './format';
import {
  commandFile,
  commandOf,
  fileOf,
  isCommandTool,
  isRawCommandTitle,
  isSnapshotTool,
  searchPattern,
  toolKind,
  toolTitle,
} from './tool-kind';

/**
 * done 标记 —— **每轮一次性密钥**。
 *
 * 形如 `<od-done key="a7f3c91ed2b40561"/>`:daemon 每个 run 现生成一个随机 key,
 * 注入系统提示词,同时用 `done_key` 事件随 SSE 下发。客户端只认这一轮的 key。
 *
 * 为什么非要密钥:原来的判据是裸 `<done/>`,而这个字样**在产品提示词里从来没教过** ——
 * 全仓库只有设计模拟器里有。也就是说线上没有任何 agent 被要求发它,每一次命中按定义
 * 都是「正文里碰巧出现」。于是它可以被内容伪造:让 agent 吐一段含 `<done/>` 的 HTML、
 * 或者让它解释这个标签,后面的正文就被整段甩到壳外(有 todo 时结论甚至提前逃出 todo)。
 * 模型复制不出它没见过的随机串,密钥形式因此伪造不了。
 *
 * 自闭合而不是把结论包起来:包起来要等闭合标签到了才能显示,结论会整段憋住,不符合流式。
 *
 * `od-` 前缀跟仓库里既有的协议标记(`<od-title>`、`<od-card>`)对齐,不会撞上
 * agent 真的在写的 HTML 标签。
 *
 * 标记的**形状**是共享契约(`@open-design/contracts` 的 `api/done-marker`),
 * 不在这里另写一份:daemon 要用同一份判据把标记挡在落库正文之外。两边各留一份正则,
 * 迟早会对「什么算一枚标记」产生分歧,而分歧的表现形式就是协议标签出现在用户屏幕上。
 */
/**
 * 密钥出现之前的老判据。**只在这一轮没有 key 时**启用 —— 历史消息里没有 key 事件,
 * 落块结果必须和改动前逐块一致,不能因为「没有 key」就把正文一律吞进抽屉或一律甩到壳外。
 */
const LEGACY_DONE_RE = /<done\s*\/?>/i;
/** 意图澄清表单和产物块算**隐式 done** —— 它们是交给用户看的东西,不是过程叙述 */
const IMPLICIT_DONE_RE = /<(?:question-form|artifact)\b/i;
const OPEN_TAGS = ['<done', '<question-form', '<artifact', OD_DONE_OPEN_TAG];
/** `<od-done` 之后属性还在路上时也要扣住;超过这个长度还没见到 `>` 就放行,免得卡死 */
const MAX_MARKER_HOLD = 96;

const ABANDON_NAME_RE = /(^|__)todo_abandon$/i;

interface RawTodo { content: string; status: string }

/** 还开着的那一段推理:它自己、它落在哪个数组里、它从哪一刻开始填空 */
interface OpenThink { item: ShellText; arr: ShellItem[]; from: number | null }

function readTodoList(input: unknown): RawTodo[] {
  const rec = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const raw = rec.todos ?? rec.plan ?? rec.items;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => {
      const r = t && typeof t === 'object' ? (t as Record<string, unknown>) : {};
      const content = String(r.content ?? r.step ?? r.text ?? '').trim();
      const status = String(r.status ?? (r.completed === true ? 'completed' : 'pending'));
      return { content, status };
    })
    .filter((t) => t.content);
}

function normalizeStatus(status: string): TodoSegment['status'] {
  if (status === 'in_progress' || status === 'completed' || status === 'stopped') return status;
  if (status === 'complete' || status === 'done') return 'completed';
  if (status === 'doing' || status === 'active') return 'in_progress';
  return 'pending';
}

/**
 * 结尾这几个字符会不会是某个标记的开头?是就先扣住不渲染,免得半截 `<do` 闪一下。
 *
 * 密钥标记把这条约束抬高了一档:`<od-done key="a7f3c91ed2b40561"/>` 有 34 个字符,
 * SSE 随时可能把它切在 `<od-done key="a7f` 这种地方。老实现只往回看 14 个字符、
 * 而且只认「整条尾巴是某个标记名的前缀」,`<od-done key="a7f` 两条都不满足 ——
 * 半截标记连带半截 key 会原样画到屏幕上,然后下一帧突然消失变成别的样式。
 *
 * 所以判据变成两条(任一成立就扣住):
 *   · 尾巴还是某个标记名的前缀 —— 标记名没打完,和以前一样;
 *   · 尾巴已经是完整的 `<od-done`,但还没见到 `>` —— key 属性还在路上。
 *
 * 第二条用 `MAX_MARKER_HOLD` 封顶:正文里一个永远等不到 `>` 的孤立 `<` 不能把
 * 后面的输出一直憋住。
 */
function pendingTagTail(text: string): number {
  const open = text.lastIndexOf('<');
  if (open < 0 || text.length - open > MAX_MARKER_HOLD) return 0;
  const tail = text.slice(open).toLowerCase();
  if (OPEN_TAGS.some((tag) => tag.startsWith(tail))) return text.length - open;
  if (tail.startsWith(OD_DONE_OPEN_TAG) && !tail.includes('>')) return text.length - open;
  return 0;
}

/**
 * 标记在**代码里**时不算信号。
 *
 * 围栏代码块和行内代码是 agent 展示标记本身的地方 —— 「这个标记写作 `<done/>`」、
 * 「例子:```html <artifact …> ```」。把它们当信号,后面的正文会被整段甩到壳外,
 * 而正文本来该跟着当前那条 todo 走。
 *
 * 用的是产物剥离器一直在用的那套跳过区间(`artifacts/markdown-context`),
 * 不另写一份 —— 两处要跳过的东西是同一批,规则分家迟早对不上。
 */
function findMarkerOutsideCode(re: RegExp, text: string): RegExpExecArray | null {
  const { ranges } = computeSkipRanges(text);
  const scan = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = scan.exec(text)) !== null) {
    if (!rangeContains(ranges, m.index)) return m;
    if (m.index === scan.lastIndex) scan.lastIndex += 1;
  }
  return null;
}

/** 这一轮的 key —— 整段事件里的第一条 `done_key`。没有就是历史消息 / 旧链路 */
function readRunDoneKey(events: PersistedAgentEvent[]): string | null {
  for (const e of events) {
    if (e.kind !== 'done_key') continue;
    const key = typeof e.key === 'string' ? e.key.trim() : '';
    if (key) return key;
  }
  return null;
}

interface MarkerScan {
  /** 剥掉协议噪音之后,真正要落到界面上的文字 */
  text: string;
  /** done 落在 `text` 的哪个下标;没有就是 null */
  doneAt: number | null;
  /** done 标记本身要从 `text` 里切掉几个字符(隐式 done 的标签要留给消息层,所以是 0)*/
  doneLength: number;
}

/**
 * 把 `<od-done …>` 从可见文字里吃掉,顺手报告第一枚 key 对得上的标记落在**剥完之后**
 * 的哪个下标。
 *
 * 「吃掉」是无条件的:key 对不上、根本没写 key、这一轮压根没启用密钥 —— 都算协议噪音。
 * 和 daemon 的 `<od-title>` 是同一条规矩:标记任何情况下都不许出现在正文里
 * (`apps/daemon/src/title-marker.ts` 里 `enabled` 的注释记着这条的来由:
 * 当年「不请求标题就不剥离」,结果标记原样漏进了线上聊天正文)。
 *
 * 标记在**代码里**时一律不算数,也不吃掉 —— 围栏代码块和行内代码正是 agent 展示标记
 * 本身的地方(「这个标记写作 `<od-done key="…"/>`」)。用的是产物剥离器一直在用的那套
 * 跳过区间(`artifacts/markdown-context`),不另写一份:两处要跳过的东西是同一批,
 * 规则分家迟早对不上。
 */
function stripKeyedDone(text: string, runKey: string | null): { text: string; doneAt: number | null } {
  if (!/<od-done/i.test(text)) return { text, doneAt: null };
  const { ranges } = computeSkipRanges(text);
  const scan = new RegExp(OD_DONE_TAG_RE.source, OD_DONE_TAG_RE.flags);
  let out = '';
  let cursor = 0;
  let doneAt: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = scan.exec(text)) !== null) {
    if (rangeContains(ranges, m.index)) continue; // 代码里的原样保留
    out += text.slice(cursor, m.index);
    if (doneAt == null && runKey) {
      const key = OD_DONE_KEY_ATTR_RE.exec(m[0])?.[1];
      if (key === runKey) doneAt = out.length;
    }
    cursor = m.index + m[0].length;
  }
  return { text: cursor > 0 ? out + text.slice(cursor) : text, doneAt };
}

/** done 已经定了之后只吃噪音,不再判信号 */
function stripKeyedDoneMarkers(text: string): string {
  return stripKeyedDone(text, null).text;
}

/**
 * done 之后仍然要扣住半截 `<od-done` —— 但**只扣它**。
 *
 * `pendingTagTail` 会连 `<artifact` / `<question-form` 一起扣;那两个标签在 done 之后
 * 要原样交给消息层去剥成卡片,多扣一帧没有好处,也改变了既有行为。
 */
function keyedDoneTagTail(text: string): number {
  const open = text.lastIndexOf('<');
  if (open < 0 || text.length - open > MAX_MARKER_HOLD) return 0;
  const tail = text.slice(open).toLowerCase();
  if (OD_DONE_OPEN_TAG.startsWith(tail)) return text.length - open;
  if (tail.startsWith(OD_DONE_OPEN_TAG) && !tail.includes('>')) return text.length - open;
  return 0;
}

/**
 * 一段文字里的协议标记扫描:哪儿是 done、剥掉噪音之后还剩什么。
 *
 * 三条判据,按「谁先出现」取最早的一个:
 *  1. `<od-done key="…"/>` 且 key 等于本轮的 key → 这就是 done。
 *  2. 本轮**没有** key(历史消息)时,裸 `<done/>` 仍然算 —— 旧数据的落块必须原样保住。
 *     反过来说,一旦本轮有了 key,裸 `<done/>` 就退化成普通正文:它可以被内容伪造,
 *     而真信号已经有了不可伪造的形式,没有理由再给伪造留一条路。
 *  3. `<question-form>` / `<artifact>` 一直算**隐式** done —— 它们是交给用户看的东西。
 */
function scanTurnMarkers(raw: string, runKey: string | null): MarkerScan {
  // ① 先吃掉协议噪音,顺手记下第一枚 key 对得上的标记落在哪儿。
  //    先剥再扫,后面两条判据的下标就直接是剥完之后的下标,不用来回换算。
  const stripped = stripKeyedDone(raw, runKey);
  let text = stripped.text;
  let doneAt: number | null = stripped.doneAt;
  let doneLength = 0;

  // ② 密钥标记已经定了位置就用它;否则回落到老判据
  if (doneAt == null) {
    const legacy = runKey ? null : findMarkerOutsideCode(LEGACY_DONE_RE, text);
    const implicit = findMarkerOutsideCode(IMPLICIT_DONE_RE, text);
    if (legacy && (!implicit || legacy.index <= implicit.index)) {
      doneAt = legacy.index;
      doneLength = legacy[0].length;
    } else if (implicit) {
      // 隐式:标签本身要留给后面的正文,由消息层去剥成卡片,所以长度记 0
      doneAt = implicit.index;
      doneLength = 0;
    }
  }

  return { text, doneAt, doneLength };
}

/**
 * 壳 id 只在**本轮内**递增(`shell-1`、`shell-2`)。
 *
 * 用模块级的全局计数器会让同一张壳每次重算都换一个 id —— 消费方拿它当 React key,
 * 换 id 就是重新挂载:用户手点开的折叠态每一帧被拨回去(`Foldable` 的注释里记着这条),
 * 流式期间正好每个 delta 都重算一次。
 */
function makeShell(seq: number): ExecutionShell {
  return {
    kind: 'shell',
    id: `shell-${seq}`,
    status: 'running',
    stopped: false,
    thinking: false,
    elapsedMs: null,
    quietMs: null,
    items: [],
    segments: [],
  };
}

function makeSegment(todo: RawTodo, recalled: boolean): TodoSegment {
  return {
    content: todo.content,
    status: normalizeStatus(todo.status),
    recalled,
    abandoned: false,
    implicit: false,
    items: [],
    elapsedMs: null,
  };
}

/**
 * 上一轮里**真动过手**的那些 todo 的 content —— 也就是「旧账」的全集。
 *
 * 召回要判的是「这一条不是本轮新开的活」(见 `contract.ts` 的 `isStruck`)。
 * 一条 todo 只有在**更早那轮已经开工或已经关掉**时才够得上这句话:
 * 上一轮做完的、做到一半被打断的,本轮再列出来都是欠账。
 *
 * 反过来,一条上一轮只是**说出口、一次都没开始**(`pending`)的 todo,不是欠账 ——
 * 它连开工都没有,本轮把它建出来就是**头一回真的要干**。
 * 真机复现(2026-08-27,产品负责人截图,会话 `7e97c7e9-…`):
 * 某一轮声明了五条就被取消,五条全停在 `pending`;两轮之后 agent 重新建出同样五条
 * (claude 的 `TaskList` 返回 `No tasks found`,并没有从哪儿捞回来),
 * 结果整份**刚开始跑**的计划五条全划线,第一条还同时是「进行中」——
 * 又说「正在做」又说「这是旧账」,自相矛盾。
 *
 * 注意这**不是**「按状态过滤 carry」:上一轮做完的条目照样留在集合里
 * (`todos.ts` 那段注释说的「Recall is matched on content, never on status」
 * 防的是把 carry 砍成只剩未完成项,那会让「召回 · 上一轮就完成的」判不出来)。
 * 这里只把「从没开始过」摘出去,规格 `chat-panel-next.md:274-283` 那张表里
 * 「还没跑的 → 划线 ✗」说的就是它。
 */
function recalledContents(
  previousTodos: BuildTurnInput['previousTodos'],
): Set<string> {
  const out = new Set<string>();
  for (const todo of previousTodos ?? []) {
    if (todo.status === 'pending') continue;
    out.add(todo.content);
  }
  return out;
}

/**
 * 评审剧场语法的**历史兜底**,收口在这里。
 *
 * daemon 侧的流式剥离(`apps/daemon/src/panel-grammar-strip.ts`)只管新流;
 * 用户手上已经有一堆落了库的旧对话,里面原样写着
 * `<CRITIQUE_RUN>` / `<PANELIST role="Critic" score="9.0">`,那些改不回去了。
 *
 * 为什么挂在 `buildTurnBlocks` 的入口:壳内(`SayText` / `ThinkingMarkdown`)和
 * 壳外(消息层的结论段)**同源** —— 两条 lane 的文字都从这里出去。原来的兜底只挂在
 * 壳外的 `ProseBlock` 上,而聊天面板重构把过程叙述搬进了壳内,于是兜底盖住的
 * 正好是没内容的那一半,泄漏原样穿到屏幕上。收在源头,以后再多一个渲染组件也不会漏。
 *
 * 只碰 `text` / `thinking` 两种事件 —— 它们是仅有的两种"直接渲染给人看的自由文本"。
 * 工具入参、文件名之类不碰:那些是结构化字段,里面出现尖括号是内容不是协议。
 *
 * 没有可剥的就返回**同一个数组引用**,连中间数组都不建 —— 绝大多数轮次走这条路,
 * 而这个函数每秒被 `useTickingNow` 重算一次,不能每次都拷一遍整条事件流。
 */
function needsTheaterStrip(
  event: PersistedAgentEvent,
): event is PersistedAgentEvent & { text: string } {
  if (event.kind !== 'text' && event.kind !== 'thinking') return false;
  const text = event.text;
  // 没有尖括号就不可能有标记 —— 省掉绝大多数正则
  return typeof text === 'string' && text.includes('<')
    && stripCritiqueGrammar(text) !== text;
}

function stripTheaterGrammarFromEvents(
  events: readonly PersistedAgentEvent[],
): readonly PersistedAgentEvent[] {
  if (!events.some(needsTheaterStrip)) return events;
  return events.map((event) => (
    needsTheaterStrip(event)
      ? { ...event, text: stripCritiqueGrammar(event.text) }
      : event
  ));
}

export function buildTurnBlocks(input: BuildTurnInput): TurnBlock[] {
  const events = stripTheaterGrammarFromEvents(input.events ?? []);
  /*
   * D10:**跑起来那一刻就该有壳**,不等 agent 的第一条事件。
   * 原来 `ensureShell()` 只挂在事件上,于是第二、三轮每次都要空等一会儿
   * 才看到「进行中」(用户 2026-08-26 真机量到)。
   */
  const turnIsLive = (input.runStatus ?? 'running') === 'running'
    || input.runStatus === 'queued';
  const blocks: TurnBlock[] = [];
  const previous = recalledContents(input.previousTodos);
  /**
   * 本轮的 done 密钥。`null` = 这一轮没有密钥,回落到老判据。
   *
   * 从事件流里读,不从消息字段读:事件流既走 SSE 也落库,一条通路同时管住
   * 「流式中途」和「历史会话重新打开」两种场景,不用为后者再加一个数据库列。
   */
  const runKey = readRunDoneKey(events);

  let shellSeq = 0;
  const nextShell = (): ExecutionShell => {
    shellSeq += 1;
    return makeShell(shellSeq);
  };

  let top: ExecutionShell | null = null;
  let todoCard: ExecutionShell | null = null;
  let current: TodoSegment | null = null;
  let started = false;
  /** 壳内正在累积的那段文字(thinking 或过程叙述)—— 连续的 delta 合并成一段 */
  let openText: ShellText | null = null;
  /**
   * 还没结算的**那一段推理**,以及它落在哪个数组里。
   *
   * thinking 事件一个时刻都不带,所以推理的时长只能靠**它填掉的那段空白**反推:
   * 上一件带时刻的事结束(`from`)到下一件带时刻的事开始(`stamp` 的实参)。
   * `arr` 与 `gapLanded` 一起回答「这段空白是不是它一个人的」—— 见 `ownsGap`。
   * 不是它一个人的就不认:那时候这段空白是几件事分掉的,谁都说不出自己占了多少
   * (§2.2b「拿不到就不显示,不估算」)。
   */
  let openThink: OpenThink | null = null;
  /**
   * **这一段空白里已经落过哪些条目** —— 每次时刻推进(`stamp`)时清空。
   *
   * 只记**自己没有时刻的事件**落下的条目,也就是 `thinking` 与 `text` 这两种
   * (`pushInside` / `pushProse` 两个落点)。工具行 / 清单行 / 生图行不记:
   * 它们背后的事件刚刚推进过时刻,那段时间已经在钟上了,不是空白里的债。
   *
   * 为什么光靠「我是不是这摞的末尾」不够:那个问法只看得见落在推理**后面**的东西。
   * `正文 → 思考 → 工具` 里那段正文落在推理**前面**,末尾判据看不见它 ——
   * 于是同样一段空白,换个顺序就报满整段(见 `ownsGap`)。
   */
  let gapLanded: unknown[] = [];
  /** 壳外正在累积的结论 */
  let openProse: ProseBlock | null = null;
  let doneSeen = false;
  let markerBuf = '';
  let firstStartedAt: number | null = null;
  let lastEndedAt: number | null = null;
  /**
   * **每张壳自己的**起止时刻。
   *
   * 原来耗时是按**轮次**算的:一个 `running` 标志喂给所有壳,于是一轮里两张壳
   * (前半截散活 + 后半截清单)会显示**同一个数并同步递增** —— 上面明明写着
   * 「已完成」,秒数还在往前跑。跑完的壳必须定死在它自己结束的那一刻。
   */
  const shellSpan = new Map<ExecutionShell, { from: number; to: number }>();
  /**
   * **每条 todo 自己的**起止时刻 —— 稿子每条抽屉右侧都挂着它自己的耗时(`18.2s`)。
   * `TodoRow` 早就写了 `formatElapsed(segment.elapsedMs)` 的分支,但这个字段
   * 从来没被算出来过,那一档永远是 null(用户 2026-08-26 真机指认)。
   */
  const segSpan = new Map<TodoSegment, { from: number; to: number }>();
  const widen = <K,>(map: Map<K, { from: number; to: number }>, key: K | null, at: number): void => {
    if (!key) return;
    const span = map.get(key);
    if (!span) { map.set(key, { from: at, to: at }); return; }
    if (at < span.from) span.from = at;
    if (at > span.to) span.to = at;
  };
  const stampShell = (at?: number): void => {
    if (at == null) return;
    widen(shellSpan, activeShell(), at);
    // 事件发生时哪条 todo 在跑,这段时间就算在它头上
    widen(segSpan, current, at);
  };

  const results = new Map<string, Extract<PersistedAgentEvent, { kind: 'tool_result' }>>();
  for (const e of events) if (e.kind === 'tool_result') results.set(e.toolUseId, e);
  const mediaTasks = (input.mediaTasks ?? [])
    .filter((task) => task.surface === 'image')
    .slice()
    /*
     * 并行扇出的那一批 `startedAt` 会**全部相同**(同一毫秒发出去的),按它排等于
     * 没排 —— 顺序变成 `filter` 的输入顺序,每次轮询都可能不一样,格子于是会换位。
     * `sequence` 是 daemon 的创建计数器,平局时用它定序(只比较,不显示也不落库)。
     */
    .sort((a, b) => (a.startedAt - b.startedAt) || ((a.sequence ?? 0) - (b.sequence ?? 0)));
  let mediaTaskCursor = 0;

  const activeShell = (): ExecutionShell | null => todoCard ?? top;
  /** 内容落点:进行中的 todo → 它的 items;有清单卡但 todo 都关了 → 卡片层;否则 → 第一张壳 */
  const sink = (): ShellItem[] => {
    if (current) return current.items;
    const shell = activeShell();
    return shell ? shell.items : [];
  };

  const stamp = (at?: number): void => {
    if (at == null) return;
    closeThink(at);
    // 钟往前走了 = 上一段空白到此为止,下一段空白从零记账
    gapLanded = [];
    if (firstStartedAt == null || at < firstStartedAt) firstStartedAt = at;
    if (lastEndedAt == null || at > lastEndedAt) lastEndedAt = at;
    stampShell(at);
  };

  /**
   * 每一段推理攒下的时长。`null` = 有一截**算不出来**,整段作废 ——
   * 只把算得出的那几截加起来会得到一个偏小的假数,比不显示更糟(§2.2b)。
   */
  const thinkMs = new Map<ShellText, number | null>();

  /**
   * 这一截空白**是不是这段推理一个人的**。
   *
   * 问的是「这段空白里除了它还落过别的东西吗」,**不是**「它现在是不是末尾」。
   * 末尾那个问法只看得见落在推理**后面**的东西,看不见落在它**前面**的,于是
   * 同一段空白换个顺序就换个结论 —— 两个偏大的假数都从这儿来:
   *
   *  · `正文 → 思考 → 工具`:正文在推理之前落下,末尾判据看不见,推理报满整段;
   *    而 `思考 → 正文 → 工具` 正确拒绝。同一段空白,顺序不该改变结论。
   *  · `思考A → 正文 → 思考B`:A 和正文都在 B 之前落下,B 于是把「A 那一份 +
   *    正文那一份 + 自己那一份」一起认领走 —— 兄弟被作废了,时间却被它吞了。
   *
   * 偏大的假数比不给数更糟:偏小还看得出「怎么这么快」,偏大是一个用户会信的数字。
   */
  function ownsGap(open: OpenThink): boolean {
    // 落在它后面、又不经 `gapLanded` 记账的(没有时刻的调用推下来的行)
    if (open.arr[open.arr.length - 1] !== open.item) return false;
    // 落在它前面的,以及落在**别的摞**里的(done 之后的结论走的是 `blocks`)
    return gapLanded.every((landed) => landed === open.item);
  }

  /**
   * 给还开着的那段推理结账:它填掉的空白到 `at` 为止。
   *
   * 这段空白不是它一个人的(`ownsGap`)就**整段作废**,而不是跳过这一截 ——
   * 一段推理可能被结账好几次,只把算得出的那几截加起来会得到一个偏小的假数,
   * 和偏大的假数一样违反 §2.2b。
   *
   * 一段推理可能被结账**好几次**:中间夹着不落行的事件(`TodoWrite`,或者调用发出去
   * 但结果还没回来的工具)时,推理被切成几截却仍是同一段文字。相邻两截共用同一个
   * 时刻端点,所以相加就等于端到端跨度,不会重复计。
   */
  function closeThink(at: number): void {
    const open = openThink;
    openThink = null;
    if (!open) return;
    const prev = thinkMs.get(open.item);
    if (prev === null) return; // 已经作废,不再往上加
    if (!ownsGap(open)) { thinkMs.set(open.item, null); return; }
    const ms = open.from == null ? -1 : at - open.from;
    thinkMs.set(open.item, ms < 0 ? null : (prev ?? 0) + ms);
  }

  /**
   * 把攒下的时长落到条目上。门槛沿用 `UNKNOWN_ELAPSED_BELOW_MS`:
   * 不到 100ms 的空白是「同一批到达」,那是「不知道」不是「想得快」,和工具行同一条判据。
   */
  function settleThink(): void {
    for (const [item, ms] of thinkMs) {
      if (ms != null && ms >= UNKNOWN_ELAPSED_BELOW_MS) item.elapsedMs = ms;
    }
  }

  /** D10:收到本轮第一条事件就开壳,空态先出来,不等任何 agent 信号 */
  const ensureShell = (): void => {
    if (started) return;
    started = true;
    top = nextShell();
    blocks.push(top);
  };

  const pushInside = (text: string, thinking = false): void => {
    const arr = sink();
    const last = arr[arr.length - 1];
    // 只有**同一种**文字才续写:thinking 和回答挨着时必须分成两段,
    // 否则兜底提结论时会把前半截的 thinking 一起拽出去
    const open = openText as ShellText | null;
    if (open && last === open && Boolean(open.thinking) === thinking) {
      open.text += text;
      return;
    }
    if (!text.trim()) return;
    openText = thinking
      ? { kind: 'text', text: text.replace(/^\s+/, ''), thinking: true }
      : { kind: 'text', text: text.replace(/^\s+/, '') };
    arr.push(openText);
    // thinking / text 都不带时刻 —— 它们占掉的是这段空白里的时间,记上账(见 `gapLanded`)
    gapLanded.push(openText);
  };

  const pushProse = (text: string): void => {
    if (openProse && blocks[blocks.length - 1] === openProse) {
      openProse.text += text;
      return;
    }
    if (!text.trim()) return;
    openProse = { kind: 'prose', text: text.replace(/^\s+/, '') };
    blocks.push(openProse);
    // 壳外的结论也是没有时刻的正文,同样占掉这段空白(见 `gapLanded`)
    gapLanded.push(openProse);
  };
  /**
   * done **之前**的一切都收进卡片(2026-08-26 用户裁决,推翻了当天早些时候那条
   * 「没有 todo 时正文落壳外」)。
   *
   * 原话:「没有 todowrite 时,所有工具调用或普通文本或者 thinking,都收拢在
   * 展开收起卡片里;当有了 done 信号之后,输出的平台文本内容才会显示到卡片外面,
   * 但如果有工具调用啥的,还是会收到卡片里。」
   *
   * 所以判据只有一个 —— **done 有没有到**,而不是「有没有 todo」:
   *  · done 之前:工具行 / thinking / 正文,一律进当前 sink
   *    (有 todo 就进当前那条 todo,没有就进壳);
   *  · done 之后:正文走 `pushProse` 出壳(在上面 `event.kind === 'text'` 那一段),
   *    工具调用仍然进壳 —— 它是过程,不是回答。
   *
   * 为什么推翻上一版:上一版让开场白落在壳外,而 `ensureShell` 在循环开头就把壳
   * 压进了 `blocks`,屏幕上就成了「卡片在上、开场白在下」,还和结论粘成一段。
   * 用户真机指认那句「我会严格按 4 步执行」明明是建清单**之前**说的。
   */
  const routeInside = (text: string): void => {
    const arr = sink();
    const open = openText as ShellText | null;
    const merging = !!open && arr[arr.length - 1] === open && !open.thinking;
    if (!text.trim() && !merging) return;
    pushInside(merging ? text : text.replace(/^\s+/, ''));
  };

  for (const event of events) {
    if (event.kind === 'tool_result' || event.kind === 'raw' || event.kind === 'diagnostic') continue;
    if (event.kind === 'conversation_title' || event.kind === 'plugin_candidate') continue;
    // `done_key` 是协议元数据,不是这一轮的内容 —— 在 ensureShell 之前跳掉,
    // 免得「本轮第一条事件」被一条纯协议帧顶掉(D10 的开壳时机由真实事件决定)
    // `next_steps` 同理:它是回合末尾的引导,不是回合的内容,更不该把开壳时机
    // 提前到「这一轮已经有东西了」之前。
    // `artifact_focus` 同理:它说的是「这一轮显示什么」,本身不是这一轮的内容。
    // 它还会在**回合中途**到达(文件一有内容就开预览),所以更不能让它把开壳
    // 时机提前到真正有东西之前。
    if (
      event.kind === 'usage'
      || event.kind === 'done_key'
      || event.kind === 'next_steps'
      || event.kind === 'artifact_focus'
    ) continue;

    ensureShell();

    if (event.kind === 'status') {
      // status 只用来开壳(D10)与在轮末决定 run 状态,自身不落行
      continue;
    }

    if (event.kind === 'live_artifact' || event.kind === 'live_artifact_refresh') {
      // 产物卡由消息层渲染,不属于执行记录
      continue;
    }

    if (event.kind === 'thinking') {
      /**
       * claude 经 daemon 送出的 thinking 全是空串(真实录制 1167/1167):
       * 只有「在思考」这个事实,没有文字。空串不成段,但要让壳知道模型在想 ——
       * 否则设计稿的「思考中」头永远出不来(S21 / W11)。
       */
      const shell = activeShell();
      if (shell) shell.thinking = true;
      const text = event.text ?? '';
      const arr = sink();
      // `openText` 的赋值都发生在 `pushInside` 这个闭包里,TS 的控制流分析看不见,
      // 于是在循环体里把它窄化成了 `null`。显式断开窄化,别让它退化成 never。
      const open = openText as ShellText | null;
      const cont = !!open && open.thinking === true && arr[arr.length - 1] === open;
      if (!text.trim() && !cont) continue;
      pushInside(text, true);
      /*
       * 这一段推理从哪一刻开始「填空」—— 上一件带时刻的事结束的那一刻,
       * 一件都还没有就是轮次开头。连续的 delta 合进同一段,只在**新起一段**时开表。
       */
      const segment = openText as ShellText | null;
      // `openThink` 只在 `closeThink` 这个闭包里被赋值,TS 的控制流分析看不见,
      // 在循环体里会把它窄化成 `null`(和上面 `openText` 同一个坑)。显式断开窄化。
      const think = openThink as OpenThink | null;
      if (segment?.thinking && think?.item !== segment) {
        openThink = { item: segment, arr, from: lastEndedAt ?? input.startedAtMs ?? null };
      }
      continue;
    }

    if (event.kind === 'text') {
      const shell = activeShell();
      if (shell) shell.thinking = false; // 开口说话就不再是「思考中」
      let text = event.text ?? '';

      if (!doneSeen) {
        const scan = scanTurnMarkers(markerBuf + text, runKey);
        markerBuf = '';
        text = scan.text;
        if (scan.doneAt != null) {
          const head = text.slice(0, scan.doneAt);
          if (head) routeInside(head);
          doneSeen = true;
          openText = null;
          openProse = null;
          /*
           * done 一到就**结束当前 todo 的收集**。
           *
           * 不这么做的话,agent 只要没关掉最后一条 todo,结论就会被塞进那条 todo 里 ——
           * 折叠起来之后**用户看不到这一轮的回答**。真实运行时照出来的就是这个
           * (D43 与 D29 ③ 在「done 来时清单还开着」这一点上打架,D43 是后定的,以它为准)。
           *
           * 下面那条 `if (current)` 管的是**另一种情况**:done 之后又来一份新清单
           * (重新规划),那时 `current` 会被重新设上,正文该回到 todo 里 —— 那条仍然成立。
           */
          current = null;
          text = text.slice(scan.doneAt + scan.doneLength);
          if (!text) continue;
        } else {
          const hold = pendingTagTail(text);
          if (hold) {
            markerBuf = text.slice(text.length - hold);
            text = text.slice(0, text.length - hold);
          }
          if (text) routeInside(text);
          continue;
        }
      } else {
        /*
         * done 已经定了,但标记**可能还没到**。
         *
         * 兜底 (a) 在「清单全关」那一刻就把 doneSeen 置上,而 agent 通常正是在关掉
         * 最后一条 todo 之后才发标记 —— 走到这儿时它就是一段还没被吃掉的协议噪音。
         * 不吃掉的话 `<od-done key="a7f3c91ed2b40561"/>` 会连着那串随机字符原样画到
         * 屏幕上。这里只吃噪音、不重新判 done,也不碰老判据:
         * 裸 `<done/>` 与 `<artifact>` 在 done 之后的行为一个字都没变。
         */
        const carried = markerBuf + text;
        markerBuf = '';
        text = stripKeyedDoneMarkers(carried);
        const hold = keyedDoneTagTail(text);
        if (hold) {
          markerBuf = text.slice(text.length - hold);
          text = text.slice(0, text.length - hold);
        }
        if (!text) continue;
      }

      if (current) {
        // done 之后又回到 todo 里(重新规划):正文仍收进那条 todo
        routeInside(text);
        continue;
      }
      pushProse(text);
      continue;
    }

    if (event.kind !== 'tool_use') continue;

    const shell = activeShell();
    if (shell) shell.thinking = false; // 动手了就不再是「思考中」
    stamp(event.startedAt);

    if (ABANDON_NAME_RE.test(event.name)) {
      /** D14 / D15 / D16:作废理由按壳内纯文本渲染,旧清单全划线转完成态,不新开壳 */
      const target = activeShell();
      if (target) {
        for (const seg of target.segments) {
          if (seg.status === 'in_progress') seg.status = 'completed';
          seg.abandoned = true;
        }
        const rec = event.input && typeof event.input === 'object'
          ? (event.input as Record<string, unknown>) : {};
        const reason = typeof rec.reason === 'string' ? rec.reason : '';
        if (reason) {
          openText = null;
          target.items.push({ kind: 'text', text: reason });
        }
      }
      current = null;
      continue;
    }

    if (isSnapshotTool(event.name)) {
      const list = readTodoList(event.input);
      if (!list.length) continue;
      applyTodoList(list);
      openText = null;
      continue;
    }

    const command = isCommandTool(event.name) ? commandOf(event.input) : '';
    /*
     * **判据必须和 `readImageCall` 是同一条**。这里原来只数 `media generate` 出现几次,
     * `od media generate --help` 也算一次,于是游标往前推了一格;而 `readImageCall`
     * 又把 `--help` 拒掉 —— 那一格任务被静默吃掉,真正那次调用拿到空 slice,
     * 组件 12 整行画不出来。查用法不是生图,不许动游标。
     */
    const mediaCallCount = isMediaGenerateCommand(command) ? mediaGenerateCount(command) : 0;
    const { slice: taskSlice, next: nextMediaCursor } =
      takeMediaBatch(mediaTasks, mediaTaskCursor, mediaCallCount);
    mediaTaskCursor = nextMediaCursor;
    const shot = readImageCall(event, results.get(event.id), taskSlice);
    if (shot) {
      ensureShell();
      stamp(event.startedAt);
      const done = results.get(event.id)?.completedAt;
      stamp(done);
      const arr = sink();
      const last = arr[arr.length - 1];
      // S19:连续的生图调用合并成一行 —— 一次生图动作出 N 张,这是组件 12 的前提。
      // 中间隔了别的工具调用就另起一行(隔开的两组是两件事)。
      if (last && last.kind === 'image') {
        last.total += shot.total;
        last.done += shot.done;
        last.failed += shot.failed;
        last.thumbs.push(...shot.thumbs);
        if (shot.cells) last.cells = [...(last.cells ?? []), ...shot.cells];
        last.pending = last.pending || shot.pending;
        if (shot.elapsedMs != null) last.elapsedMs = (last.elapsedMs ?? 0) + shot.elapsedMs;
      } else {
        arr.push(shot);
      }
      openText = null;
      continue;
    }

    const row = buildToolRow(event, results.get(event.id));
    if (!row) continue;
    if (row.elapsedMs != null && event.startedAt != null) stamp(event.startedAt + row.elapsedMs);
    // 还在飞的调用没有终点可 stamp,但**起点**要记 —— 否则壳的跨度停在上一条
    // 结束的时刻,一次长调用期间整只壳看起来没有在推进。
    else if (row.pending) stamp(event.startedAt);
    openText = null;
    sink().push(row);
  }

  if (turnIsLive) {
    /*
     * ACP emits a terminal-backed media tool_use only after the command has
     * exited. Until then, media-task polling is the sole witness that image
     * generation is in progress. Put each unconsumed active task in its own
     * one-cell row at the current sink (normally the active Todo).
     *
     * Once tool_use arrives, the cursor above consumes the same task and this
     * slice becomes empty, so the provisional row cannot duplicate the
     * event-backed ImageRow.
     */
    const unconsumed = mediaTasks.slice(mediaTaskCursor);
    /*
     * 一次「生成配套插图」是**一批**,不是 N 件事(OPEND-2195)。分组是 daemon 给的
     * (`batchId`:同 runId + 同 surface + 生命周期有重叠),前端只照着画。
     * 没有 `batchId` 说明生产方没分组 —— 当成一批一个,**不拿时间去猜**。
     */
    const activeBatches = groupMediaBatches(unconsumed)
      .filter((group) => group.some((task) => task.status === 'queued' || task.status === 'running'));
    if (activeBatches.length > 0) {
      ensureShell();
      const shell = activeShell();
      if (shell) shell.thinking = false;
      openText = null;
      for (const group of activeBatches) {
        for (const task of group) stamp(task.startedAt);
        sink().push(pendingMediaBatchRow(group));
      }
    }
    ensureShell();
  }
  finishTurn();
  /*
   * 空壳不留(B47):跑完之后壳里一件东西都没有,那一行孤零零的「已完成」
   * 不告诉任何人任何事。**还在跑的空壳要留** —— 它就是「进行中」那一行本身。
   */
  const turnStatus = input.runStatus ?? 'running';
  const kept = blocks.filter((b) => {
    if (b.kind !== 'shell') return true;
    if (b.items.length > 0 || b.segments.length > 0) return true;
    // 还在跑:空壳就是「进行中」那一行本身,必须留
    if (turnIsLive) return true;
    /*
     * **失败**那一档要留:壳头写的是「运行失败」,是这一轮唯一说得出「出事了」的
     * 地方(D10 + B18)—— opencode 起手就 401 那种轮次,壳里确实一件事都没有,
     * 但那一行不能跟着消失。
     *
     * **取消**那一档不留。这条原来和失败合在一起,是错的:手动停止不是第四态,
     * 壳头写的仍是「进行中」(秒数停住、状态词不变),对一轮已经停掉的活既没有
     * 信息,又和紧跟在下面那行「已取消」自相矛盾。用户 2026-08-27 指认:
     * 「之前不是说如果 done 之前,没有任何工具调用或 thinking 或普通文案,
     * 就不出现这个了吗?」—— B47 的原话本来就该管到这一格。
     */
    return turnStatus === 'failed';
  });
  return kept;

  /* ── 清单 ─────────────────────────────────────────────────── */

  function applyTodoList(list: RawTodo[]): void {
    if (!todoCard) {
      /*
       * 清单落下时**不另起一张卡**(2026-08-26 用户裁决,推翻当天早些时候那条
       * 「一出现 TodoWrite 就收起前一张、新开一张」)。
       *
       * 为什么推翻:两张卡之间**永远不会有东西隔开**。卡外唯一会出现的内容是
       * done 之后的结论,而 TodoWrite 必然在 done 之前 —— 所以那条规则的产物
       * 一定是两张紧贴的卡:两个「已完成 + 秒数」的头,说的却是同一段连续过程。
       * 顺带它还制造过一个坏画面:两张卡的头显示**同一个耗时**(thinking 事件
       * 不带时刻,前一张只能退回轮次跨度)。
       *
       * 新判据 —— 卡片的边界由**卡外有没有落过东西**决定,不由清单决定:
       *  · 一轮正常跑完 = 一张过程卡(开场白 → 执行计划 → 各条 todo);
       *  · 只有卡外已经落过结论(done 之后)、agent 又接着开新计划继续干时,
       *    才在结论**下面**另起一张 —— 那时有一段正文把两张卡分开。
       */
      const proseSinceShell = !!top && blocks.indexOf(top) < blocks.length - 1;
      if (top && !proseSinceShell) {
        todoCard = top;
      } else {
        if (top && top.status === 'running') top.status = 'done';
        todoCard = nextShell();
        blocks.push(todoCard);
      }
      addPlan(list);
      pickCurrent();
      return;
    }

    const overlap = todoCard.segments.some((a) => list.some((b) => b.content === a.content));
    if (!overlap) {
      // D14:内容完全不重叠 = 重新规划。旧的全部划线转完成态
      for (const seg of todoCard.segments) {
        if (seg.status === 'in_progress') seg.status = 'completed';
        seg.abandoned = true;
      }
      /*
       * 同一条边界规则:卡外落过东西才另起一张卡。
       *
       * done 之后 agent 又开一份新计划继续干 —— 这时结论已经落在卡外,
       * 两张卡中间有一段正文隔着,新开才读得通。没有那段正文就还在原卡里换清单,
       * 否则又是两张紧贴的卡。
       */
      if (blocks.indexOf(todoCard) < blocks.length - 1) {
        if (todoCard.status === 'running') todoCard.status = 'done';
        todoCard = nextShell();
        blocks.push(todoCard);
      } else {
        todoCard.segments = [];
      }
      addPlan(list);
      pickCurrent();
      return;
    }

    // D26:同一份清单的状态推进 —— 原地更新,不新开卡
    for (const todo of list) {
      const seg = todoCard.segments.find((a) => a.content === todo.content);
      const incoming = normalizeStatus(todo.status);
      if (!seg) {
        const created = makeSegment(todo, previous.has(todo.content));
        todoCard.segments.push(created);
        /*
         * **还没开始的那几条也要出行**。
         *
         * 原来这里写着「`status !== 'pending'` 才推成行」,于是清单说「5 步」、
         * 壳里却只看得见正在跑的那 1 条 —— 用户真机指认「下面不是有 5 步吗?
         * 怎么后四步没显示?」。没开始的那几条有它自己的样子(虚线圈 + 不可展开),
         * 「说好几步」和「看得见几步」必须是同一个数。
         */
        todoCard.items.push({ kind: 'todo', segment: created });
        continue;
      }
      // 被隐式点亮的那条,后续清单里仍写 pending 也不退回去(D36)
      const next = incoming === 'pending' && seg.implicit && seg.status === 'in_progress'
        ? 'in_progress'
        : incoming;
      /*
       * **只更新状态,不再补一行**。
       *
       * 从前「还没开始的不出行」,所以一条 todo 从 pending 转成 in_progress 时
       * 要在这里补推一行。现在清单一到就把每条都推成行了(见上面那段注释),
       * 再推就是同一条出现两次 —— 内容和秒数一模一样,用户真机撞到过。
       * 行早就在了,状态是**同一个 segment 对象**上的字段,改它就够。
       */
      seg.status = next;
    }
    const plan = todoCard.items.find((x): x is Extract<ShellItem, { kind: 'plan' }> => x.kind === 'plan');
    if (plan) plan.steps = list.map((t) => t.content);
    pickCurrent();
  }

  function addPlan(list: RawTodo[]): void {
    if (!todoCard) return;
    todoCard.items.push({ kind: 'plan', steps: list.map((t) => t.content) });
    for (const todo of list) {
      const seg = makeSegment(todo, previous.has(todo.content));
      todoCard.segments.push(seg);
      // 还没开始的那几条也出行 —— 「说好几步」和「看得见几步」必须是同一个数(见下方同类注释)
      todoCard.items.push({ kind: 'todo', segment: seg });
    }
  }

  function pickCurrent(): void {
    if (!todoCard) return;
    current = todoCard.segments.find((s) => s.status === 'in_progress') ?? null;
    if (!current) {
      /**
       * D36 隐式进行中:清单里一条 in_progress 都没有 → 第一条未完成的就是当前。
       * codex 原生清单只有做完 / 没做完两档(daemon 把没做完映射成 pending),
       * 没有这条规则,codex 整轮的工具都落不进任何 todo。
       */
      const first = todoCard.segments.find((s) => s.status === 'pending' && !s.abandoned);
      if (first) {
        first.status = 'in_progress';
        first.implicit = true;
        // 行在清单落下时就推过了,这里**只点亮状态**;再推一次就是同一条出现两次
        current = first;
      }
    }
    if (!current && todoCard.segments.length) {
      // 兜底(a):清单全部关掉 = 这一轮的活干完了,后面说的就是结论(D43 ④)
      doneSeen = true;
      openText = null;
    }
  }

  /* ── 收尾 ─────────────────────────────────────────────────── */

  /**
   * 兜底(c):整轮没发过 done —— 在 run 结束、壳收起的**那一刻**把最后一段过程叙述
   * 提出来当结论。只动这一次,不在流式中途挪动(中途挪动正是候选 E 的代价)。
   */
  function liftConclusion(): void {
    if (doneSeen) return;
    const shell = todoCard ?? top;
    if (!shell) return;
    /*
     * 从**当前 sink** 里提:有 todo 就是那条 todo 的抽屉,没有就是壳本身。
     *
     * 为什么没有 todo 时也要提:2026-08-26 最终裁决之后,done 之前的一切都在卡片里,
     * 而卡片跑完默认收起 —— 一个「只答话、不调工具、又没发 done」的普通回合,
     * 整段答案会被埋在收起的抽屉里,用户看不到自己问题的答案。
     *
     * **thinking 不提**:它是过程不是结论,提出来就是把「想什么」当成「答什么」。
     * 踩过一次:整轮只有一句 thinking 时它被提到壳外、壳空掉后整张壳被丢,
     * 「思考中」那一格直接没了。所以 `ShellText` 带 `thinking` 标记,这里认它。
     */
    const arr = current ? current.items : shell.items;
    const last = arr[arr.length - 1];
    if (!last || last.kind !== 'text' || last.thinking || !last.text.trim()) return;
    arr.pop();
    blocks.push({ kind: 'prose', text: last.text });
  }

  function finishTurn(): void {
    const status = input.runStatus ?? 'running';
    const running = status === 'running' || status === 'queued';

    /*
     * 收尾那一段推理:轮次终止之后,它填掉的那段空白的终点就是**轮次的收尾时刻**。
     * 还在跑时**不结账** —— 那一格正在写,正在想的不报时长(和进行中的 todo 同一条规矩)。
     */
    if (!running && input.endedAtMs != null) closeThink(input.endedAtMs);
    settleThink();

    /* 每条 todo 落自己的耗时(稿子每条抽屉右侧那个 `18.2s`) */
    for (const [seg, span] of segSpan) {
      const ms = span.to - span.from;
      seg.elapsedMs = ms > 0 ? ms : null;
    }

    /*
     * 壳与轮次的边界 —— 哪张壳开了这一轮、哪张壳收了这一轮(见 `shellElapsed`)。
     * `todoCard` 常常就是 `top` 本人(D50 之后清单不另起卡),所以要去重再数。
     */
    const firstShell = top;
    const lastShell = todoCard ?? top;

    for (const shell of [top, todoCard]) {
      if (!shell) continue;
      // 只有**还在跑的那张**跟着 now 走;先结束的那张定在自己的最后一刻
      const live = running && shell === activeShell();
      shell.elapsedMs = shellElapsed(live, shell, shell === firstShell, shell === lastShell);
      shell.quietMs = shellQuiet(live, shell);
    }

    if (running || !started) return;

    liftConclusion();

    if (status === 'canceled') {
      // 手动停止:壳保持「进行中」,只挂旗标(B7 / W4)
      for (const shell of [top, todoCard]) {
        if (!shell) continue;
        shell.stopped = true;
        closeRunningSegments(shell);
      }
      return;
    }

    for (const shell of [top, todoCard]) {
      if (!shell) continue;
      if (status === 'failed' && shell === (todoCard ?? top)) shell.status = 'failed';
      else if (shell.status === 'running') shell.status = 'done';
      closeRunningSegments(shell);
    }
  }

  /**
   * 上一件事之后过了多久 —— S12 用它决定要不要把「进行中」换成「还在等」那句话。
   *
   * 和 `shellElapsed` 的差别只在起点:那个从**轮次开头**量(总耗时),
   * 这个从**最后一刻**量(静默)。壳里还一件事都没有时(卡在首个 token 的那种,
   * 正是这条要救的场景)退回轮次开头 —— 那时候「等了多久」和「跑了多久」本来就是一回事。
   */
  function shellQuiet(running: boolean, shell?: ExecutionShell): number | null {
    if (!running || input.nowMs == null) return null;
    const span = shell ? shellSpan.get(shell) : undefined;
    const stamped = (span ? span.to : lastEndedAt) ?? firstStartedAt ?? input.startedAtMs ?? null;
    /*
     * 事件自带的时刻只覆盖一小部分:真机 run 里 119 条事件只有 12 条带时刻,
     * 其余是 claude 的 thinking / tool_input 增量,一条都不带。只看它们的话,
     * 模型一路吐字而界面报「上游响应慢」—— 那个秒数还正好等于整轮耗时,
     * 因为起点退回了轮次开头。所以再认一个**到达时刻**:哪条更晚用哪条。
     */
    const last = input.lastEventAtMs != null && (stamped == null || input.lastEventAtMs > stamped)
      ? input.lastEventAtMs
      : stamped;
    if (last == null) return null;
    const ms = input.nowMs - last;
    return ms > 0 ? ms : null;
  }

  /**
   * 壳头的耗时。
   *
   * **一条不变量:开这一轮的那张壳从轮次开头开始走表,收这一轮的那张壳走到轮次收尾为止。**
   * 因为 `ensureShell()` 是在**本轮第一条事件**上开的第一张壳(D10),而最后一张壳
   * 一直开到轮次终止 —— 那两个时刻本来就是它俩自己的边界,不是借来的。
   *
   * 为什么必须这么算(用户 2026-08-27 指认「耗时好像没有算进 thought 的耗时」):
   * 壳自己的跨度 `shellSpan` **只由带时刻的事件撑开**,而带时刻的只有 `tool_use.startedAt`
   * 与 `tool_result.completedAt`;thinking 一个时刻都不带(daemon 那边的载荷就是
   * `{ type: 'thinking_delta', delta }`)。于是**第一个工具调用之前**和**最后一个工具
   * 结果之后**的推理全部被切掉。本机 38 条带推理的真实 run 逐条量过,壳头无一例外少报:
   * `4347efff` 整轮 6m 12s、壳头写 3m 11s(掐掉开头那 2m 34s 的推理);
   * `3be1d04d` 整轮 5m 54s、壳头写 **1.4s**;`9bbe3832` 整轮 2m 17s、壳头**一个数都不显示**。
   * 补上两头的边界之后,单壳的那一轮壳头就等于轮次自己的跨度 —— 推理自然全在里面。
   *
   * 两张壳的那一轮仍然分得开:第一张拿轮次**开头**、最后一张拿轮次**收尾**,
   * 中间那道缝(卡外那段结论)谁也不领。两张写上同一个数的 T34 坏画面
   * (`chat-panel-feedback.md`「被推翻的两条」)因此在结构上就出不来。
   */
  function shellElapsed(
    running: boolean,
    shell: ExecutionShell | undefined,
    isFirst: boolean,
    isLast: boolean,
  ): number | null {
    const span = shell ? shellSpan.get(shell) : undefined;
    let from = span ? span.from : firstStartedAt;
    let to = span ? span.to : lastEndedAt;

    // 开这一轮的那张壳:表从轮次开头就开始走(第一个工具之前的推理在这一截里)
    if (isFirst && input.startedAtMs != null) {
      from = from == null ? input.startedAtMs : Math.min(from, input.startedAtMs);
    }
    /*
     * 收这一轮的那张壳:走到轮次收尾为止 —— 跑着的时候「收尾」就是现在,秒表继续走。
     * `running` 只可能落在最后一张壳上(调用处的 `live` 判据是 `shell === activeShell()`,
     * 而 `activeShell()` 就是这里的最后一张),所以秒表不需要另开一条分支。
     */
    const turnEnd = running ? input.nowMs : input.endedAtMs;
    if (isLast && turnEnd != null) {
      to = to == null ? turnEnd : Math.max(to, turnEnd);
    }
    if (from == null || to == null) return null;
    const ms = to - from;
    /*
     * 门槛用 `UNKNOWN_ELAPSED_BELOW_MS` 而不是 `> 0`:整张壳的跨度不到 100ms,
     * 意思是壳里所有带时刻的事**同一批到达**(codex 的 `tool_use` 与 `tool_result`
     * 间隔 p50 4ms),那不是「跑得快」,是「不知道」—— 和 `format.ts` 开头给
     * 单条工具行定的判据是同一条。
     */
    return ms >= UNKNOWN_ELAPSED_BELOW_MS ? ms : null;
  }
}

/**
 * 轮次一旦终止,壳里不能再有东西「正在跑」。
 *
 * agent 收尾时忘了发最后一次清单是常事(有的干脆整轮只发一次),
 * 于是壳头写着「已完成」,里面那条 todo 还顶着进行中 —— 一颗永远转下去的球。
 *
 * 收成 `stopped` 而不是 `completed`:我们只知道它**没跑完就结束了**,不知道它成没成。
 * 标成完成是替 agent 说了它没说过的话;`stopped` 画出来是中性灰,红留给真的错误。
 * 手动停止走的也是这一条 —— 对那条 todo 来说,两种结局是同一件事。
 */
function closeRunningSegments(shell: ExecutionShell): void {
  for (const seg of shell.segments) {
    if (seg.status === 'in_progress') seg.status = 'stopped';
  }
}

/* ── 生图行(组件 12)─────────────────────────────────────────── */

/** 查用法不算生图 */
const MEDIA_GENERATE_RE = /media\s+generate/;

function mediaGenerateCount(command: string): number {
  return (command.match(/media\s+generate/g) ?? []).length;
}

/** 生图判据的**唯一**出处 —— 游标和 `readImageCall` 必须问同一个人 */
function isMediaGenerateCommand(command: string): boolean {
  return MEDIA_GENERATE_RE.test(command) && !/--help\b/.test(command);
}

/**
 * 这次调用消费掉哪几条任务。
 *
 * 有 `batchId` 时**批就是边界**:一次「生成配套插图」在 daemon 那边已经分好组了,
 * 前端再拿命令行里数出来的次数去切,只会把同一批切成两半(命令写一次 `--count 3`
 * 就是最常见的一种)。没有 `batchId` 才退回按次数切 —— 那是没分组的生产方,
 * 行为和以前逐字一致。
 */
function takeMediaBatch(
  tasks: ProjectMediaTask[],
  cursor: number,
  count: number,
): { slice: ProjectMediaTask[]; next: number } {
  if (count <= 0) return { slice: [], next: cursor };
  const first = tasks[cursor];
  if (!first) return { slice: [], next: cursor };
  const batchId = first.batchId;
  if (batchId == null) {
    return { slice: tasks.slice(cursor, cursor + count), next: Math.min(tasks.length, cursor + count) };
  }
  let end = cursor;
  while (end < tasks.length && tasks[end]?.batchId === batchId) end += 1;
  return { slice: tasks.slice(cursor, end), next: end };
}

/** 按 `batchId` 归组,保持首次出现的顺序;没有 `batchId` 的各自成组(一批一个) */
function groupMediaBatches(tasks: ProjectMediaTask[]): ProjectMediaTask[][] {
  const groups: ProjectMediaTask[][] = [];
  const byBatch = new Map<string, ProjectMediaTask[]>();
  for (const task of tasks) {
    if (task.batchId == null) { groups.push([task]); continue; }
    const existing = byBatch.get(task.batchId);
    if (existing) { existing.push(task); continue; }
    const group = [task];
    byBatch.set(task.batchId, group);
    groups.push(group);
  }
  return groups;
}

/**
 * 这一行要摆几个格子 = 这一批已知有几张(`batchSize`,即 N/M 里的 M)。
 *
 * `batchSize` 只涨不退(批关掉就冻结),所以拿它当分母,进度条不会往回走。
 * 生产方没报 `batchSize` 时才退回 `fallback` —— 老数据和不分组的生产方照旧。
 */
function mediaBatchTotal(tasks: ProjectMediaTask[], fallback: number): number {
  let declared = 0;
  for (const task of tasks) {
    if (typeof task.batchSize === 'number' && task.batchSize > declared) declared = task.batchSize;
  }
  return Math.max(1, declared, fallback, tasks.length);
}

/**
 * 每条任务落在第几格。
 *
 * `batchIndex` 是 1-based 的批内位置,减一就是格子下标 —— 于是一格失败之后重排、
 * 或者轮询把顺序打乱,那一格仍然是它自己,`onRetry` 收到的坐标也还指向同一张图。
 *
 * **要么全按 `batchIndex`,要么全按到达顺序**:只有一半任务报了位置时,混着排会把
 * 另一半悄悄挪位。宁可整批退回到达顺序 —— 那是可预期的,错位不是。
 */
function mediaCellSlots(tasks: ProjectMediaTask[], total: number): number[] {
  const slots = tasks.map((task) => {
    const at = task.batchIndex;
    return typeof at === 'number' && Number.isInteger(at) && at >= 1 && at <= total ? at - 1 : -1;
  });
  const usable = slots.every((slot) => slot >= 0) && new Set(slots).size === slots.length;
  return usable ? slots : tasks.map((_, i) => i);
}

/** 轮询先于 terminal `tool_use` 到达时的一批 —— 一行,`batchSize` 个格子 */
function pendingMediaBatchRow(group: ProjectMediaTask[]): ImageRow {
  const head = group[0]!;
  const total = mediaBatchTotal(group, 1);
  const slots = mediaCellSlots(group, total);
  const cells: NonNullable<ImageRow['cells']> = Array.from({ length: total }, () => ({ status: 'pending' as const }));
  group.forEach((task, i) => {
    const slot = slots[i];
    if (slot != null && slot < total) cells[slot] = { taskId: task.taskId, status: 'pending' };
  });
  return {
    kind: 'image',
    id: head.batchId != null ? `media-batch:${head.batchId}` : `media-task:${head.taskId}`,
    total,
    done: 0,
    failed: 0,
    thumbs: [],
    cells,
    pending: true,
    elapsedMs: null,
  };
}

/**
 * 认出一次生图调用,并把结果读成「出了几张 / 砸了几张 / 图在哪」。
 *
 * `od media generate` 的输出是**每行一个 JSON**(失败行里还嵌着 error 对象),
 * 所以逐行 parse,parse 不动的行退回正则抠 `status`。
 * 一条状态都读不出来时分两种:命令本身报错 → 整组算失败;否则说明这压根不是一次
 * 真正的生图(比如在查参数),回落成普通命令行,别硬画成图。
 */
function readImageCall(
  event: Extract<PersistedAgentEvent, { kind: 'tool_use' }>,
  result: Extract<PersistedAgentEvent, { kind: 'tool_result' }> | undefined,
  tasks: ProjectMediaTask[] = [],
): ImageRow | null {
  if (!isCommandTool(event.name)) return null;
  const command = commandOf(event.input);
  if (!MEDIA_GENERATE_RE.test(command) || /--help\b/.test(command)) return null;

  /*
   * 这一行摆几个格子。
   *
   * 权威是这一批自己报的 `batchSize`(N/M 里的 M)—— daemon 按「同 runId + 同 surface
   * + 生命周期有重叠」分好了组,它知道这一批到底有几张。命令行里数出来的
   * `media generate` 次数只是**没有分组信息时**的兜底:一条 `--count 3` 只写一次
   * generate,数命令行会说 1;而三张图确实在跑。
   */
  const total = mediaBatchTotal(tasks, mediaGenerateCount(command));
  let done = 0;
  let failed = 0;
  const thumbs: string[] = [];
  let replayCells: ImageRow['cells'];

  if (tasks.length > 0) {
    const slots = mediaCellSlots(tasks, total);
    const cells: NonNullable<ImageRow['cells']> = new Array(total);
    tasks.forEach((task, i) => {
      const slot = slots[i];
      if (slot == null || slot >= total) return;
      const path = task.file?.name?.trim();
      if (task.status === 'done') {
        done += 1;
        cells[slot] = { taskId: task.taskId, status: 'done' as const, ...(path ? { path } : {}) };
        return;
      }
      if (task.status === 'failed' || task.status === 'interrupted') {
        failed += 1;
        cells[slot] = { taskId: task.taskId, status: 'failed' as const };
        return;
      }
      cells[slot] = { taskId: task.taskId, status: 'pending' as const };
    });
    // 批还开着(`batchSize` 已经涨上来但任务还没到)的格子先空着;命令都回来了还空着的,
    // 说明那几张压根没被创建出来 —— 收敛成失败,不能永远转下去。
    for (let i = 0; i < total; i += 1) {
      if (cells[i]) continue;
      if (result) {
        failed += 1;
        cells[i] = { status: 'failed' };
      } else {
        cells[i] = { status: 'pending' };
      }
    }
    // 缩略图条按**格子顺序**取,和大格形态里那一排指向同一张图
    for (const cell of cells) if (cell?.status === 'done' && cell.path) thumbs.push(cell.path);

    const startedAt = Math.min(...tasks.map((task) => task.startedAt));
    const terminalEnds = tasks.map((task) => task.endedAt).filter((at): at is number => at != null);
    const elapsedMs = terminalEnds.length === tasks.length
      ? Math.max(...terminalEnds) - startedAt
      : null;
    return {
      kind: 'image',
      id: event.id,
      total,
      done,
      failed,
      thumbs,
      cells,
      pending: cells.some((cell) => cell.status === 'pending'),
      elapsedMs: elapsedMs != null && elapsedMs >= UNKNOWN_ELAPSED_BELOW_MS ? elapsedMs : null,
    };
  }

  if (result?.content) {
    for (const line of result.content.split('\n')) {
      const text = line.trim();
      if (!text.startsWith('{')) continue;
      let status: string | null = null;
      let path: string | null = null;
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
          const rec = parsed as Record<string, unknown>;
          if (typeof rec.status === 'string') status = rec.status;
          const nestedFile = rec.file;
          if (nestedFile && typeof nestedFile === 'object') {
            const name = (nestedFile as Record<string, unknown>).name;
            if (typeof name === 'string' && name) {
              status ??= 'done';
              path = name;
            }
          }
          for (const key of ['path', 'file', 'outputPath', 'url']) {
            const v = rec[key];
            if (typeof v === 'string' && v) { path = v; break; }
          }
        }
      } catch {
        status = /"status"\s*:\s*"(\w+)"/.exec(text)?.[1] ?? null;
      }
      if (!status) continue;
      if (status === 'failed' || status === 'error') failed += 1;
      else if (/succeeded|done|completed|ok/.test(status)) {
        done += 1;
        if (path) thumbs.push(path);
      }
    }
  }

  if (result && done + failed === 0) {
    const looksBroken = result.isError || /failed|error|required|unknown|not found/i.test(result.content ?? '');
    const declaredOutput = fileOf(event.input)?.path.trim();
    if (looksBroken) {
      failed = total;
      replayCells = Array.from({ length: total }, () => ({ status: 'failed' as const }));
    } else if (declaredOutput && total === 1) {
      /*
       * ACP 会把已落库的 Bash stdout 安全打码成 `[REDACTED:…]`。重开会话时 media task
       * 又可能已经过了短期运行态 TTL,只剩 tool_use 入参里的 `file_path`。那不是一次
       * 普通读文件:命令本身明确是 media generate、结果也正常返回,输出路径又由调用
       * 结构直接给出,足够还原一张已经完成的图。不能因为看不到 stdout 就退化成
       * 「读取 xxx.png」,否则刷新后组件 12 整行消失。
       *
       * 多图命令只有一个 file_path 时不猜其余格子的结果,仍交给普通工具行。真实批量
       * 调用应由逐行 envelope 或短期 media task 提供每格真相。
       */
      done = 1;
      thumbs.push(declaredOutput);
      replayCells = [{ status: 'done', path: declaredOutput }];
    } else {
      return null;      // 不是可证明的生图,交给普通工具行
    }
  }

  let elapsedMs: number | null = null;
  if (event.startedAt != null && result?.completedAt != null) {
    const d = result.completedAt - event.startedAt;
    if (d >= UNKNOWN_ELAPSED_BELOW_MS) elapsedMs = d;
  }

  return {
    kind: 'image',
    id: event.id,
    total,
    done,
    failed,
    thumbs,
    ...(replayCells ? { cells: replayCells } : {}),
    pending: !result,
    elapsedMs,
  };
}

/* ── 工具行 ─────────────────────────────────────────────────── */

/**
 * 一次调用落成一行。
 *
 * ⚠️ **D3「调用没回来就不落行」已作废**(产品 2026-09-02,OPEND-2419)。
 *
 * 这里原来第一句是 `if (!result) return null`,理由是「界面上没有执行中这一档」。
 * 代价是:一次卡住的调用在界面上**完全不存在**。真机那轮 44.7 分钟里,
 * 光是一个 4KB/s 的图片下载就占了 14.1 分钟,而那 14 分钟里执行记录一行都没多 ——
 * 用户看到的就是「转了 40 分钟什么都没出来」(OPEND-2419 / 2416)。
 *
 * 产品原话:「调用时不管成功没,都要立刻渲染,所有状态啥的东西都要尽快反应在界面上,
 * 不然用户会吐槽卡住了啥的」。所以判据反过来:**从入参能算出来的,一律立刻给**
 * (是哪类工具、标题、文件、搜索模式、改动量);只有真的要等结果才知道的
 * (耗时、命中数、终端输出、成没成)才留到 result 到达。
 *
 * 行的身份是 `event.id`,两个阶段是**同一行换状态**,不是先一行 running 再补一行 done。
 */
function buildToolRow(
  event: Extract<PersistedAgentEvent, { kind: 'tool_use' }>,
  result: Extract<PersistedAgentEvent, { kind: 'tool_result' }> | undefined,
): ToolRow | null {
  const kind = toolKind(event.name, event.input);
  const command = isCommandTool(event.name) ? commandOf(event.input) : '';
  const file = fileOf(event.input) ?? (command ? commandFile(command) : null);
  const failed = Boolean(result?.isError);
  const hits = kind === 'search' && !failed && result?.content
    ? result.content.split('\n').filter((l) => l.trim()).length
    : null;

  /**
   * 耗时:两端都拿得到才算。codex 的 `tool_use` 在 `item.completed` 才发出,
   * 与 `tool_result` 同时到达 —— 差值接近 0 表示「不知道」,不是「跑得快」(§2.2b / W10)。
   */
  let elapsedMs: number | null = null;
  if (event.startedAt != null && result?.completedAt != null) {
    const d = result.completedAt - event.startedAt;
    if (d >= UNKNOWN_ELAPSED_BELOW_MS) elapsedMs = d;
  }

  return {
    kind: 'tool',
    id: event.id,
    pending: result == null,
    tool: kind,
    name: event.name,
    title: toolTitle(event.name, event.input),
    rawTitle: isRawCommandTitle(event.name, event.input),
    file,
    pattern: kind === 'search' ? searchPattern(event.name, event.input) : null,
    hits,
    delta: diffStat(event.name, event.input),
    elapsedMs,
    failed,
    failReason: null,
    command: command ? command : null,
    terminal: command && result?.content ? result.content : null,
  };
}
