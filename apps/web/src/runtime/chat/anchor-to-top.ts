/**
 * 「刚发出去的这一轮,钉到聊天区顶端」的**纯判据**。
 *
 * 这块几何原来整段写在 `ChatPane` 里,读不出、也测不到:jsdom 没有布局,
 * `scrollHeight` / `clientHeight` / `getBoundingClientRect()` 默认全是 0,
 * 于是「断言滚到顶」的用例在**没有实现**的时候也是绿的(期望值和实际值都是 0)。
 * 判据搬到这里之后,每一条都可以喂显式的几何数字,红绿都是真的。
 *
 * ## 这套机制由三件事组成
 *
 *   1. **尾部占位块**(`anchorSpacerHeight`)——在回复下面撑出一块**真实可滚动**的
 *      空白,好让这条用户消息物理上够得着视口顶端。短回复(甚至还没有回复)时,
 *      没有这块空白就根本滚不上去 —— 用户会觉得「置顶没生效」,而其实是滚不动。
 *   2. **落点**(`anchorScrollTop`)——占位块按 (1) 定过尺寸之后,消息顶到上沿
 *      对应的 `scrollTop`。这两个数是**同一副几何的两面**:占位块正好撑到
 *      「落点 == 能滚到的最大位置」,所以钉住之后再怎么长内容,视图都不会被夹取推走。
 *   3. **松手判据**(`anchorReleasedByScroll`)——用户自己滚开了多远才算「不钉了」。
 *
 * ## 【不变量】钉住这一跳必须是**瞬时**的
 *
 * (3) 分不出「谁发起的滚动」——平台也不打算让它分得出(见 `stick-to-bottom.ts`
 * 里那一整段)。所以 `behavior:'smooth'` 会让这套机制**自己把自己判掉**:
 * 动画中间的每一帧离落点都远远超过 `ANCHOR_RELEASE_SLACK_PX`,第一帧就把钉住
 * 状态清掉了,之后占位块再也不收缩,而贴底跟随可能在动画最后一帧被重新挂上,
 * 把用户拽到底 —— 这正是「有时候置顶了有时候没有」的来源。
 * 调用方必须用 `behavior:'auto'` 并走自己那个「写完就记基线」的写入口。
 */

/** 钉住的消息上边留的那点空隙。 */
export const ANCHOR_TOP_PADDING = 12;

/**
 * 离钉住位置超过这么多像素,才算「用户自己滚开了」。
 *
 * 不能取 0:占位块每一帧都在收缩,浏览器夹取会带来亚像素级的漂移。
 */
export const ANCHOR_RELEASE_SLACK_PX = 40;

export interface AnchorGeometry {
  /** 视口高。 */
  clientHeight: number;
  /** 可滚内容总高,**含**尾部占位块 —— 就是 `el.scrollHeight` 的读数。 */
  scrollHeight: number;
  /** 尾部占位块此刻的高度。 */
  spacerHeight: number;
  /** 被钉住那条用户消息距内容顶端的偏移(与当前 `scrollTop` 无关)。 */
  messageTopInContent: number;
}

/** 这条消息下面还有多少**真内容**(占位块不算)。 */
function contentBelowAnchor(geometry: AnchorGeometry): number {
  return Math.max(
    0,
    geometry.scrollHeight - geometry.spacerHeight - geometry.messageTopInContent,
  );
}

/**
 * 尾部占位块要多高,这条消息才顶得到视口上沿。
 *
 * 回复越长,`needed` 越小,一路单调收缩到 0 —— 所以这是一次**纯缩小**的 resize,
 * 在用户钉在顶端时改不了任何可见内容的位置,不会抖。
 */
export function anchorSpacerHeight(geometry: AnchorGeometry): number {
  return Math.max(
    0,
    geometry.clientHeight - contentBelowAnchor(geometry) - ANCHOR_TOP_PADDING,
  );
}

/** 钉住位置对应的 `scrollTop`。 */
export function anchorScrollTop(messageTopInContent: number): number {
  return Math.max(0, messageTopInContent - ANCHOR_TOP_PADDING);
}

/**
 * 占位块按 `anchorSpacerHeight` 定过尺寸之后,能滚到的最大位置。
 *
 * 它**恒等于** `anchorScrollTop` ——「刚好够钉到顶,一个像素都不多」正是占位块的定义。
 * 单独导出是为了让这条恒等式可以被断言,而不是只写在注释里。
 */
export function maxScrollTopAfterAnchorSpacer(geometry: AnchorGeometry): number {
  const below = contentBelowAnchor(geometry);
  const total = geometry.messageTopInContent + below + anchorSpacerHeight(geometry);
  return Math.max(0, total - geometry.clientHeight);
}

/** 这一次滚动是不是把用户带离了钉住位置。 */
export function anchorReleasedByScroll(input: {
  scrollTop: number;
  messageTopInContent: number;
}): boolean {
  return (
    Math.abs(input.scrollTop - anchorScrollTop(input.messageTopInContent))
    > ANCHOR_RELEASE_SLACK_PX
  );
}

/**
 * 尾部这条用户消息是不是「刚刚新出现的一轮」——**该不该钉顶,只由这一条决定**。
 *
 * 老写法是每个发送入口各自举手(`anchorPendingRef.current = true`),而举手的
 * 只有输入框那一个入口。首页发起、question-form 交答案、批注发起、队列排到、
 * 失败后的「继续」、生图重试 …… 一条都不走输入框,于是它们全都钉不了顶。
 * 「有时候有有时候没有」的另一半就是这个。
 *
 * 改成认**结构**:尾条用户消息的 id 换了 = 屏幕上多了一轮新的用户消息,和它是
 * 从哪个按钮出来的无关。少一份状态,也就少一处「新入口忘了接」。
 *
 * `settledTailUserId === undefined` 表示这条会话还没落定过(初次装载 / 刚切会话)。
 * 那一拍**不钉**:整篇转录一次性到齐,不是新发了一轮。空会话落定成 `null`,
 * 所以它的第一条用户消息仍然算新的一轮(首页发起走的就是这一格)。
 */
export function isNewTailUserTurn(
  settledTailUserId: string | null | undefined,
  tailUserId: string | null,
): boolean {
  if (settledTailUserId === undefined) return false;
  if (tailUserId === null) return false;
  return tailUserId !== settledTailUserId;
}
