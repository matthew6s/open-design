// @vitest-environment jsdom

/**
 * 产物卡的**两条渲染路径必须长一样**,而且要长成设计稿的样子。
 *
 * `AssistantMessage` 有两条互斥的产物面板:
 *  · 这一轮有 write/edit 工具行 → `FileOpsSummary`
 *  · 没有工具行但有产出/找回的文件 → `ProducedFiles`
 * 它们在 P0 `recvqaerXd82bE` 之后变成了「不同时出」,但**没有变成一致** ——
 * 卡面形状、按钮集合、导出行为各写了一份。
 *
 * 权威是 `docs/design/chat-panel-next.html` 组件 14(修订 `1bbdce0b06`,
 * md5 `28ea4c65…`),它的 `.cmp-ops` 散文和 `components.css` 注释就是规格:
 *  · 动作明摆在**右上角**,两枚:发布 / 导出。不收进菜单,不看第几轮。
 *  · **发布只有 HTML 产物有**;md / csv / 图片 / 视频那类右上角只剩一枚「导出」。
 *  · 「发布」是**纯文字**,只有「导出」带那枚圈中向下箭头 —— 稿子原话:
 *    「两个方向相反的动作并排,给其中一个加上方向,那一排就不必逐字读了」。
 *  · 没有「预览」,没有「⋯」。
 *
 * 稿子里**没有任何**「只有最后一轮才给动作」的说法。
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AssistantMessage } from '../../src/components/AssistantMessage';
import { FileOpsSummary } from '../../src/components/FileOpsSummary';
import { CollabProvider } from '../../src/collab/collab-context';
import type { ChatMessage, ProjectFile } from '../../src/types';
import type { FileOpEntry } from '../../src/runtime/file-ops';
import { workspaceContextFixture } from '../helpers/workspace-context';

beforeAll(() => {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      clear: () => store.clear(),
      getItem: (key: string) => store.get(key) ?? null,
      removeItem: (key: string) => store.delete(key),
      setItem: (key: string, value: string) => store.set(key, value),
    },
  });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

const PROJECT_ID = 'c7e3b234-2fb3-4f6e-8aae-a3a00697c476';

function projectCollabValue() {
  return {
    workspaceContext: workspaceContextFixture({
      workspaceId: 'workspace-a',
      workspaceMemberId: 'member-a',
    }),
    workspaceContextLoading: false,
    enabled: false,
    member: null,
    present: [],
    publishedVersion: null,
    syncState: null,
    viewerOnly: false,
    writerAuthority: 'allowed' as const,
    isOwner: false,
    isEffectiveOwner: true,
    isSharedNonOwner: false,
    ownerDisplayName: null,
    ownerRole: null,
    downloadPending: false,
    reportChange: vi.fn(),
    requestPublish: vi.fn(),
    refreshPresence: vi.fn(),
    checkStatusNow: vi.fn(),
  };
}

const RUN_STARTED_AT = 1787794097356;
const RUN_ENDED_AT = 1787794110470;

/**
 * 夹具照抄真机 `produced_files_json`(见
 * `AssistantMessage.produced-card-turn-scope.test.tsx` 的同一条注释):
 * `producedFiles` 的元素是 **`ProjectFile` 对象**,不是字符串 —— 塞字符串会在
 * `f.name.toLowerCase()` 上把整个会话视图炸掉。
 */
function projectFile(name: string, overrides: Partial<ProjectFile> = {}): ProjectFile {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  const kind =
    ext === 'html' ? 'html'
    : ext === 'png' || ext === 'jpg' ? 'image'
    : ext === 'mp4' ? 'video'
    : ext === 'mp3' || ext === 'wav' ? 'audio'
    : 'text';
  return {
    name,
    path: name,
    localPath: `/Users/elian/.od/projects/${PROJECT_ID}/${name}`,
    type: 'file',
    size: 8961,
    mtime: RUN_STARTED_AT + 2_000,
    kind,
    mime: 'application/octet-stream',
    ...overrides,
  } as ProjectFile;
}

function fileOpEntry(path: string): FileOpEntry {
  return {
    path,
    fullPath: `/repo/${path}`,
    ops: ['write'],
    opCounts: { read: 0, write: 1, edit: 0, delete: 0 },
    total: 1,
    status: 'done',
  };
}

/** 有工具行的那一轮 —— 走 `FileOpsSummary`。 */
function toolOpTurn(names: string[], overrides: Partial<ChatMessage> = {}): ChatMessage {
  const events: unknown[] = [{ kind: 'status', label: 'starting', detail: 'claude' }];
  for (const [index, name] of names.entries()) {
    events.push({
      kind: 'tool_use',
      id: `toolu_${index}`,
      name: 'Write',
      input: { file_path: `/Users/elian/.od/projects/${PROJECT_ID}/${name}`, content: 'x' },
    });
    events.push({ kind: 'tool_result', id: `toolu_${index}`, content: 'ok' });
  }
  events.push({ kind: 'text', text: '做完了。' });
  // 产物卡是 agent 声明出来的(`<od-focus show="…">`),两条路都一样 —— 这一组
  // 讲的是「同一批文件在两条路上长得一不一样」,所以两边都把它声明出来。
  events.push({ kind: 'artifact_focus', show: [...names] });
  return {
    id: 'msg-tool-ops',
    role: 'assistant',
    content: '做完了。',
    runStatus: 'succeeded',
    startedAt: RUN_STARTED_AT,
    endedAt: RUN_ENDED_AT,
    createdAt: RUN_STARTED_AT,
    events: events as ChatMessage['events'],
    producedFiles: names.map((name) => projectFile(name)),
    ...overrides,
  } as ChatMessage;
}

/** 没有工具行、只有产出的那一轮 —— 走 `ProducedFiles` 那条回退支。 */
function producedOnlyTurn(names: string[], overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-produced-only',
    role: 'assistant',
    content: '做完了。',
    runStatus: 'succeeded',
    startedAt: RUN_STARTED_AT,
    endedAt: RUN_ENDED_AT,
    createdAt: RUN_STARTED_AT,
    events: [
      { kind: 'status', label: 'starting', detail: 'claude' },
      { kind: 'text', text: '做完了。' },
      { kind: 'artifact_focus', show: [...names] },
    ] as ChatMessage['events'],
    producedFiles: names.map((name) => projectFile(name)),
    ...overrides,
  } as ChatMessage;
}

function renderTurn(message: ChatMessage, extra: Record<string, unknown> = {}) {
  return render(
    <CollabProvider value={projectCollabValue()}>
      <AssistantMessage
        message={message}
        streaming={false}
        projectId={PROJECT_ID}
        projectFiles={(message.producedFiles ?? []) as ProjectFile[]}
        isLast
        {...extra}
      />
    </CollabProvider>,
  );
}

/** 一张卡上的动作按钮 id,按渲染顺序 —— 两条路径要给出同一串。 */
function actionIdsOn(card: HTMLElement): string[] {
  return Array.from(card.querySelectorAll('.artifact-card-act')).map(
    (node) => node.getAttribute('data-testid') ?? '?',
  );
}

/** 这次渲染里所有产物卡的「文件名 → 动作列表」快照。 */
function cardSnapshot(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const card of Array.from(
    document.querySelectorAll<HTMLElement>('[data-artifact-card]'),
  )) {
    const id = card.getAttribute('data-testid') ?? '?';
    out[id.replace(/^artifact-card-/, '')] = actionIdsOn(card);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 1 · 动作不看第几轮(设计稿里没有 isLast 这一档)
 * ------------------------------------------------------------------ */
describe('产物卡的动作不按轮次发放', () => {
  it('把发布 / 导出留在**历史轮次**的 HTML 卡上', () => {
    const onArtifactShare = vi.fn();
    const onArtifactDownload = vi.fn();
    renderTurn(producedOnlyTurn(['landing.html']), {
      isLast: false,
      onArtifactShare,
      onArtifactDownload,
    });

    // 先证明这条消息真的渲染出了卡 —— 否则下面两条断言是空过的
    const card = screen.getByTestId('artifact-card-landing.html');
    expect(card).toBeTruthy();

    expect(
      within(card).queryByTestId('artifact-card-publish-landing.html'),
      '历史轮次的 HTML 卡丢了「发布」—— 稿子里没有 isLast 这一档',
    ).toBeTruthy();
    expect(
      within(card).queryByTestId('artifact-card-export-landing.html'),
      '历史轮次的卡丢了「导出」',
    ).toBeTruthy();
  });

  it('最后一轮当然也还在(反向对照:不许靠「一律不发」蒙混)', () => {
    renderTurn(producedOnlyTurn(['landing.html']), {
      onArtifactShare: vi.fn(),
      onArtifactDownload: vi.fn(),
    });
    const card = screen.getByTestId('artifact-card-landing.html');
    expect(within(card).queryByTestId('artifact-card-publish-landing.html')).toBeTruthy();
    expect(within(card).queryByTestId('artifact-card-export-landing.html')).toBeTruthy();
  });

  it('非 HTML 卡在任何轮次都只有一枚「导出」(grid 32)', () => {
    renderTurn(producedOnlyTurn(['poster.png']), {
      isLast: false,
      onArtifactShare: vi.fn(),
      onArtifactDownload: vi.fn(),
    });
    const card = screen.getByTestId('artifact-card-poster.png');
    expect(within(card).queryByTestId('artifact-card-publish-poster.png')).toBeNull();
    expect(within(card).queryByTestId('artifact-card-export-poster.png')).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ *
 * 2 · 两条路径给出同一副卡
 * ------------------------------------------------------------------ */
describe('两条产物面板路径给出同一副卡', () => {
  const NAMES = ['landing.html', 'notes.md', 'poster.png', 'theme.mp3'];

  it('同一批文件,有工具行和没工具行渲染出同样的卡与同样的动作', () => {
    const first = renderTurn(toolOpTurn(NAMES), {
      onArtifactShare: vi.fn(),
      onArtifactDownload: vi.fn(),
    });
    // 走的确实是 `FileOpsSummary` 那条支
    expect(screen.getByTestId('file-ops-summary')).toBeTruthy();
    const viaToolOps = cardSnapshot();
    const audioViaToolOps = !!document.querySelector('[data-testid="file-ops-audio"]');
    first.unmount();

    renderTurn(producedOnlyTurn(NAMES), {
      onArtifactShare: vi.fn(),
      onArtifactDownload: vi.fn(),
    });
    const viaProduced = cardSnapshot();
    const audioViaProduced = !!document.querySelector('[data-testid="file-ops-audio"]');

    // 先证明两边都真的画了东西
    expect(Object.keys(viaToolOps).length, '工具行那条支一张卡都没画').toBeGreaterThan(0);
    expect(Object.keys(viaProduced).length, '产出回退那条支一张卡都没画').toBeGreaterThan(0);

    expect(viaProduced).toEqual(viaToolOps);
    expect(audioViaProduced, '两条支对音频的处理不一致').toBe(audioViaToolOps);
  });
});

/* ------------------------------------------------------------------ *
 * 3 · 图片卡展示完整画面，且不改变视频 / HTML 的专用预览
 * ------------------------------------------------------------------ */
describe('产物卡缩略图适配', () => {
  it('图片卡声明完整画面适配，视频与 HTML 仍走各自的专用预览', () => {
    render(
      <CollabProvider value={projectCollabValue()}>
        <FileOpsSummary
          entries={[
            fileOpEntry('portrait.png'),
            fileOpEntry('portrait.mp4'),
            fileOpEntry('landing.html'),
          ]}
          projectId={PROJECT_ID}
        />
      </CollabProvider>,
    );

    const imageCard = screen.getByTestId('artifact-card-portrait.png');
    const videoCard = screen.getByTestId('artifact-card-portrait.mp4');
    const htmlCard = screen.getByTestId('artifact-card-landing.html');

    expect(imageCard.querySelector('img')?.getAttribute('data-preview-fit')).toBe('contain');
    expect(videoCard.querySelector('video')).toBeTruthy();
    expect(videoCard.querySelector('[data-preview-fit]')).toBeNull();
    expect(htmlCard.querySelector('img, video')).toBeNull();
    expect(htmlCard.querySelector('[data-preview-fit]')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 4 · 音频永远是那条胶囊,不套卡壳
 * ------------------------------------------------------------------ */
describe('音频产物', () => {
  it('在**没有工具行**的那条支上也画成胶囊,不是一张 doc 卡', () => {
    renderTurn(producedOnlyTurn(['theme.mp3']), {
      onArtifactShare: vi.fn(),
      onArtifactDownload: vi.fn(),
    });

    expect(
      document.querySelector('[data-testid="file-ops-audio"] audio'),
      '产出回退那条支没用组件 24 的胶囊画音频',
    ).toBeTruthy();
    expect(
      document.querySelector('[data-artifact-card][data-testid="artifact-card-theme.mp3"]'),
      '又把音频套回大卡片里了',
    ).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 5 · 「发布」是纯文字,方向感只给「导出」
 * ------------------------------------------------------------------ */
describe('动作胶囊的字形', () => {
  it('「发布」不带图标,「导出」带那枚圈中箭头', () => {
    render(
      <CollabProvider value={projectCollabValue()}>
        <FileOpsSummary
          entries={[fileOpEntry('landing.html')]}
          projectId={PROJECT_ID}
          onPublish={vi.fn()}
          onExport={vi.fn()}
        />
      </CollabProvider>,
    );

    const publish = screen.getByTestId('artifact-card-publish-landing.html');
    const exportAct = screen.getByTestId('artifact-card-export-landing.html');
    // 反向对照:导出**必须**有图标,否则「两枚都没图标」也能过
    expect(exportAct.querySelector('svg'), '「导出」丢了那枚圈中箭头').toBeTruthy();
    expect(
      publish.querySelector('svg'),
      '「发布」多了一枚图标 —— 稿子里它是纯文字,方向感只给「导出」一个',
    ).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 6 · 导出:单格式直接下载,多格式才把菜单交给预览区
 * ------------------------------------------------------------------ */
describe('导出行为', () => {
  it('单格式产物(md)点「导出」直接下载,不弹任何东西', () => {
    const onExport = vi.fn();
    render(
      <CollabProvider value={projectCollabValue()}>
        <FileOpsSummary
          entries={[fileOpEntry('notes.md')]}
          projectId={PROJECT_ID}
          onExport={onExport}
        />
      </CollabProvider>,
    );

    const act = screen.getByTestId('artifact-card-export-notes.md');
    expect(act.tagName, 'md 的导出应该就是一条下载链接').toBe('A');
    expect(act.getAttribute('download')).toBe('notes.md');
    fireEvent.click(act);
    expect(onExport, 'md 不该绕道预览区的导出菜单').not.toHaveBeenCalled();
  });

  it('单格式产物(png)同样直接下载', () => {
    const onExport = vi.fn();
    render(
      <CollabProvider value={projectCollabValue()}>
        <FileOpsSummary
          entries={[fileOpEntry('poster.png')]}
          projectId={PROJECT_ID}
          onExport={onExport}
        />
      </CollabProvider>,
    );

    const act = screen.getByTestId('artifact-card-export-poster.png');
    expect(act.tagName).toBe('A');
    expect(act.getAttribute('download')).toBe('poster.png');
    expect(onExport).not.toHaveBeenCalled();
  });

  it('多格式产物(html)是按钮,点它把菜单交给预览区(反向对照)', () => {
    const onExport = vi.fn();
    render(
      <CollabProvider value={projectCollabValue()}>
        <FileOpsSummary
          entries={[fileOpEntry('landing.html')]}
          projectId={PROJECT_ID}
          onExport={onExport}
        />
      </CollabProvider>,
    );

    const act = screen.getByTestId('artifact-card-export-landing.html');
    expect(act.tagName, 'html 的导出要开菜单,所以是按钮不是链接').toBe('BUTTON');
    expect(act.getAttribute('aria-haspopup')).toBe('menu');
    fireEvent.click(act);
    expect(onExport).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ *
 * 7 · 卡上两枚都**复用预览区那两块菜单**,自己不另画
 * ------------------------------------------------------------------ *
 * 产品 2026-08-27 看到卡上自制的窄浮层之后当场推翻:
 *   「为啥这个发布弹窗是这样的?? 为啥不直接复用现在那个分享弹窗??」
 *   「导出这个样式也不对呢, 为啥不直接复用?」
 *
 * 所以卡上**不再有自己的菜单**。两枚胶囊只做一件事:把「在哪儿开」告诉预览区,
 * 由预览区把它**本来那块**菜单开在这枚按钮旁边。位置那条口径不变:
 *   「都直接显示在卡片导出发布的按钮附近,动态根据上下空间判断是显示在按钮
 *     上面还是下面」。
 *
 * 稿子对「发布点下去之后长什么样」仍旧一个字没写(全稿 24 个组件里「发布」只在
 * 组件 14 的卡上出现过一次)—— 现在由产品指定了,答案是「就用现在那块」。
 */
describe('卡上的两枚胶囊复用预览区的菜单', () => {
  function renderHtmlCard(overrides: Record<string, unknown> = {}) {
    return render(
      <CollabProvider value={projectCollabValue()}>
        <FileOpsSummary
          entries={[fileOpEntry('landing.html')]}
          projectId={PROJECT_ID}
          onPublish={vi.fn()}
          onExport={vi.fn()}
          {...overrides}
        />
      </CollabProvider>,
    );
  }

  it('卡上不再自造发布菜单 —— 点一下就把「在哪儿开」交出去', () => {
    const onPublish = vi.fn();
    renderHtmlCard({ onPublish });

    const act = screen.getByTestId('artifact-card-publish-landing.html');
    expect(act).toHaveTextContent('Share');
    fireEvent.click(act);

    // 自制的那枚窄浮层必须消失
    expect(
      screen.queryByTestId('artifact-publish-popover'),
      '卡上还留着自造的发布菜单',
    ).toBeNull();
    // 交出去的是「哪份产物 + 锚在哪枚按钮上」
    expect(onPublish).toHaveBeenCalledTimes(1);
    const [name, anchorId] = onPublish.mock.calls[0] as [string, string];
    expect(name).toBe('landing.html');
    expect(anchorId, '没有把锚点交出去,预览区无从知道开在哪儿').toBeTruthy();
    // 锚点必须能在文档里找回来 —— 菜单是几百毫秒之后才挂上的
    expect(document.querySelector(`[data-artifact-anchor="${anchorId}"]`)).toBe(act);
  });

  it('卡上也不再自造导出格式菜单', () => {
    const onExport = vi.fn();
    renderHtmlCard({ onExport });

    const act = screen.getByTestId('artifact-card-export-landing.html');
    fireEvent.click(act);

    expect(
      screen.queryByTestId('artifact-export-popover'),
      '卡上还留着自造的导出菜单',
    ).toBeNull();
    expect(onExport).toHaveBeenCalledTimes(1);
    const [name, anchorId] = onExport.mock.calls[0] as [string, string];
    expect(name).toBe('landing.html');
    expect(document.querySelector(`[data-artifact-anchor="${anchorId}"]`)).toBe(act);
  });

  it('两枚锚点互不相同 —— 否则发布会开到导出那枚上', () => {
    const onPublish = vi.fn();
    const onExport = vi.fn();
    renderHtmlCard({ onPublish, onExport });
    fireEvent.click(screen.getByTestId('artifact-card-publish-landing.html'));
    fireEvent.click(screen.getByTestId('artifact-card-export-landing.html'));
    expect(onPublish.mock.calls[0]?.[1]).not.toBe(onExport.mock.calls[0]?.[1]);
  });

  it('前后两轮产出同名文件时,第二轮按钮仍有独立锚点', () => {
    const firstPublish = vi.fn();
    const secondPublish = vi.fn();
    render(
      <CollabProvider value={projectCollabValue()}>
        <FileOpsSummary
          entries={[fileOpEntry('landing.html')]}
          projectId={PROJECT_ID}
          onPublish={firstPublish}
        />
        <FileOpsSummary
          entries={[fileOpEntry('landing.html')]}
          projectId={PROJECT_ID}
          onPublish={secondPublish}
        />
      </CollabProvider>,
    );

    const [firstButton, secondButton] = screen.getAllByTestId('artifact-card-publish-landing.html');
    fireEvent.click(firstButton!);
    fireEvent.click(secondButton!);

    const firstAnchorId = firstPublish.mock.calls[0]?.[1] as string;
    const secondAnchorId = secondPublish.mock.calls[0]?.[1] as string;
    expect(secondAnchorId).not.toBe(firstAnchorId);
    expect(document.querySelector(`[data-artifact-anchor="${secondAnchorId}"]`)).toBe(secondButton);
  });

  it('单格式产物照旧直接下载,压根不惊动预览区(反向对照)', () => {
    const onExport = vi.fn();
    render(
      <CollabProvider value={projectCollabValue()}>
        <FileOpsSummary
          entries={[fileOpEntry('notes.md')]}
          projectId={PROJECT_ID}
          onExport={onExport}
        />
      </CollabProvider>,
    );
    const act = screen.getByTestId('artifact-card-export-notes.md');
    expect(act.tagName).toBe('A');
    fireEvent.click(act);
    expect(onExport).not.toHaveBeenCalled();
  });
});
