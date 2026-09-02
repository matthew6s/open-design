import { useEffect, useState, type ReactNode } from 'react';
import type { WorkspaceCollabContext } from '@open-design/contracts';
import { projectFileUrl } from '../providers/registry';
import type { ProjectFile } from '../types';
import {
  THUMBNAIL_OVERSCAN_MARGIN,
  useThumbnailLoadSlot,
} from '../lib/thumbnail-load-gate';
import { useInView } from './plugins-home/useInView';

export type ProjectCoverKind = 'html' | 'image' | 'video' | 'logo';

export interface ProjectCoverOverride {
  kind: ProjectCoverKind;
  name: string;
  mtime?: number;
}

export function coverFromProjectFile(
  file: ProjectFile,
  kind: ProjectCoverKind = file.kind as ProjectCoverKind,
): ProjectCoverOverride | null {
  if (kind !== 'html' && kind !== 'image' && kind !== 'video' && kind !== 'logo') return null;
  return { kind, name: file.path ?? file.name, mtime: file.mtime };
}

export function selectProjectFileCover(files: ProjectFile[]): ProjectCoverOverride | null {
  const html =
    files.find((file) => (file.path ?? file.name) === 'index.html') ??
    files
      .filter((file) => file.kind === 'html')
      .sort((a, b) => b.mtime - a.mtime)[0];
  if (html) return coverFromProjectFile(html, 'html');

  const image = files
    .filter((file) => file.kind === 'image')
    .sort((a, b) => b.mtime - a.mtime)[0];
  if (image) return coverFromProjectFile(image, 'image');

  const video = files
    .filter((file) => file.kind === 'video')
    .sort((a, b) => b.mtime - a.mtime)[0];
  if (video) return coverFromProjectFile(video, 'video');

  return null;
}

export function projectCoverUrl(
  projectId: string,
  name: string,
  version?: number,
  workspaceContext?: WorkspaceCollabContext | null,
): string {
  const url = projectFileUrl(projectId, name, workspaceContext);
  if (!Number.isFinite(version) || version === undefined || version <= 0) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}v=${encodeURIComponent(String(Math.trunc(version)))}`;
}

type CoverProbeOutcome = { ok: true } | { ok: false; reason: string };

/**
 * 一个地址**同一瞬间**只探一次。
 *
 * 这不是缓存 —— map 里放的是「还在飞的那个 promise」,settle 就删掉,下一次挂载
 * 照样重新探。所以文件被删掉、被换掉之后,内存里不会留下一个陈旧的「可用」结论。
 * 它合并的只是**同一刻打向同一个地址的同一个请求**。
 *
 * 为什么需要:同一份产物会在多轮回答里各出一张卡 —— 2026-09-02 实测一个会话里
 * 4 张卡指向同一个 `slow-thinking-one-pager.html`,4 张卡同时挂载,就朝同一个地址
 * 打了 4 次一模一样的 HEAD(那次页面上对这个文件一共 10 条请求,这里占 4 条)。
 *
 * 合并之后不再 abort:一个等待者卸载不能把别的卡的探测一起掐掉,而这条请求本身
 * 只有响应头(实测 300 字节),让它跑完比维护一套引用计数便宜得多。调用方仍然靠
 * `disposed` 挡住卸载后 setState。
 */
const inFlightCoverProbes = new Map<string, Promise<CoverProbeOutcome>>();

function probeCoverOnce(src: string): Promise<CoverProbeOutcome> {
  const existing = inFlightCoverProbes.get(src);
  if (existing) return existing;
  const probe: Promise<CoverProbeOutcome> = fetch(src, { method: 'HEAD', cache: 'no-store' })
    .then((response): CoverProbeOutcome =>
      response.ok || response.status === 304
        ? { ok: true }
        : {
            ok: false,
            reason: `HTML cover unavailable (${response.status} ${response.statusText})`,
          },
    )
    .catch(
      (err): CoverProbeOutcome => ({
        ok: false,
        reason: `failed to verify HTML cover: ${err instanceof Error ? err.message : String(err)}`,
      }),
    )
    .finally(() => {
      inFlightCoverProbes.delete(src);
    });
  inFlightCoverProbes.set(src, probe);
  return probe;
}

/**
 * 还没画出任何东西的 iframe 不该压在加载态上面。
 *
 * `.artifact-card-frame` / `.thumb-iframe` 都是绝对定位,会盖住同一个盒子里在流
 * 内的占位,所以「先别显示」只能靠 `visibility` —— `display: none` 会连带影响
 * `loading="lazy"` 的可见性判定,而这里要的恰恰是**照常加载、先不显示**。
 */
const HIDDEN_UNTIL_LOADED = { visibility: 'hidden' } as const;

export function HtmlProjectCoverFrame({
  src,
  initial,
  iframeClassName,
  glyphClassName,
  diagnostic,
  pendingContent,
  ungated = false,
}: {
  src: string | undefined;
  initial: string;
  iframeClassName: string;
  glyphClassName: string;
  diagnostic: string;
  /**
   * 「封面还在路上」时放什么。不传就沿用 `initial`(首字母)—— 首页项目网格是
   * 几十张卡,不能一人一块画布,所以那边一直是首字母 + 底色。
   *
   * 传了的地方(产物卡)要满足两条:数量有界,且它就是当前路由的前台内容。
   * **只在「还没加载出来」时用**,加载失败落回 `initial`:失败不是 loading,
   * 拿一个还在流动的东西去演一个永远不会来的封面,是在骗人。
   */
  pendingContent?: ReactNode;
  /**
   * 跳过全局缩略图加载闸。**只给「前台主内容」用**。
   *
   * 那道闸是为首页项目网格建的:几十张卡各开一个 iframe 打本地 daemon,会把
   * HTTP/1.1 的连接池占满。所以 `App.tsx` 里写着
   * `if (route.kind === 'project') suspendThumbnailLoads()` —— 一进项目就挂起,
   * 背景封面别跟前台抢。
   *
   * 可聊天就活在项目路由里:回答里的产物卡**自己就是用户要看的东西**,一轮也就一两张。
   * 让它继承那条挂起,结果是永远拿不到 slot、卡面永远一块灰。
   *
   * 传这个的地方要满足两条:① 数量有界(不是网格);② 它就是当前路由的前台内容。
   */
  ungated?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [verified, setVerified] = useState(false);
  /**
   * 文档真的 load 完了没有 —— **不是**「HEAD 探通了没有」。
   *
   * 这两件事今天差得很远:HEAD 实测几十毫秒就回来,而 iframe 里那份文档要多久
   * 画出第一个像素,取决于它自己 `<head>` 里那些外链。2026-09-02 现场那份产物挂
   * 着一条 render-blocking 的 `<script src="https://cdn.tailwindcss.com">`,那个
   * 域名在这台机器上打不通(curl 70s 超时、零字节),解析器就一直卡在那儿 ——
   * 卡面于是空白了 6~59 秒。
   */
  const [loaded, setLoaded] = useState(false);
  // Cover work is deferred until the card is near the viewport, and the
  // iframe document load itself is budgeted by the shared thumbnail gate so a
  // large grid cannot saturate the daemon connection pool (Batch A §4.2).
  const { ref: inViewRef, inView } = useInView<HTMLSpanElement>({
    rootMargin: THUMBNAIL_OVERSCAN_MARGIN,
  });

  useEffect(() => {
    if (!src || !inView) {
      setFailed(false);
      setVerified(false);
      setLoaded(false);
      return;
    }

    let disposed = false;

    setFailed(false);
    setVerified(false);
    setLoaded(false);

    void probeCoverOnce(src).then((outcome) => {
      if (disposed) return;
      if (outcome.ok) {
        setVerified(true);
        return;
      }
      console.warn(`[project-cover] ${outcome.reason}:`, diagnostic);
      setFailed(true);
    });

    return () => {
      disposed = true;
    };
  }, [src, diagnostic, inView]);

  const { canLoad, settle } = useThumbnailLoadSlot(
    !ungated && Boolean(src) && inView && verified && !failed,
  );

  if (!src || failed) {
    return (
      <span ref={inViewRef} className={glyphClassName}>
        {initial}
      </span>
    );
  }

  /*
   * 「挂上 iframe」和「画出来了」之间那一段,卡面放什么。
   *
   * 只有**给了 `pendingContent` 的调用方**才留住加载态:`pendingContent` 的契约
   * 就是「还没加载出来时放什么」,没给的调用方(首页/设计页的项目网格)在这一段
   * 只有首字母可放,而那两个网格的 CSS 本来就把首字母藏了
   * (`.project-thumb-html .project-thumb-glyph { display: none }`),留住它等于
   * 什么都不放。所以网格保持今天的行为,改的只有产物卡。
   */
  const keepsPendingFaceUntilLoaded = pendingContent != null;
  const pendingFace = (
    <span
      ref={inViewRef}
      className={pendingContent ? `${glyphClassName} is-loading` : glyphClassName}
    >
      {pendingContent ?? initial}
    </span>
  );

  if (!verified || (!ungated && !canLoad)) return pendingFace;

  const holdingPendingFace = keepsPendingFaceUntilLoaded && !loaded;

  return (
    <>
      {/*
       * 文档还没 load 完之前,卡面留在**加载态**,而不是把一个一个像素都还没画的
       * iframe 亮出来 —— 那块 `background: var(--bg-panel)` 就是用户报的「产物卡片
       * 长时间空白」(2026-09-02 实测 6~21 秒,用户那次 59 秒)。
       *
       * iframe 照常挂载、照常加载,只是先不显示。降级的**产品行为没有动**:这里
       * 放的仍然是那张显示最新 html 的 live iframe,没有占位文案、没有「预览不可
       * 用」、没有灰块 —— 加载态本来就是产品选的像素液体。变的只是「什么时候算加
       * 载完」,从 HEAD 探通(几十毫秒)挪到文档真的 load,也就是 `pendingContent`
       * 自己的注释一直写着的那条:「只在「还没加载出来」时用」。
       */}
      {holdingPendingFace ? pendingFace : null}
      <iframe
        className={iframeClassName}
        src={src}
        title=""
        loading="lazy"
        sandbox="allow-scripts"
        tabIndex={-1}
        style={holdingPendingFace ? HIDDEN_UNTIL_LOADED : undefined}
        onLoad={() => {
          settle();
          setLoaded(true);
        }}
        onError={() => {
          settle();
          console.warn('[project-cover] failed to load HTML cover:', diagnostic);
          setFailed(true);
        }}
      />
    </>
  );
}
