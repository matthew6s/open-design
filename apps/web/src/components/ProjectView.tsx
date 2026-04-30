import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { createHtmlArtifactManifest } from '../artifacts/manifest';
import { createArtifactParser } from '../artifacts/parser';
import { useT } from '../i18n';
import { streamMessage } from '../providers/anthropic';
import { streamViaDaemon } from '../providers/daemon';
import {
  fetchDesignSystem,
  fetchProjectFiles,
  fetchSkill,
  writeProjectTextFile,
} from '../providers/registry';
import { composeSystemPrompt } from '../prompts/system';
import { navigate } from '../router';
import { agentDisplayName } from '../utils/agentLabels';
import { latestTodosFromEvents, type TodoItem } from '../runtime/todos';
import {
  createConversation,
  deleteConversation as deleteConversationApi,
  getTemplate,
  listConversations,
  listMessages,
  loadTabs,
  patchConversation,
  patchProject,
  saveMessage,
  saveTabs,
} from '../state/projects';
import type {
  AgentEvent,
  AgentInfo,
  AppConfig,
  Artifact,
  ChatAttachment,
  ChatMessage,
  Conversation,
  DesignSystemSummary,
  OpenTabsState,
  Project,
  ProjectFile,
  ProjectTemplate,
  SkillSummary,
} from '../types';
import { AppTitleBar } from './AppTitleBar';
import { ChatPane } from './ChatPane';
import { FileWorkspace } from './FileWorkspace';
import { Icon } from './Icon';

const PROJECT_LAYOUT_STORAGE_KEY = 'open-design:project-layout';
const PROJECT_CONV_MIN = 220;
const PROJECT_CONV_MAX = 520;
const PROJECT_CHAT_MIN = 360;
const PROJECT_CHAT_MAX = 760;

interface Props {
  project: Project;
  routeFileName: string | null;
  config: AppConfig;
  agents: AgentInfo[];
  skills: SkillSummary[];
  designSystems: DesignSystemSummary[];
  daemonLive: boolean;
  onModeChange: (mode: AppConfig['mode']) => void;
  onAgentChange: (id: string) => void;
  onAgentModelChange: (
    id: string,
    choice: { model?: string; reasoning?: string },
  ) => void;
  onRefreshAgents: () => void;
  onOpenSettings: () => void;
  onBack: () => void;
  onClearPendingPrompt: () => void;
  onTouchProject: () => void;
  onProjectChange: (next: Project) => void;
  onProjectsRefresh: () => void;
}

export function ProjectView({
  project,
  routeFileName,
  config,
  agents,
  skills,
  designSystems,
  daemonLive,
  onOpenSettings,
  onBack,
  onClearPendingPrompt,
  onTouchProject,
  onProjectChange,
  onProjectsRefresh,
}: Props) {
  const t = useT();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    null,
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showProjectStatus, setShowProjectStatus] = useState(false);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [filesRefresh, setFilesRefresh] = useState(0);
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  // The persisted set of open tabs + active tab. Persisted via PUT on every
  // change; loaded once when the project mounts.
  const [openTabsState, setOpenTabsState] = useState<OpenTabsState>({
    tabs: [],
    active: null,
  });
  const tabsLoadedRef = useRef(false);
  // Routed to FileWorkspace — bumped whenever the user clicks "open" on a
  // tool card, an attachment chip, or a produced-file chip in chat. We
  // include a nonce so re-clicking the same name after the user closed the
  // tab still focuses it.
  const [openRequest, setOpenRequest] = useState<{ name: string; nonce: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const skillCache = useRef<Map<string, string>>(new Map());
  const designCache = useRef<Map<string, string>>(new Map());
  const templateCache = useRef<Map<string, ProjectTemplate>>(new Map());
  const [projectLayout, setProjectLayout] = useState(() => {
    try {
      const saved = window.localStorage.getItem(PROJECT_LAYOUT_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as Partial<{ convWidth: number; chatWidth: number }>;
        return {
          convWidth: clamp(parsed.convWidth ?? 240, PROJECT_CONV_MIN, PROJECT_CONV_MAX),
          chatWidth: clamp(parsed.chatWidth ?? 440, PROJECT_CHAT_MIN, PROJECT_CHAT_MAX),
        };
      }
    } catch {
      /* ignore */
    }
    return { convWidth: 240, chatWidth: 440 };
  });
  const [resizingPane, setResizingPane] = useState<'conv' | 'chat' | null>(null);
  const [convFilterTab, setConvFilterTab] = useState('待开始');
  const resizeStartXRef = useRef(0);
  const resizeStartLayoutRef = useRef(projectLayout);
  // We auto-save the most recent artifact to the project folder. Track the
  // last name we persisted so re-renders during streaming don't spawn
  // duplicate writes.
  const savedArtifactRef = useRef<string | null>(null);
  // Pending Write tool invocations: tool_use_id -> destination basename.
  // When the matching tool_result lands we refresh the file list and open
  // the file as a tab once. Keying off the tool_use_id (rather than
  // diffing the file list at end-of-turn) lets us auto-open the moment
  // the agent's Write actually completes, without the previous synthetic
  // "live" tab that was causing flicker against manual opens.
  const pendingWritesRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    try {
      window.localStorage.setItem(PROJECT_LAYOUT_STORAGE_KEY, JSON.stringify(projectLayout));
    } catch {
      /* ignore */
    }
  }, [projectLayout]);

  useEffect(() => {
    if (!resizingPane) return;
    function onMove(e: MouseEvent) {
      const dx = e.clientX - resizeStartXRef.current;
      setProjectLayout((curr) => {
        const start = resizeStartLayoutRef.current;
        if (resizingPane === 'conv') {
          return {
            ...curr,
            convWidth: clamp(start.convWidth + dx, PROJECT_CONV_MIN, PROJECT_CONV_MAX),
          };
        }
        return {
          ...curr,
          chatWidth: clamp(start.chatWidth + dx, PROJECT_CHAT_MIN, PROJECT_CHAT_MAX),
        };
      });
    }
    function onUp() {
      setResizingPane(null);
    }
    document.body.classList.add('project-resizing');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      document.body.classList.remove('project-resizing');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [resizingPane]);

  const startProjectResize = useCallback(
    (pane: 'conv' | 'chat') => (e: ReactMouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      resizeStartXRef.current = e.clientX;
      resizeStartLayoutRef.current = projectLayout;
      setResizingPane(pane);
    },
    [projectLayout],
  );

  // Load conversations on project switch. If none exist (older projects
  // pre-conversations, or a freshly created one whose default seed got
  // dropped), create one on the fly.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await listConversations(project.id);
      if (cancelled) return;
      if (list.length === 0) {
        const fresh = await createConversation(project.id);
        if (cancelled) return;
        if (fresh) {
          setConversations([fresh]);
          setActiveConversationId(fresh.id);
        }
      } else {
        setConversations(list);
        setActiveConversationId(list[0]!.id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  // Load messages whenever the active conversation changes. This happens
  // on project mount (after conversations load) and on user-triggered
  // conversation switches.
  useEffect(() => {
    if (!activeConversationId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const list = await listMessages(project.id, activeConversationId);
      if (cancelled) return;
      setMessages(list);
      setArtifact(null);
      setError(null);
      savedArtifactRef.current = null;
      pendingWritesRef.current.clear();
    })();
    return () => {
      cancelled = true;
    };
  }, [project.id, activeConversationId]);

  // Hydrate the open-tabs state once per project. After this initial
  // load, every mutation flows through saveTabsState() which keeps DB +
  // local state coherent.
  useEffect(() => {
    let cancelled = false;
    tabsLoadedRef.current = false;
    (async () => {
      const state = await loadTabs(project.id);
      if (cancelled) return;
      setOpenTabsState(state);
      tabsLoadedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  const persistTabsState = useCallback(
    (next: OpenTabsState) => {
      setOpenTabsState(next);
      if (tabsLoadedRef.current) {
        void saveTabs(project.id, next);
      }
    },
    [project.id],
  );

  const refreshProjectFiles = useCallback(async (): Promise<ProjectFile[]> => {
    const next = await fetchProjectFiles(project.id);
    setProjectFiles(next);
    return next;
  }, [project.id]);

  const requestOpenFile = useCallback((name: string) => {
    if (!name) return;
    setOpenRequest({ name, nonce: Date.now() });
  }, []);

  // Set of project file names that the chat surface uses to decide whether
  // a tool card's path is openable as a tab. Recomputed on every file-list
  // change; tool cards just read from the set.
  const projectFileNames = useMemo(
    () => new Set(projectFiles.map((f) => f.name)),
    [projectFiles],
  );
  const agentsById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  );

  // Keep the @-picker's source of truth fresh: every refreshSignal bump
  // (artifact saved, sketch saved, image uploaded) refetches; on first
  // mount we also do an initial pull so attachments staged before the
  // agent has written anything still see the user's pasted images.
  useEffect(() => {
    if (!daemonLive) return;
    void refreshProjectFiles();
  }, [daemonLive, refreshProjectFiles, filesRefresh]);

  // When the URL points at a specific file, fire an open request so the
  // FileWorkspace promotes it to an active tab. We watch routeFileName
  // (the parsed segment) so back/forward navigation triggers the same path.
  useEffect(() => {
    if (!routeFileName) return;
    requestOpenFile(routeFileName);
  }, [routeFileName, requestOpenFile]);

  // Sync the URL when the active tab changes, so reload + share-link both
  // land back on the same view. Replace (not push) on tab activation so the
  // history stack doesn't fill with every tab click.
  const lastSyncedFileRef = useRef<string | null>(null);
  useEffect(() => {
    const target = openTabsState.active && projectFileNames.has(openTabsState.active)
      ? openTabsState.active
      : null;
    if (target === lastSyncedFileRef.current) return;
    lastSyncedFileRef.current = target;
    navigate(
      { kind: 'project', projectId: project.id, fileName: target },
      { replace: true },
    );
  }, [openTabsState.active, projectFileNames, project.id]);

  const handleEnsureProject = useCallback(async (): Promise<string | null> => {
    return project.id;
  }, [project.id]);

  const composedSystemPrompt = useCallback(async (): Promise<string> => {
    let skillBody: string | undefined;
    let skillName: string | undefined;
    let skillMode: SkillSummary['mode'] | undefined;
    let designSystemBody: string | undefined;
    let designSystemTitle: string | undefined;

    if (project.skillId) {
      const summary = skills.find((s) => s.id === project.skillId);
      skillName = summary?.name;
      skillMode = summary?.mode;
      const cached = skillCache.current.get(project.skillId);
      if (cached !== undefined) {
        skillBody = cached;
      } else {
        const detail = await fetchSkill(project.skillId);
        if (detail) {
          skillBody = detail.body;
          skillCache.current.set(project.skillId, detail.body);
        }
      }
    }
    if (project.designSystemId) {
      const summary = designSystems.find((d) => d.id === project.designSystemId);
      designSystemTitle = summary?.title;
      const cached = designCache.current.get(project.designSystemId);
      if (cached !== undefined) {
        designSystemBody = cached;
      } else {
        const detail = await fetchDesignSystem(project.designSystemId);
        if (detail) {
          designSystemBody = detail.body;
          designCache.current.set(project.designSystemId, detail.body);
        }
      }
    }
    let template: ProjectTemplate | undefined;
    const tplId = project.metadata?.templateId;
    if (project.metadata?.kind === 'template' && tplId) {
      const cached = templateCache.current.get(tplId);
      if (cached) {
        template = cached;
      } else {
        const fetched = await getTemplate(tplId);
        if (fetched) {
          templateCache.current.set(tplId, fetched);
          template = fetched;
        }
      }
    }
    return composeSystemPrompt({
      skillBody,
      skillName,
      skillMode,
      designSystemBody,
      designSystemTitle,
      metadata: project.metadata,
      template,
    });
  }, [
    project.skillId,
    project.designSystemId,
    project.metadata,
    skills,
    designSystems,
  ]);

  const persistMessage = useCallback(
    (m: ChatMessage) => {
      if (!activeConversationId) return;
      void saveMessage(project.id, activeConversationId, m);
    },
    [project.id, activeConversationId],
  );

  const handleSend = useCallback(
    async (prompt: string, attachments: ChatAttachment[]) => {
      if (!activeConversationId) return;
      setError(null);
      const startedAt = Date.now();
      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: prompt,
        attachments: attachments.length > 0 ? attachments : undefined,
      };
      const selectedAgent =
        config.mode === 'daemon' && config.agentId
          ? agentsById.get(config.agentId)
          : null;
      const assistantAgentId =
        config.mode === 'daemon' ? config.agentId ?? undefined : 'anthropic-api';
      const assistantAgentName =
        config.mode === 'daemon'
          ? assistantAgentDisplayName(config.agentId, selectedAgent?.name)
          : 'Anthropic API';
      const assistantId = crypto.randomUUID();
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        agentId: assistantAgentId,
        agentName: assistantAgentName,
        events: [],
        startedAt,
      };
      const nextHistory = [...messages, userMsg];
      setMessages([...nextHistory, assistantMsg]);
      setStreaming(true);
      setArtifact(null);
      savedArtifactRef.current = null;
      onTouchProject();
      persistMessage(userMsg);
      // If this is the first turn, derive a working title from the prompt
      // so the conversation is identifiable in the dropdown without a
      // round-trip through the agent.
      if (messages.length === 0) {
        const title = prompt.slice(0, 60).trim();
        if (title) {
          setConversations((curr) =>
            curr.map((c) =>
              c.id === activeConversationId ? { ...c, title } : c,
            ),
          );
          void patchConversation(project.id, activeConversationId, { title });
        }
      }

      // Snapshot the file list at turn-start so we can diff after the
      // agent finishes and surface anything new (e.g. a generated .pptx)
      // as download chips on the assistant message.
      const beforeFileNames = new Set(projectFiles.map((f) => f.name));

      const parser = createArtifactParser();
      let liveHtml = '';

      const updateAssistant = (updater: (prev: ChatMessage) => ChatMessage) => {
        setMessages((curr) =>
          curr.map((m) => (m.id === assistantId ? updater(m) : m)),
        );
      };

      const pushEvent = (ev: AgentEvent) => {
        updateAssistant((prev) => ({ ...prev, events: [...(prev.events ?? []), ev] }));
        // Track Write tool invocations so we can auto-open the destination
        // file the moment the agent finishes writing it. The file-creating
        // tools we care about: Write (new file), Edit (existing file —
        // surfacing the freshly-modified file is also useful).
        if (ev.kind === 'tool_use' && (ev.name === 'Write' || ev.name === 'Edit')) {
          const filePath = (ev.input as { file_path?: unknown } | null)?.file_path;
          if (typeof filePath === 'string' && filePath.length > 0) {
            const base = filePath.split('/').pop() || filePath;
            pendingWritesRef.current.set(ev.id, base);
          }
        }
        if (ev.kind === 'tool_result') {
          const base = pendingWritesRef.current.get(ev.toolUseId);
          if (base) {
            pendingWritesRef.current.delete(ev.toolUseId);
            if (!ev.isError) {
              // Refresh first so FileWorkspace's file list (and the tab
              // body) sees the new content before we ask it to focus.
              void refreshProjectFiles().then(() => {
                requestOpenFile(base);
              });
            }
          }
        }
      };

      const appendContent = (delta: string) => {
        updateAssistant((prev) => ({ ...prev, content: prev.content + delta }));
        for (const ev of parser.feed(delta)) {
          if (ev.type === 'artifact:start') {
            liveHtml = '';
            setArtifact({ identifier: ev.identifier, title: ev.title, html: '' });
          } else if (ev.type === 'artifact:chunk') {
            liveHtml += ev.delta;
            setArtifact((prev) =>
              prev
                ? { ...prev, html: liveHtml }
                : { identifier: ev.identifier, title: '', html: liveHtml },
            );
          } else if (ev.type === 'artifact:end') {
            setArtifact((prev) => (prev ? { ...prev, html: ev.fullContent } : null));
          }
        }
      };

      const controller = new AbortController();
      abortRef.current = controller;
      const systemPrompt = await composedSystemPrompt();

      const handlers = {
        onDelta: appendContent,
        onAgentEvent: pushEvent,
        onDone: () => {
          for (const ev of parser.flush()) {
            if (ev.type === 'artifact:end') {
              setArtifact((prev) => (prev ? { ...prev, html: ev.fullContent } : null));
            }
          }
          updateAssistant((prev) => ({ ...prev, endedAt: Date.now() }));
          setStreaming(false);
          abortRef.current = null;
          // Persist the finished artifact to the project folder so it shows
          // up as a real tab (not just the synthetic "live" stream).
          setArtifact((prev) => {
            if (!prev || !prev.html) return prev;
            void persistArtifact(prev);
            return prev;
          });
          // Refetch the file list directly (rather than just bumping the
          // refresh signal) so we can diff against the pre-turn snapshot
          // and attach the new files to the assistant message as download
          // chips.
          void refreshProjectFiles().then((nextFiles) => {
            const produced = nextFiles.filter((f) => !beforeFileNames.has(f.name));
            setMessages((curr) => {
              const updated = curr.map((m) =>
                m.id === assistantId
                  ? produced.length > 0
                    ? { ...m, producedFiles: produced }
                    : m
                  : m,
              );
              const finalized = updated.find((m) => m.id === assistantId);
              if (finalized) persistMessage(finalized);
              return updated;
            });
          });
          onProjectsRefresh();
        },
        onError: (err: Error) => {
          setError(err.message);
          updateAssistant((prev) => ({ ...prev, endedAt: Date.now() }));
          setStreaming(false);
          abortRef.current = null;
          setMessages((curr) => {
            const finalized = curr.find((m) => m.id === assistantId);
            if (finalized) persistMessage(finalized);
            return curr;
          });
          void refreshProjectFiles();
        },
      };

      if (config.mode === 'daemon') {
        if (!config.agentId) {
          handlers.onError(new Error('Pick a local agent first (top bar).'));
          return;
        }
        const choice = config.agentModels?.[config.agentId];
        void streamViaDaemon({
          agentId: config.agentId,
          history: nextHistory,
          systemPrompt,
          signal: controller.signal,
          handlers,
          projectId: project.id,
          attachments: attachments.map((a) => a.path),
          model: choice?.model ?? null,
          reasoning: choice?.reasoning ?? null,
        });
      } else {
        pushEvent({ kind: 'status', label: 'requesting', detail: config.model });
        void streamMessage(config, systemPrompt, nextHistory, controller.signal, {
          onDelta: (delta) => {
            handlers.onDelta(delta);
            handlers.onAgentEvent({ kind: 'text', text: delta });
          },
          onDone: handlers.onDone,
          onError: handlers.onError,
        });
      }
    },
    [
      activeConversationId,
      messages,
      config,
      agentsById,
      composedSystemPrompt,
      onTouchProject,
      project.id,
      projectFiles,
      refreshProjectFiles,
      persistMessage,
      onProjectsRefresh,
    ],
  );

  const persistArtifact = useCallback(
    async (art: Artifact) => {
      const baseName = (art.identifier || art.title || 'artifact')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'artifact';
      // Pick a name that doesn't collide with an existing project file.
      // The first run uses `<base>.html`; subsequent runs append `-2`, `-3`…
      // so prior artifacts aren't silently overwritten.
      const existing = new Set(projectFiles.map((f) => f.name));
      let fileName = `${baseName}.html`;
      let n = 2;
      while (existing.has(fileName) && savedArtifactRef.current !== fileName) {
        fileName = `${baseName}-${n}.html`;
        n += 1;
      }
      if (savedArtifactRef.current === fileName) return;
      savedArtifactRef.current = fileName;
      const manifest = createHtmlArtifactManifest({
        entry: fileName,
        title: art.title || art.identifier || fileName,
        sourceSkillId: project.skillId ?? undefined,
        designSystemId: project.designSystemId,
        metadata: {
          identifier: art.identifier,
          inferred: false,
        },
      });
      const file = await writeProjectTextFile(project.id, fileName, art.html, {
        artifactManifest: manifest,
      });
      if (file) {
        setFilesRefresh((n) => n + 1);
        // Auto-open the freshly-persisted artifact as a tab so the user
        // sees it without an extra click. The Write-tool path already does
        // this for tool-emitted files; this handles the artifact-tag path.
        requestOpenFile(file.name);
      }
    },
    [project.id, projectFiles, requestOpenFile],
  );

  const handleContinueRemainingTasks = useCallback(
    (_assistantMessage: ChatMessage, todos: TodoItem[]) => {
      if (streaming || todos.length === 0) return;
      const remainingList = todos
        .map((todo, i) => {
          const label =
            todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content;
          return `${i + 1}. [${todo.status}] ${label}`;
        })
        .join('\n');
      const prompt =
        'Continue the remaining unfinished tasks from the previous run. ' +
        'Do not redo completed work. Focus only on these unfinished todos:\n\n' +
        `${remainingList}\n\n` +
        'Before making changes, inspect the current project files as needed. ' +
        'Update TodoWrite as you complete each remaining task.';
      void handleSend(prompt, []);
    },
    [streaming, handleSend],
  );

  const handleExportAsPptx = useCallback(
    (fileName: string) => {
      if (streaming) return;
      const baseTitle = fileName.replace(/\.html?$/i, '') || fileName;
      const prompt =
        `Export @${fileName} as an editable PPTX file titled "${baseTitle}".\n\n` +
        `Use a PPTX skill (e.g. python-pptx) to produce a real .pptx — one slide per ` +
        `top-level section/page in the HTML. Preserve text content, headings, and the ` +
        `general layout intent. Save the file directly into the current project folder ` +
        `(this conversation's working directory) as \`${baseTitle}.pptx\` so it shows ` +
        `up in the file list, and report the on-disk path when done.`;
      const attachment: ChatAttachment = {
        path: fileName,
        name: fileName,
        kind: 'file',
      };
      void handleSend(prompt, [attachment]);
    },
    [streaming, handleSend],
  );

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    setMessages((curr) => {
      const next = curr.map((m) =>
        m.role === 'assistant' && m.endedAt === undefined
          ? { ...m, endedAt: Date.now() }
          : m,
      );
      const finalized = next.find(
        (m) =>
          m.role === 'assistant' &&
          m.endedAt !== undefined &&
          !curr.find((x) => x.id === m.id && x.endedAt !== undefined),
      );
      if (finalized) persistMessage(finalized);
      return next;
    });
  }, [persistMessage]);

  const handleNewConversation = useCallback(async () => {
    const fresh = await createConversation(project.id);
    if (!fresh) return;
    setConversations((curr) => [fresh, ...curr]);
    setActiveConversationId(fresh.id);
  }, [project.id]);

  const handleSelectConversation = useCallback((id: string) => {
    setActiveConversationId(id);
  }, []);

  const handleDeleteConversation = useCallback(
    async (id: string) => {
      const ok = await deleteConversationApi(project.id, id);
      if (!ok) return;
      setConversations((curr) => {
        const next = curr.filter((c) => c.id !== id);
        if (next.length === 0) {
          // Re-seed so the project always has at least one conversation
          // to write into.
          void createConversation(project.id).then((fresh) => {
            if (fresh) {
              setConversations([fresh]);
              setActiveConversationId(fresh.id);
            }
          });
        } else if (id === activeConversationId) {
          setActiveConversationId(next[0]!.id);
        }
        return next;
      });
    },
    [project.id, activeConversationId],
  );

  const handleRenameConversation = useCallback(
    async (id: string, title: string) => {
      const trimmed = title.trim() || null;
      setConversations((curr) =>
        curr.map((c) => (c.id === id ? { ...c, title: trimmed } : c)),
      );
      await patchConversation(project.id, id, { title: trimmed });
    },
    [project.id],
  );

  const handleProjectRename = useCallback(
    (newName: string) => {
      const trimmed = newName.trim();
      if (!trimmed || trimmed === project.name) return;
      const updated: Project = { ...project, name: trimmed, updatedAt: Date.now() };
      onProjectChange(updated);
      void patchProject(project.id, { name: trimmed });
    },
    [project, onProjectChange],
  );

  const projectMeta = useMemo(() => {
    const skill = skills.find((s) => s.id === project.skillId)?.name;
    const ds = designSystems.find((d) => d.id === project.designSystemId)?.title;
    return [skill, ds].filter(Boolean).join(' · ') || t('project.metaFreeform');
  }, [skills, designSystems, project.skillId, project.designSystemId, t]);

  const isDeck = useMemo(
    () => skills.find((s) => s.id === project.skillId)?.mode === 'deck',
    [skills, project.skillId],
  );

  // Hand the pending prompt to ChatPane exactly once. We snapshot the value
  // into local state on mount so it survives the ChatPane remount triggered
  // when `activeConversationId` resolves from `null` to a real id (the
  // `key={activeConversationId}` on ChatPane otherwise wipes the freshly
  // seeded composer draft). Once the conversation id is in place — meaning
  // ChatPane has remounted with the seed still available — we clear both
  // the local snapshot and the persisted pendingPrompt so future
  // conversation switches don't keep re-seeding the composer.
  const [initialDraft, setInitialDraft] = useState<string | undefined>(
    project.pendingPrompt,
  );
  useEffect(() => {
    if (initialDraft && activeConversationId) {
      setInitialDraft(undefined);
    }
  }, [initialDraft, activeConversationId]);
  useEffect(() => {
    if (project.pendingPrompt) onClearPendingPrompt();
  }, [project.pendingPrompt, onClearPendingPrompt]);

  return (
    <div className="project-shell">
      <AppTitleBar onBack={onBack} onOpenSettings={onOpenSettings} />

      {/* Horizontal panes */}
      <div
        className="project-body"
        style={{
          gridTemplateColumns: `${projectLayout.convWidth}px 4px ${projectLayout.chatWidth}px 4px minmax(0, 1fr)`,
        }}
      >
      {/* Conversations sidebar */}
      <aside className="conv-sidebar">
        <div className="conv-sidebar-head">
          <div className="conv-project-heading">
            <div className="conv-project-copy">
              <span
                className="conv-project-name"
                data-testid="project-title"
                contentEditable
                suppressContentEditableWarning
                tabIndex={0}
                role="textbox"
                onBlur={(e) => handleProjectRename(e.currentTarget.textContent ?? '')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    (e.currentTarget as HTMLElement).blur();
                  }
                }}
              >
                {project.name}
              </span>
              <span className="conv-sidebar-meta" data-testid="project-meta">{projectMeta}</span>
            </div>
          </div>
          <button
            className={`conv-template-btn${showProjectStatus ? ' active' : ''}`}
            type="button"
            onClick={() => setShowProjectStatus((value) => !value)}
            title="聊天看板"
            aria-label="聊天看板"
            aria-pressed={showProjectStatus}
          >
            <svg
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M8.00008 6V9H5.00008V6H8.00008ZM3.00008 4V11H10.0001V4H3.00008ZM13.0001 4H21.0001V6H13.0001V4ZM13.0001 11H21.0001V13H13.0001V11ZM13.0001 18H21.0001V20H13.0001V18ZM10.7072 16.2071L9.29297 14.7929L6.00008 18.0858L4.20718 16.2929L2.79297 17.7071L6.00008 20.9142L10.7072 16.2071Z" />
            </svg>
          </button>
          <button
            className="conv-new-btn"
            onClick={handleNewConversation}
            title={t('conv.new')}
            type="button"
          >
            <Icon name="plus" size={12} />
          </button>
        </div>
        {!showProjectStatus && <div className="conv-filter-tabs" role="tablist">
          {(['待开始', '进行中', '已结束', '询问', '待确定'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={convFilterTab === tab}
              className={`conv-filter-tab${convFilterTab === tab ? ' active' : ''}`}
              onClick={() => setConvFilterTab(tab)}
            >
              {tab}
            </button>
          ))}
        </div>}
        <div className="conv-list-body">
          {showProjectStatus ? (
            /* 聊天看板 — project status cards */
            <ProjectStatusInline
              project={project}
              conversations={conversations}
              activeConversationId={activeConversationId}
              messages={messages}
              files={projectFiles}
              streaming={streaming}
              error={error}
            />
          ) : (
            /* Default: conversation list */
            conversations.map((c) => (
              <div
                key={c.id}
                className={`conv-row${c.id === activeConversationId ? ' active' : ''}`}
                onClick={() => handleSelectConversation(c.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleSelectConversation(c.id); }}
              >
                <div className="conv-row-body">
                  <div className="conv-row-title">{c.title || t('conv.untitled')}</div>
                  <div className="conv-row-meta">{convRelTime(c.updatedAt)}</div>
                </div>
                <button
                  className="conv-row-del"
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(t('conv.deleteConfirm', { title: c.title || t('conv.untitled') }))) {
                      void handleDeleteConversation(c.id);
                    }
                  }}
                  title={t('conv.delete')}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
      </aside>
      <button
        type="button"
        aria-label={t('entry.resizeAria')}
        className={`project-resizer${resizingPane === 'conv' ? ' dragging' : ''}`}
        onMouseDown={startProjectResize('conv')}
      />

      {/* Chat column — always ChatPane (column 3 of project-body grid) */}
      <ChatPane
        key={activeConversationId ?? 'no-conv'}
        messages={messages}
        streaming={streaming}
        error={error}
        projectId={project.id}
        projectFiles={projectFiles}
        projectFileNames={projectFileNames}
        onEnsureProject={handleEnsureProject}
        onSend={handleSend}
        onStop={handleStop}
        onRequestOpenFile={requestOpenFile}
        initialDraft={initialDraft}
        onSubmitForm={(text) => {
          if (streaming) return;
          void handleSend(text, []);
        }}
        onContinueRemainingTasks={handleContinueRemainingTasks}
        onNewConversation={handleNewConversation}
        conversations={conversations}
        activeConversationId={activeConversationId}
        onSelectConversation={handleSelectConversation}
        onDeleteConversation={handleDeleteConversation}
        onRenameConversation={handleRenameConversation}
        onOpenSettings={onOpenSettings}
        compact
      />
      {/* Resizer between chat and right panel (column 4) */}
      <button
        type="button"
        aria-label={t('entry.resizeAria')}
        className={`project-resizer${resizingPane === 'chat' ? ' dragging' : ''}`}
        onMouseDown={startProjectResize('chat')}
      />
      {/* Right panel — always FileWorkspace (column 5) */}
      <FileWorkspace
        projectId={project.id}
        files={projectFiles}
        onRefreshFiles={() => {
          void refreshProjectFiles();
        }}
        isDeck={isDeck}
        onExportAsPptx={handleExportAsPptx}
        streaming={streaming}
        openRequest={openRequest}
        tabsState={openTabsState}
        onTabsStateChange={persistTabsState}
      />
      </div>
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

type StatusRowTone = 'active' | 'done' | 'muted' | 'warn';

interface StatusRow {
  id: string;
  label: string;
  meta: string;
  state: string;
  progress: number;
  tone?: StatusRowTone;
}

function ProjectStatusInline({
  project,
  conversations,
  activeConversationId,
  messages,
  files,
  streaming,
  error,
}: {
  project: Project;
  conversations: Conversation[];
  activeConversationId: string | null;
  messages: ChatMessage[];
  files: ProjectFile[];
  streaming: boolean;
  error: string | null;
}) {
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId);
  const assistantMessages = messages.filter((message) => message.role === 'assistant');
  const latestAssistant = [...assistantMessages].reverse().find((message) => message.events?.length);
  const latestTodos = latestTodosFromEvents(latestAssistant?.events);
  const completedTodos = latestTodos.filter((todo) => todo.status === 'completed').length;
  const reminderTexts = extractSystemReminders(messages);
  const statusEvents = messages
    .flatMap((message) => message.events ?? [])
    .filter((event): event is Extract<AgentEvent, { kind: 'status' }> => event.kind === 'status')
    .slice(-4);
  const usageEvent = [...messages]
    .flatMap((message) => message.events ?? [])
    .reverse()
    .find((event): event is Extract<AgentEvent, { kind: 'usage' }> => event.kind === 'usage');

  const todoProgress =
    latestTodos.length > 0 ? Math.round((completedTodos / latestTodos.length) * 100) : 0;
  const conversationProgress = streaming
    ? 72
    : assistantMessages.length > 0
      ? 100
      : messages.length > 0
        ? 36
        : 12;
  const fileProgress = files.length > 0 ? 100 : assistantMessages.length > 0 ? 52 : 16;

  const rows: StatusRow[] = [
    {
      id: 'conversation',
      label: activeConversation?.title || '未命名对话',
      meta: `${messages.length} 条消息`,
      state: streaming ? '生成中' : assistantMessages.length > 0 ? '已同步' : '待开始',
      progress: conversationProgress,
      tone: streaming ? 'active' : assistantMessages.length > 0 ? 'done' : 'muted',
    },
    {
      id: 'files',
      label: '项目文件',
      meta: `${files.length} 个文件`,
      state: files.length > 0 ? '已生成' : '等待产出',
      progress: fileProgress,
      tone: files.length > 0 ? 'done' : 'muted',
    },
    {
      id: 'todos',
      label: '任务进程',
      meta: latestTodos.length > 0 ? `${completedTodos}/${latestTodos.length} 已完成` : '暂无任务清单',
      state: latestTodos.length > 0 ? `${todoProgress}%` : '未建立',
      progress: latestTodos.length > 0 ? todoProgress : 10,
      tone: latestTodos.some((todo) => todo.status === 'in_progress') ? 'active' : 'done',
    },
    {
      id: 'reminders',
      label: '提醒状态',
      meta: reminderTexts.length > 0 ? `${reminderTexts.length} 条提醒` : '暂无提醒',
      state: reminderTexts.length > 0 ? '需关注' : '清爽',
      progress: reminderTexts.length > 0 ? 68 : 100,
      tone: reminderTexts.length > 0 ? 'warn' : 'done',
    },
  ];

  const eventRows = statusEvents.map((event, index): StatusRow => ({
    id: `event-${index}-${event.label}`,
    label: normalizeStatusLabel(event.label),
    meta: event.detail || '运行状态更新',
    state: index === statusEvents.length - 1 && streaming ? '当前' : '记录',
    progress: index === statusEvents.length - 1 && streaming ? 78 : 100,
    tone: index === statusEvents.length - 1 && streaming ? 'active' : 'muted',
  }));

  const reminderRows = reminderTexts.slice(-3).map((text, index): StatusRow => ({
    id: `reminder-${index}`,
    label: '系统提醒',
    meta: text,
    state: '提醒',
    progress: 66,
    tone: 'warn',
  }));

  return (
    <div className="conv-status-inline">
      <div className="conv-status-section">进程</div>
      {[...rows, ...eventRows].map((row) => (
        <ProjectStatusRow key={row.id} row={row} />
      ))}
      <div className="conv-status-section">提醒</div>
      {error ? (
        <ProjectStatusRow
          row={{
            id: 'error',
            label: '运行提醒',
            meta: error,
            state: '异常',
            progress: 100,
            tone: 'warn',
          }}
        />
      ) : null}
      {reminderRows.length > 0 ? (
        reminderRows.map((row) => <ProjectStatusRow key={row.id} row={row} />)
      ) : (
        <ProjectStatusRow
          row={{
            id: 'empty-reminders',
            label: '提醒状态',
            meta: usageEvent?.durationMs
              ? `最近一次用时 ${(usageEvent.durationMs / 1000).toFixed(1)}s`
              : '当前没有需要处理的提醒',
            state: '正常',
            progress: 100,
            tone: 'done',
          }}
        />
      )}
    </div>
  );
}

function ProjectStatusRow({ row }: { row: StatusRow }) {
  return (
    <div className="project-status-row" data-tone={row.tone ?? 'muted'}>
      <div className="project-status-row-main">
        <span className="project-status-row-label">{row.label}</span>
        <span className="project-status-row-meta">{row.meta}</span>
      </div>
      <span className="project-status-row-state">{row.state}</span>
      <div className="project-status-bar" aria-hidden="true">
        <span
          className="project-status-bar-fill"
          style={{ width: `${clamp(row.progress, 0, 100)}%` }}
        />
      </div>
    </div>
  );
}

function extractSystemReminders(messages: ChatMessage[]): string[] {
  const reminders: string[] = [];
  const re = /<system-reminder>([\s\S]*?)<\/system-reminder>/g;
  for (const message of messages) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(message.content)) !== null) {
      const reminder = (match[1] ?? '').replace(/\s+/g, ' ').trim();
      if (reminder) reminders.push(shortenText(reminder, 96));
    }
  }
  return reminders;
}

function normalizeStatusLabel(label: string): string {
  const map: Record<string, string> = {
    starting: '启动任务',
    initializing: '初始化',
    thinking: '思考中',
    running: '执行中',
    completed: '已完成',
  };
  return map[label] ?? label;
}

function shortenText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function convRelTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (diff < min) return 'just now';
  if (diff < hr) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hr)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(ts).toLocaleDateString();
}

function assistantAgentDisplayName(
  agentId: string | null,
  fallbackName?: string,
): string | undefined {
  return agentDisplayName(agentId, fallbackName) ?? undefined;
}
