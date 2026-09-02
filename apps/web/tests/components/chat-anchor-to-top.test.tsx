// @vitest-environment jsdom
/**
 * 发出去的那一轮,必须钉在聊天区顶端 —— **每个入口都是,整轮都是**。
 *
 * ## 缺陷(用户原话:「现在这个行为有时候有有时候没有」)
 *
 * 两处,各占一半:
 *
 * 1. **入口没接。** 「该钉顶了」是每个发送入口自己举手的
 *    (`anchorPendingRef.current = true`),而举手的只有输入框那一个。
 *    question-form 交答案、首页发起、批注发起、队列排到、失败后的「继续」、
 *    生图重试 …… 全都直接调宿主的 `handleSend`,一个都不举手,于是它们发出来的
 *    那一轮走的是贴底跟随,消息在底部而不是顶端。
 *
 * 2. **钉住这一跳用了平滑滚动。** `scrollAnchorToTop()` 是
 *    `scrollTo({behavior:'smooth'})`,而「用户是不是自己滚开了」的判据只看位置
 *    (`ChatPane` 的 40px 容差 / `stick-to-bottom.ts` 的方向判据)—— 平台不提供
 *    滚动来源,谁都分不出。于是动画自己的中间帧被判成「用户滚开了」,钉住状态
 *    在第一帧就被清掉:占位块从此不再收缩,而动画最后一帧如果正好落在底部
 *    (回复还没开始吐字时**必然**如此,因为占位块就是照着「落点 == 底部」撑的),
 *    贴底跟随还会被重新挂上,把用户一路拽到底。回复来得快慢决定它落在哪一边 ——
 *    这就是「有时候有有时候没有」。
 *
 * 同一条不变量在这个仓库里已经写过两遍了:`stick-to-bottom.ts` 的
 * 「自己发起的滚动一律瞬时」,以及 question-form 定位从 smooth 改成 auto 时
 * 留下的那段注释。`scrollAnchorToTop` 是最后一处没改的。
 *
 * ## 这个夹具在模拟什么
 *
 * jsdom 没有布局,`scrollHeight` / `clientHeight` / `getBoundingClientRect()`
 * 默认全是 0 —— 直接断言「滚到顶」的用例在**没有实现**时也是绿的。所以这里
 * 把几何全部显式桩出来,并按 CSSOM-View「perform a scroll」补上 `scrollTo`
 * 的两条分支:`'auto'` 同步落到终点,`'smooth'` 当场不动、之后一帧一帧地挪
 * (终点在调用那一刻算死,内容再长也不跟着改)。建模的是平台契约,不是我们的实现。
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatPane } from '../../src/components/ChatPane';
import {
  ANCHOR_TOP_PADDING,
  anchorScrollTop,
} from '../../src/runtime/chat/anchor-to-top';
import type { ChatMessage } from '../../src/types';
import { flushMounts, pressEnter, typeAndSettle } from '../helpers/lexical-composer';

type Geom = {
  /** 真实内容高度,**不含**尾部占位块。 */
  contentHeight: number;
  clientHeight: number;
  scrollTop: number;
  /** 最后一条用户消息距内容顶端的偏移。 */
  lastUserTopInContent: number;
};

const VIEWPORT = 600;
/** 一条用户消息的高度。 */
const USER_MSG_H = 80;

let geom: Geom;
let rafCallbacks: FrameRequestCallback[];
let resizeCallbacks: ResizeObserverCallback[];
let savedDescriptors: Record<
  'scrollTop' | 'scrollHeight' | 'clientHeight' | 'offsetHeight',
  PropertyDescriptor | undefined
>;
let originalGetBoundingClientRect: PropertyDescriptor | undefined;
let originalScrollTo: PropertyDescriptor | undefined;
let originalResizeObserver: typeof ResizeObserver | undefined;

/** 平滑滚动还没落地的那一段。 */
let pendingSmooth: { from: number; to: number } | null = null;
/** 每次 `scrollTo` 拿到的 behavior —— 用来钉「传下去的到底是哪一个」。 */
let scrollToBehaviors: Array<ScrollBehavior | undefined>;

function isChatLog(el: HTMLElement): boolean {
  return typeof el?.classList?.contains === 'function' && el.classList.contains('chat-log');
}

function isTailSpacer(el: HTMLElement): boolean {
  return (
    typeof el?.classList?.contains === 'function'
    && el.classList.contains('chat-log-tail-spacer')
  );
}

function inlineHeight(el: HTMLElement | null): number {
  if (!el) return 0;
  const parsed = Number.parseFloat(el.style.height);
  return Number.isFinite(parsed) ? parsed : 0;
}

function tailSpacerHeight(): number {
  return inlineHeight(document.querySelector<HTMLElement>('.chat-log-tail-spacer'));
}

function scrollHeightOf(): number {
  return geom.contentHeight + tailSpacerHeight();
}

function maxScrollTop(): number {
  return Math.max(0, scrollHeightOf() - geom.clientHeight);
}

function chatLog(): HTMLElement {
  return screen.getByTestId('chat-log');
}

/** 钉住那条消息此刻的落点。 */
function anchoredScrollTop(): number {
  return anchorScrollTop(geom.lastUserTopInContent);
}

beforeEach(() => {
  geom = {
    contentHeight: 4_000,
    clientHeight: VIEWPORT,
    scrollTop: 0,
    lastUserTopInContent: 3_800,
  };
  rafCallbacks = [];
  resizeCallbacks = [];
  pendingSmooth = null;
  scrollToBehaviors = [];

  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    rafCallbacks.push(callback);
    return rafCallbacks.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

  originalResizeObserver = globalThis.ResizeObserver;
  class MockResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resizeCallbacks.push(callback);
    }
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: MockResizeObserver,
  });

  savedDescriptors = {
    scrollTop: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop'),
    scrollHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight'),
    clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight'),
    offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight'),
  };
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) {
      return isChatLog(this) ? geom.scrollTop : 0;
    },
    set(this: HTMLElement, v: number) {
      if (!isChatLog(this)) return;
      geom.scrollTop = Math.min(Math.max(0, v), maxScrollTop());
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return isChatLog(this) ? scrollHeightOf() : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return isChatLog(this) ? geom.clientHeight : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return isTailSpacer(this) ? inlineHeight(this) : 0;
    },
  });

  /*
   * `.chat-log` 自己保持全零矩形,于是「消息上边在内容里的偏移」= scrollTop +
   * 矩形 top。最后一条用户消息按 `lastUserTopInContent` 说话;更早的那些排在它
   * 上面(读的只有最后一条,这里只是别让它们撒谎)。
   */
  originalGetBoundingClientRect = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'getBoundingClientRect',
  );
  const zeroRect = () => ({
    top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}),
  });
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    writable: true,
    value(this: HTMLElement) {
      if (
        typeof this.classList?.contains === 'function'
        && this.classList.contains('msg')
        && this.classList.contains('user')
      ) {
        const all = Array.from(document.querySelectorAll('.msg.user'));
        const index = all.indexOf(this);
        const isLast = index === all.length - 1;
        const topInContent = isLast
          ? geom.lastUserTopInContent
          : geom.lastUserTopInContent - (all.length - 1 - index) * 200;
        const top = topInContent - geom.scrollTop;
        return {
          ...zeroRect(),
          top,
          bottom: top + USER_MSG_H,
          height: USER_MSG_H,
          y: top,
        } as DOMRect;
      }
      return zeroRect() as DOMRect;
    },
  });

  /*
   * CSSOM-View「perform a scroll」的两条分支。⚠️ 这里**不能**把 smooth 折叠成
   * 瞬时 —— 折叠掉的正是这条缺陷本身。
   */
  originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value(this: HTMLElement, arg?: ScrollToOptions | number) {
      if (!isChatLog(this)) return;
      const options = typeof arg === 'object' && arg !== null ? arg : { top: arg as number };
      scrollToBehaviors.push(options.behavior);
      const to = Math.min(Math.max(0, options.top ?? geom.scrollTop), maxScrollTop());
      // 位置没变就不是一次滚动:浏览器不为它跑动画,也不发 scroll(csswg-drafts #8218)。
      if (to === geom.scrollTop) return;
      if (options.behavior === 'smooth') {
        pendingSmooth = { from: geom.scrollTop, to };
        return;
      }
      geom.scrollTop = to;
      fireEvent.scroll(this);
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  rafCallbacks = [];
  resizeCallbacks = [];
  if (originalResizeObserver) {
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: originalResizeObserver,
    });
  }
  if (originalScrollTo) {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo);
  } else {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollTo;
  }
  if (originalGetBoundingClientRect) {
    Object.defineProperty(
      HTMLElement.prototype, 'getBoundingClientRect', originalGetBoundingClientRect,
    );
  }
  for (const key of ['scrollTop', 'scrollHeight', 'clientHeight', 'offsetHeight'] as const) {
    const original = savedDescriptors[key];
    if (original) {
      Object.defineProperty(HTMLElement.prototype, key, original);
    } else {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
    }
  }
});

async function flushFrames() {
  await act(async () => {
    for (let round = 0; round < 6; round += 1) {
      const callbacks = rafCallbacks.splice(0);
      if (callbacks.length === 0) break;
      callbacks.forEach((callback) => callback(performance.now()));
      await Promise.resolve();
    }
  });
}

/** 内容长高之后 ResizeObserver 到达 —— 生产里「变了要去算」的真实通路。 */
async function triggerResize() {
  await act(async () => {
    [...resizeCallbacks].forEach((callback) => callback([], {} as ResizeObserver));
    await Promise.resolve();
  });
  await flushFrames();
}

/**
 * 平滑动画往前走几帧,每一帧发一个 scroll —— 浏览器就是这么做的。
 *
 * 瞬时滚动没有动画可走(位置在调用那一拍就落定了),这里**不报错**是有意的:
 * 用例钉的是「消息还在不在顶端」,不是「用了哪种滚法」。哪天有人把平滑改回来,
 * 立刻又有帧可走,红的还是同一条。
 */
async function advanceSmoothScroll(frames = 4) {
  const anim = pendingSmooth;
  if (!anim) return;
  const log = chatLog();
  for (let i = 1; i <= frames; i += 1) {
    await act(async () => {
      geom.scrollTop = Math.round(anim.from + (anim.to - anim.from) * (i / frames));
      fireEvent.scroll(log);
      await Promise.resolve();
    });
  }
  pendingSmooth = null;
}

function history(): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < 8; i += 1) {
    messages.push({
      id: `u${i}`, role: 'user', content: `request ${i}`,
      createdAt: 1_700_000_000_000 + i * 2,
    });
    messages.push({
      id: `a${i}`, role: 'assistant', content: `reply ${i}`,
      createdAt: 1_700_000_000_000 + i * 2 + 1,
    });
  }
  return messages;
}

function withNewTurn(replyText: string | null): ChatMessage[] {
  const messages = history();
  messages.push({
    id: 'u-new', role: 'user', content: 'the turn we just sent',
    createdAt: 1_700_000_001_000,
  });
  if (replyText !== null) {
    messages.push({
      id: 'a-new', role: 'assistant', content: replyText,
      createdAt: 1_700_000_001_001, runStatus: 'running',
    });
  }
  return messages;
}

function chatPaneEl(
  messages: ChatMessage[],
  streaming: boolean,
  onSend: (prompt: string) => void = () => {},
) {
  return (
    <ChatPane
      messages={messages}
      streaming={streaming}
      error={null}
      projectId="project-1"
      projectFiles={[]}
      onEnsureProject={async () => 'project-1'}
      onSend={(prompt) => { onSend(prompt); }}
      onStop={() => {}}
      conversations={[]}
      activeConversationId="conv-1"
      onSelectConversation={() => {}}
      onDeleteConversation={() => {}}
    />
  );
}

/** 新一轮到达:内容长高、最后一条用户消息换成新的那条。 */
function arriveNewUserTurn() {
  geom.contentHeight = 4_000 + USER_MSG_H;
  geom.lastUserTopInContent = 4_000;
}

describe('夹具自检:几何真的说话了(不然全部用例都是假绿)', () => {
  it('初次装载停在真实底部,而且这个数不是 0', async () => {
    render(chatPaneEl(history(), false));
    await flushFrames();
    expect(maxScrollTop()).toBe(3_400);
    expect(geom.scrollTop).toBe(3_400);
  });

  it('钉住位置和贴底位置是两个不同的数', async () => {
    render(chatPaneEl(history(), false));
    await flushFrames();
    arriveNewUserTurn();
    expect(anchoredScrollTop()).toBe(4_000 - ANCHOR_TOP_PADDING);
    expect(anchoredScrollTop()).not.toBe(maxScrollTop());
  });
});

/*
 * ── 缺陷一:入口没接 ────────────────────────────────────────────────
 *
 * 这一格代表**所有不走输入框的入口**:question-form 交答案、首页发起后自动送出、
 * 批注发起、队列排到、失败后的「继续」、生图重试。它们的共同形状就是这个 ——
 * 宿主直接把新的用户消息塞进 `messages`,`ChatPane` 的输入框从头到尾没参与。
 */
describe('不走输入框的入口:新一轮照样要钉到顶', () => {
  it('宿主直接塞进来的新用户消息,必须钉在顶端而不是留在底部', async () => {
    const { rerender } = render(chatPaneEl(history(), false));
    await flushFrames();
    expect(geom.scrollTop).toBe(3_400);

    arriveNewUserTurn();
    await act(async () => {
      rerender(chatPaneEl(withNewTurn(null), true));
    });
    await flushFrames();
    await advanceSmoothScroll();

    expect(geom.scrollTop).toBe(anchoredScrollTop());
  });

  it('并且撑出占位块 —— 否则这条消息物理上根本滚不到顶', async () => {
    const { rerender } = render(chatPaneEl(history(), false));
    await flushFrames();

    arriveNewUserTurn();
    await act(async () => {
      rerender(chatPaneEl(withNewTurn(null), true));
    });
    await flushFrames();

    // 消息下面只有它自己那 80px:600 − 80 − 12 = 508。
    expect(tailSpacerHeight()).toBe(508);
  });

  it('空会话的第一条(首页发起走的就是这一格)也要钉到顶', async () => {
    geom.contentHeight = 0;
    geom.lastUserTopInContent = 0;
    const { rerender } = render(chatPaneEl([], false));
    await flushFrames();

    geom.contentHeight = USER_MSG_H;
    geom.lastUserTopInContent = 0;
    await act(async () => {
      rerender(chatPaneEl(
        [{ id: 'u-home', role: 'user', content: 'from home', createdAt: 1 }],
        true,
      ));
    });
    await flushFrames();
    await advanceSmoothScroll();

    expect(tailSpacerHeight()).toBe(VIEWPORT - USER_MSG_H - ANCHOR_TOP_PADDING);
  });

  it('整篇转录初次装载不算新一轮 —— 不许把历史会话拽到某条消息的顶端', async () => {
    render(chatPaneEl(history(), false));
    await flushFrames();
    expect(geom.scrollTop).toBe(maxScrollTop());
    expect(tailSpacerHeight()).toBe(0);
  });
});

/*
 * ── 缺陷二:钉住这一跳用了平滑滚动,于是自己把自己判掉 ──────────────────
 *
 * 走的是**真输入框**,所以在修复之前这几格里 `anchorPendingRef` 是被正常举手的 ——
 * 它们照出来的只可能是滚法本身的问题,和「入口没接」那一半互不遮掩。
 */
describe('输入框发出的一轮:整轮都要留在顶端', () => {
  async function sendFromComposer() {
    await typeAndSettle('make me a poster');
    pressEnter();
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('回复迟迟不来的那一轮,钉住之后不许被贴底跟随抢回去', async () => {
    const { rerender } = render(chatPaneEl(history(), false));
    await flushMounts();
    await flushFrames();

    await sendFromComposer();
    arriveNewUserTurn();
    await act(async () => {
      rerender(chatPaneEl(withNewTurn(null), true));
    });
    await flushFrames();
    // 回复还没开始吐字 —— 动画整段跑完,落点正好是底部。
    await advanceSmoothScroll();

    // 现在回复来了,内容长高 500px。
    geom.contentHeight += 500;
    await act(async () => {
      rerender(chatPaneEl(withNewTurn('a'.repeat(400)), true));
    });
    await flushFrames();
    await triggerResize();

    expect(geom.scrollTop).toBe(anchoredScrollTop());
  });

  it('回复长出来的时候占位块要跟着收缩,不能留一块死空白', async () => {
    const { rerender } = render(chatPaneEl(history(), false));
    await flushMounts();
    await flushFrames();

    await sendFromComposer();
    arriveNewUserTurn();
    await act(async () => {
      rerender(chatPaneEl(withNewTurn(null), true));
    });
    await flushFrames();
    await advanceSmoothScroll();
    expect(tailSpacerHeight()).toBe(508);

    geom.contentHeight += 500;
    await act(async () => {
      rerender(chatPaneEl(withNewTurn('a'.repeat(400)), true));
    });
    await flushFrames();
    await triggerResize();

    // 消息下面已经有 80 + 500 = 580 的真内容,只差 600 − 580 − 12 = 8。
    expect(tailSpacerHeight()).toBe(8);
  });

  /*
   * 钉住这一跳必须**当拍落地**,不能留一段动画在飞。判据看的是「位置」,而动画
   * 的中间帧全都在落点之外 —— 只要还有一段动画要跑,这套机制就会自己把自己判掉。
   *
   * 所以这里不去嗅「调用时传了哪个 behavior」(那是实现细节),而是钉可观测的
   * 结果:这一帧过完,位置已经在落点上,且没有任何平滑动画在等着跑。
   */
  it('钉住这一跳当拍就落地 —— 不留一段平滑动画在飞', async () => {
    const { rerender } = render(chatPaneEl(history(), false));
    await flushMounts();
    await flushFrames();

    await sendFromComposer();
    arriveNewUserTurn();
    await act(async () => {
      rerender(chatPaneEl(withNewTurn(null), true));
    });
    await flushFrames();

    expect(geom.scrollTop).toBe(anchoredScrollTop());
    expect(pendingSmooth).toBeNull();
    expect(scrollToBehaviors).not.toContain('smooth');
  });

  it('钉住之后浏览器补发的那个 scroll 事件,不许被当成用户滚开', async () => {
    const { rerender } = render(chatPaneEl(history(), false));
    await flushMounts();
    await flushFrames();

    await sendFromComposer();
    arriveNewUserTurn();
    await act(async () => {
      rerender(chatPaneEl(withNewTurn(null), true));
    });
    await flushFrames();
    await advanceSmoothScroll();

    // 浏览器对着落点补一个 scroll 事件(我们自己写 scrollTop 也会有这一下)。
    await act(async () => {
      fireEvent.scroll(chatLog());
      await Promise.resolve();
    });

    // 还钉着 = 占位块继续跟着回复收缩。
    geom.contentHeight += 500;
    await act(async () => {
      rerender(chatPaneEl(withNewTurn('a'.repeat(400)), true));
    });
    await flushFrames();
    await triggerResize();

    expect(tailSpacerHeight()).toBe(8);
    expect(geom.scrollTop).toBe(anchoredScrollTop());
  });
});

/*
 * ── 用户真的自己滚开时,仍然要松手 ──────────────────────────────────
 *
 * 上面那组把「我们自己滚」从判据里摘出去了。这一格钉的是它没有摘过头:
 * 用户的手一动,钉住状态照样要放。
 */
describe('用户自己滚开就松手', () => {
  it('往上滚出容差之后,占位块不再跟着回复收缩', async () => {
    const { rerender } = render(chatPaneEl(history(), false));
    await flushFrames();

    arriveNewUserTurn();
    await act(async () => {
      rerender(chatPaneEl(withNewTurn(null), true));
    });
    await flushFrames();
    await advanceSmoothScroll();
    expect(tailSpacerHeight()).toBe(508);

    // 用户往上翻了 300px 去看更早的内容。
    await act(async () => {
      geom.scrollTop = anchoredScrollTop() - 300;
      fireEvent.scroll(chatLog());
      await Promise.resolve();
    });

    geom.contentHeight += 500;
    await act(async () => {
      rerender(chatPaneEl(withNewTurn('a'.repeat(400)), true));
    });
    await flushFrames();
    await triggerResize();

    // 预留的空白原地不动 —— 它已经是用户脚下真实的可滚区域,收掉会把画面抽走。
    expect(tailSpacerHeight()).toBe(508);
  });
});
