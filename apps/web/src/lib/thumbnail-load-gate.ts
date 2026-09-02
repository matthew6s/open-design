// Concurrency budgets for preview iframes.
//
// Why this exists: a sandboxed preview iframe is a full document load against
// the local daemon — its own parse, style, layout, script execution and its
// own fetches for whatever the artifact links to. Profiling a real packaged
// client (evidence/electron-project-waterfall-20260727) showed 52 thumbnail
// documents still in flight when the user clicked a project card, pushing
// initial concurrency to 65 and contending with the opened project's own
// metadata/files/preview reads for Chromium, web, daemon and socket capacity.
//
// The cover HEAD probes already run through a small queue in
// RecentProjectsStrip; this module budgets the *document loads* themselves.
//
// ── 两条泳道,不是一条 ──────────────────────────────────────────────────
//
// 「有预算」和「进项目就让位」是两件事。以前它们被同一个开关捆在一起,于是
// 住在项目路由上的产物卡只能整条绕开预算(2026-09-02 之前的 `ungated`)。
// 现在分成两条各自独立的泳道:
//
// - **background** (`useThumbnailLoadSlot`) —— 首页/设计页那几个项目网格。
//   预算 `THUMBNAIL_LOAD_BUDGET`,并且**响应挂起**:`suspendThumbnailLoads()`
//   会收回所有已授予但还没加载完的槽位(组件卸载 iframe 并重新排队),已经
//   加载完的不动。`App.tsx` 一进项目路由就挂起它,免得背景封面跟前台抢;
//   `resumeThumbnailLoads()` 在回到首页时重新放水。
//
// - **foreground** (`useArtifactCardLoadSlot`) —— 会话里的产物卡。它**就是**
//   当前路由的前台内容,所以永远不响应挂起;但它同样要有上限,理由在
//   `ARTIFACT_CARD_LOAD_BUDGET` 那条注释里。
//
// 两条泳道按路由天然互斥(网格那条在项目路由上是挂起的),所以它们不会同时
// 抽水;分开只是为了让「让位」和「限流」不再是同一个开关。

import { useCallback, useEffect, useReducer, useRef } from 'react';

// Start-of-range budget from the handoff (§4.2 recommends probing 6-8): six
// keeps the classic per-host HTTP/1.1 connection pool from being fully
// occupied by background covers.
export const THUMBNAIL_LOAD_BUDGET = 6;

/**
 * 会话里产物卡 live iframe 的并发上限。
 *
 * **不是抄上面那个 6。** 那个 6 的理由是「别把每主机 HTTP/1.1 连接池占满」,
 * 而产物卡这条泳道有三点不同,得单独算:
 *
 * ① **它在项目路由上跑,网格那条是挂起的。** 6 是给一条「用户开项目时就该
 *    整体让位」的泳道定的上限;产物卡不让位,所以必须给项目自己的元数据、
 *    文件、预览、SSE 留出余量,取值只能比 6 低。
 *
 * ② **打包客户端没有 6 连接这回事。** `apps/packaged/src/index.ts` 和
 *    `apps/desktop/src/main/index.ts` 都对 127.0.0.1/localhost 开了
 *    `ignore-connections-limit`。所以在打包路径上限流限的不是 socket,是
 *    **渲染器文档数和外链请求数**:每个 iframe 都是独立文档,各自把页面脚本
 *    再跑一遍、各自去拉它 `<head>` 里那些外链。2026-09-02 实测的那份产物挂着
 *    一条 `https://cdn.tailwindcss.com`,那个域名在测试机上打不通 —— N 张卡
 *    就是 N 条各自卡死的请求。
 *
 * ③ **同一个文件的多张卡不会互相省。** daemon 的 raw 路由发的是
 *    `Cache-Control: no-cache`,实测 8 张同文件卡 = 8 次文档请求
 *    (1×200 + 7×304)+ 8 次外链请求。内存缓存省的是响应体,不是往返,
 *    更不是脚本执行。
 *
 * 取 4 的依据:产物卡栅格是 `grid-template-columns: repeat(2, 1fr)`,4 正好是
 * **整两行**,所以密集那一档是一行一行地画出来,而不是留半行液体;同时它高于
 * 实测的常见量(45 个带卡会话里 p50 = 2 张,单卡布局本来就是整幅一列),
 * 所以常见形状根本不排队。而实测最坏情况——一条消息 28 张卡、900px 视口下
 * 一次起飞 16 个——被压到 4。
 */
export const ARTIFACT_CARD_LOAD_BUDGET = 4;

// How far outside the viewport a card may be and still start loading. Small
// on purpose: one row of overscan, not the whole grid.
export const THUMBNAIL_OVERSCAN_MARGIN = '160px';

type SlotPhase = 'idle' | 'queued' | 'granted' | 'settled';

interface Lane {
  /** 这条泳道同时允许多少个文档在飞。 */
  readonly budget: number;
  loadingCount: number;
  /**
   * 只有 `suspendThumbnailLoads()` 会把它设成 true,而那个函数**只认
   * `backgroundLane`**。前台泳道「不会被挂起」就是这么实现的 —— 没有第二个
   * 开关。曾经这里还有一个 `suspendable: boolean` 字段,把它翻成 true 全部
   * 测试照样绿:它谁也没管着,是个会骗下一个人的摆设,所以删了。
   */
  suspended: boolean;
  queue: ThumbnailLoadSlot[];
  slots: Set<ThumbnailLoadSlot>;
}

interface ThumbnailLoadSlot {
  phase: SlotPhase;
  lane: Lane;
  notify: () => void;
}

function makeLane(budget: number): Lane {
  return { budget, loadingCount: 0, suspended: false, queue: [], slots: new Set() };
}

/** 首页/设计页的项目网格:背景封面,进项目要让位。 */
const backgroundLane = makeLane(THUMBNAIL_LOAD_BUDGET);
/** 会话里的产物卡:前台主内容,限流但不让位。 */
const foregroundLane = makeLane(ARTIFACT_CARD_LOAD_BUDGET);

function drain(lane: Lane): void {
  while (!lane.suspended && lane.loadingCount < lane.budget && lane.queue.length > 0) {
    const slot = lane.queue.shift()!;
    if (slot.phase !== 'queued') continue;
    slot.phase = 'granted';
    lane.loadingCount += 1;
    slot.notify();
  }
}

function removeFromQueue(slot: ThumbnailLoadSlot): void {
  const index = slot.lane.queue.indexOf(slot);
  if (index >= 0) slot.lane.queue.splice(index, 1);
}

function requestSlot(slot: ThumbnailLoadSlot): void {
  if (slot.phase !== 'idle') return;
  slot.phase = 'queued';
  slot.lane.queue.push(slot);
  drain(slot.lane);
}

function releaseSlot(slot: ThumbnailLoadSlot): void {
  if (slot.phase === 'granted') {
    slot.phase = 'idle';
    slot.lane.loadingCount -= 1;
    drain(slot.lane);
    return;
  }
  if (slot.phase === 'queued') {
    removeFromQueue(slot);
    slot.phase = 'idle';
  }
}

function settleSlot(slot: ThumbnailLoadSlot): void {
  if (slot.phase !== 'granted') return;
  slot.phase = 'settled';
  slot.lane.loadingCount -= 1;
  drain(slot.lane);
}

function disposeSlot(slot: ThumbnailLoadSlot): void {
  releaseSlot(slot);
  slot.lane.slots.delete(slot);
}

/**
 * Stop granting thumbnail load slots and revoke every granted slot that has
 * not settled yet. Owning components re-render with `canLoad === false`,
 * unmount their still-loading iframes, and wait in the queue. Already-loaded
 * (settled) frames are left alone.
 */
export function suspendThumbnailLoads(): void {
  const lane = backgroundLane;
  if (lane.suspended) return;
  lane.suspended = true;
  for (const slot of lane.slots) {
    if (slot.phase !== 'granted') continue;
    slot.phase = 'queued';
    lane.loadingCount -= 1;
    lane.queue.unshift(slot);
    slot.notify();
  }
}

/** Resume granting slots after `suspendThumbnailLoads()`. */
export function resumeThumbnailLoads(): void {
  if (!backgroundLane.suspended) return;
  backgroundLane.suspended = false;
  drain(backgroundLane);
}

export function thumbnailLoadsSuspended(): boolean {
  return backgroundLane.suspended;
}

/**
 * Reserve one of the shared thumbnail load slots.
 *
 * `wanted` should become true when the card is near the viewport and its
 * cover is ready to render. While the gate is saturated (or suspended) the
 * hook returns `canLoad === false`; the component keeps its lightweight
 * placeholder mounted. Call `settle()` from the iframe's load/error handler —
 * a settled slot stays renderable for the component's lifetime and no longer
 * counts against the budget.
 */
export function useThumbnailLoadSlot(wanted: boolean): {
  canLoad: boolean;
  settle: () => void;
} {
  return useLoadSlot(backgroundLane, wanted);
}

/**
 * Reserve one of the **foreground** (chat artifact card) load slots.
 *
 * 和 `useThumbnailLoadSlot` 同一套排队语义,只差两点:预算是
 * `ARTIFACT_CARD_LOAD_BUDGET`,并且**不响应 `suspendThumbnailLoads()`** ——
 * 产物卡就住在项目路由上,让它继承那条挂起等于永远拿不到槽位。
 */
export function useArtifactCardLoadSlot(wanted: boolean): {
  canLoad: boolean;
  settle: () => void;
} {
  return useLoadSlot(foregroundLane, wanted);
}

function useLoadSlot(
  lane: Lane,
  wanted: boolean,
): {
  canLoad: boolean;
  settle: () => void;
} {
  const [, force] = useReducer((x: number) => x + 1, 0);
  const slotRef = useRef<ThumbnailLoadSlot | null>(null);
  if (slotRef.current === null) {
    slotRef.current = { phase: 'idle', lane, notify: () => force() };
  }
  const slot = slotRef.current;

  useEffect(() => {
    lane.slots.add(slot);
    if (wanted) {
      requestSlot(slot);
      // `requestSlot` may grant synchronously; the render that scheduled this
      // effect predates the grant, so reflect it.
      force();
    } else if (slot.phase !== 'settled') {
      releaseSlot(slot);
      force();
    }
  }, [wanted, slot, lane]);

  useEffect(() => () => disposeSlot(slot), [slot]);

  const settle = useCallback(() => {
    settleSlot(slot);
  }, [slot]);

  return {
    canLoad: slot.phase === 'granted' || slot.phase === 'settled',
    settle,
  };
}

/** Test-only: drop all gate state so cases start from an empty budget. */
export function resetThumbnailLoadGateForTests(): void {
  for (const lane of [backgroundLane, foregroundLane]) {
    lane.loadingCount = 0;
    lane.suspended = false;
    lane.queue.length = 0;
    lane.slots.clear();
  }
}
