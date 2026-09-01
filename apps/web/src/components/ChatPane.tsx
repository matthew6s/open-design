import { QuoteBar } from './chat/QuoteBar';
import { shouldShowJumpToLatest } from '../runtime/chat/jump-to-latest';
import {
  isAtBottom as isSampleAtBottom,
  nextFollowIntent,
  type FollowIntent,
  type ScrollSample,
} from '../runtime/chat/stick-to-bottom';
import { appendQuote, type ChatQuote } from '../runtime/chat/quote-selection';
import {
  captureElementScrollAnchor,
  scrollTopForElementScrollAnchor,
} from '../runtime/chat/element-scroll-anchor';
import {
  captureVirtualScrollAnchor,
  scrollTopForVirtualScrollAnchor,
  type VirtualScrollAnchor,
} from '../runtime/chat/virtual-scroll-anchor';
import {
  Fragment,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { hasOdCard, OD_NEXT_STRATEGY_ID, type ProjectMediaTask } from '@open-design/contracts';
import { useAnalytics } from '../analytics/provider';
import { getResolvedDeviceId } from '../analytics/client';
import {
  trackChatPanelClick,
  trackMessageQueueClick,
  trackRunFailedToastSurfaceView,
  trackRunRecoveryActionClick,
  trackRunRecoveryActionSurfaceView,
} from '../analytics/events';
import {
  buildRecoveryTaskAnalytics,
  runAgentProviderId,
} from '../analytics/run-task';
import { amrHandoffDeviceId, attributedAmrUrl, recordAmrEntry } from '../analytics/amr-attribution';
import { useI18n, useT } from '../i18n';
import { startersForProduct, type ProductType } from '../onboarding/recommendation';
import { starterCopyFor } from '../onboarding/starter-copy';
import type { DesignToolboxActionId } from '../runtime/design-toolbox';
import { isRetryableAssistantTerminalFailure } from '../runtime/design-delivery';
import {
  formatAttachmentSize,
  formatMessageClock,
  middleTruncateFileName,
  splitFileName,
} from '../runtime/chat/attachment';
import {
  attachmentNavDelta,
  attachmentNavState,
  type AttachmentNavState,
} from '../runtime/chat/attachment-nav';
import type { Dict } from '../i18n/types';
import { copyToClipboard } from '../lib/copy-to-clipboard';
import { useLiquidGlass } from '../hooks/useLiquidGlass';
import { fetchProjectMediaTasks, projectRawUrl } from '../providers/registry';
import { appendResourceQuery } from '../collab/workspace-identity';
import { useProjectCollabContext } from '../collab/collab-context';
import { takeComposerSeedFor } from '../state/libraryHandoff';
import { splitOnQuestionForms } from '../artifacts/question-form';
import { stripArtifact } from '../artifacts/strip';
import type { TodoItem } from '../runtime/todos';
import type {
  AppliedPluginSnapshot,
  ChatSessionMode,
  RunContextSelection,
  WorkspaceContextItem,
} from '@open-design/contracts';
import type {
  TrackingProjectKind,
  TrackingRunRecoveryActionType,
} from '@open-design/contracts/analytics';
import { isDesignSystemWorkspacePrompt } from '../design-system-auto-prompt';
import {
  isTodoWriteToolName,
  latestTodoWriteInputFromMessages,
  parseTodoWriteInput,
  previousTodosByAssistantMessageId,
} from '../runtime/todos';
import type { AppConfig, ChatAttachment, ChatCommentAttachment, ChatMessage, ChatMessageFeedbackChange, Conversation, DesignSystemSummary, PreviewComment, Project, ProjectFile, ProjectMetadata, SkillSummary } from '../types';
import { agentDisplayName } from '../utils/agentLabels';
import { commentTargetDisplayName, commentsToAttachments, simplePositionLabel } from '../comments';
import { AssistantMessage, type QuestionFormSubmitHandler } from './AssistantMessage';
import { chatSeam } from './chat/ChatRoot';
import { PlanPill } from './chat/PlanPill';
import { planPillState } from '../runtime/chat/plan-pill';
import { Reconnect } from './chat/Reconnect';
import type { ChatReconnectView } from '../runtime/chat/reconnect-state';
import { TodoCard } from './ToolCard';
import type { BrandBrowserAssistConfirm } from './OdCard';
import {
  DESIGN_SYSTEM_NEXT_STEP_ACTIONS,
  type NextStepActionsVariant,
} from './NextStepActions';
import { AmrGuidance } from './AmrGuidance';
import { AmrLoginPill } from './AmrLoginPill';
import {
  AMR_LOGIN_STATUS_EVENT,
  amrLoginStatusEventReason,
  isAmrSessionAuthenticated,
} from './amrLoginPolling';
import {
  amrPlansUrlForProfile,
  amrRechargeUrlForProfile,
  formatModelWindowRetryAt,
  hasSelfContainedRecovery,
  isReconnectOwnedFailure,
  resolveRunFailureUi,
  RUN_FAILURE_FALLBACK_MESSAGE_KEY,
} from '../runtime/amr-guidance';
import {
  fetchVelaLoginStatus,
  type VelaLoginStatus,
} from '../providers/daemon';
import { RESUME_CONTINUE_PROMPT } from '../runtime/resume';
import {
  canConsumeAmrAuthRetryContinuation,
  type AmrAuthRetryContinuation,
  type AmrAuthRetryPersonalAdoptionWitness,
} from '../runtime/amr-auth-retry-continuation';
import {
  ChatComposer,
  type ChatComposerHandle,
  type ChatSendOutcome,
  type ChatSendMeta,
} from './ChatComposer';
import type { PlaceholderScenario } from './home-hero/placeholderScenarios';
import { listDesignArtifactCandidates } from './design-files/designArtifacts';
import type { PluginFolderAgentAction } from './design-files/pluginFolderActions';
import { Icon, type IconName } from './Icon';
import { UserActionCard, type UserActionCardTone } from './UserActionCard';
import {
  RunErrorCard,
  RunErrorCardAction,
  RunErrorCardActionGroup,
} from './chat/RunErrorCard';
import { UpgradeCard } from './chat/UpgradeCard';
import { SupportDialog } from './chat/SupportDialog';
import { supportChannels } from './chat/support-channels';
import { ExportLogsAction } from './chat/ExportLogsAction';
import { repoConnectCopy } from './design-system-github-evidence';
import { isRenderableSketchJson, SketchPreview } from './SketchPreview';
import type { SettingsSection } from './SettingsDialog';

type TranslateFn = (key: keyof Dict, vars?: Record<string, string | number>) => string;

// Featured starter prompts shown on the empty chat. Clicking one fills
// the composer (does not auto-send) so users can tweak before sending.
// Each prompt is intentionally dense — it should showcase ambitious
// layout, typographic, and information-design moves rather than a
// generic landing page.
//
// Starter sets are picked per project kind (and per video model) so a
// fresh seedance video, a hyperframes html-in-canvas video, an image
// project and an audio project each see relevant prompts instead of the
// generic starter set. The default (prototype/deck/template/other/
// live-artifact) set stays i18n-translated via existing chat.example*
// keys so the user-facing copy keeps its localizations. The new media
// sets are inline English literals — they are technical agent prompts
// that work well across locales without translation, and going through
// i18n for each of them would balloon every Dict entry by 12+ keys.
type StarterPrompt = {
  icon: string;
  title: string;
  // Empty for path-scoped onboarding starters, which have no category tag.
  tag: string;
  prompt: string;
};

const DEFAULT_STARTER_KEYS: Array<{
  icon: string;
  titleKey: keyof Dict;
  tagKey: keyof Dict;
  promptKey: keyof Dict;
}> = [
  {
    icon: '▤',
    titleKey: 'chat.example1Title',
    tagKey: 'chat.example1Tag',
    promptKey: 'chat.example1Prompt',
  },
  {
    icon: '▦',
    titleKey: 'chat.example2Title',
    tagKey: 'chat.example2Tag',
    promptKey: 'chat.example2Prompt',
  },
  {
    icon: '◈',
    titleKey: 'chat.example3Title',
    tagKey: 'chat.example3Tag',
    promptKey: 'chat.example3Prompt',
  },
  {
    icon: '▶',
    titleKey: 'chat.example4Title',
    tagKey: 'chat.example4Tag',
    promptKey: 'chat.example4Prompt',
  },
];

const IMPORTED_ARTIFACTS_INITIAL_VISIBLE_COUNT = 5;
const IMPORTED_ARTIFACTS_REVEAL_COUNT = 5;
const CHAT_RAIL_MIN_USER_MESSAGES = 2;
// Above this the rail becomes a compact rolling wheel with faded extremes;
// at or below it the full column shows with no mask occlusion.
const CHAT_RAIL_WHEEL_MIN_USER_MESSAGES = 40;
const CHAT_RAIL_HIGHLIGHT_MS = 1200;

// Dock-style proximity effect: every dash rests at the same base length;
// the hovered dash grows to the full module width and only its 4 neighbors
// on each side are pulled along, easing off with distance.
const CHAT_RAIL_DASH_BASE_PX = 8;
const CHAT_RAIL_DASH_HOVER_PX = 16;
const CHAT_RAIL_DASH_NEIGHBOR_SPAN = 4;

function chatRailDashWidth(distance: number): number {
  if (distance > CHAT_RAIL_DASH_NEIGHBOR_SPAN) return CHAT_RAIL_DASH_BASE_PX;
  const falloff = 1 - distance / (CHAT_RAIL_DASH_NEIGHBOR_SPAN + 1);
  return (
    CHAT_RAIL_DASH_BASE_PX +
    (CHAT_RAIL_DASH_HOVER_PX - CHAT_RAIL_DASH_BASE_PX) * falloff * falloff
  );
}

const IMAGE_STARTERS: StarterPrompt[] = [
  {
    icon: '◯',
    title: 'Editorial portrait',
    tag: 'Portrait',
    prompt:
      'A close-up editorial portrait of a young creative director in their late 20s, soft natural light through tall studio windows, warm neutral palette (cream, taupe, soft black), shot at 85mm f/1.8 with shallow depth of field, sharp gaze straight to camera, subtle film grain, no makeup look.',
  },
  {
    icon: '▭',
    title: 'Product hero',
    tag: 'E-commerce',
    prompt:
      'A premium product hero shot of a single matte ceramic coffee mug on a warm cream paper backdrop. Hard rim light from the upper-left, gentle elongated shadow stretching to the lower-right, faint steam rising from the cup. Square crop, centered composition, room above for headline copy, no props or hands in frame.',
  },
  {
    icon: '◐',
    title: 'Flat illustration',
    tag: 'Illustration',
    prompt:
      'A flat vector illustration of a cozy reading nook by a rainy window — geometric shapes, restrained 5-color palette (cream, terracotta, deep teal, burnt sienna, soft black), thin 1.5px line accents, no gradients, no textures, soft drop shadows only on the foreground armchair.',
  },
];

// Pure-video / cinematic-shot starters for seedance, sora, kling, veo,
// grok-imagine and similar text-to-video models. Each prompt is one
// shot, restrained motion, and a clear visual concept the model can
// nail in 5-10 seconds.
const VIDEO_SEEDANCE_STARTERS: StarterPrompt[] = [
  {
    icon: '◉',
    title: 'Product reveal',
    tag: 'Cinematic',
    prompt:
      'A 5-second product reveal: a minimal high-end skincare bottle on a clean cream stone surface, soft side light from camera-left, slow camera push-in, subtle depth-of-field shift from the cap to the label, restrained motion, no text overlays, no people in frame.',
  },
  {
    icon: '▣',
    title: 'Lantern close-up',
    tag: 'Mood',
    prompt:
      'A 6-second cinematic close-up of a young woman holding a glowing paper lantern in a misty pine forest at golden hour. Shallow depth of field on her eyes, gentle dolly-in, ambient particles drifting through the warm shaft of light, no dialogue, ambient forest sound only.',
  },
  {
    icon: '⌘',
    title: 'Neon street drift',
    tag: 'Action',
    prompt:
      'A 5-second street-racing tracking shot at night in a neon-lit cyberpunk Hong Kong alley. Low-angle camera following a matte-black sports car drifting around a tight corner, motion blur on the wheels, lens flares from oncoming neon signs, rain-slick asphalt reflecting the lights, no on-screen text.',
  },
];

// HyperFrames HTML-in-canvas starters — these target the
// hyperframes-html video model where the renderer captures live DOM
// into a WebGL texture and runs shader effects on top. References:
// https://www.remotion.dev/docs/html-in-canvas (concept), the seven
// vfx-* catalog blocks shipped via `npx hyperframes add vfx-*`, and
// skills/hyperframes/references/html-in-canvas.md.
const VIDEO_HYPERFRAMES_STARTERS: StarterPrompt[] = [
  {
    icon: '◉',
    title: 'Magnifying glass reveal',
    tag: 'HTML-in-canvas',
    prompt:
      'Make a 5-second composition with a single line of bold display text on a clean canvas. Animate a round magnifying glass that travels left to right across the line, with subtle glass refraction warping the letters underneath as it passes. Use HyperFrames html-in-canvas — capture the text DOM and run the lens shader on top via a vfx-liquid-glass-style pass. Pure CSS for the text; the glass is a WebGL layer.',
  },
  {
    icon: '▦',
    title: 'CRT terminal scene',
    tag: 'Vintage VFX',
    prompt:
      "Make a CRT-screen composition: dark canvas, monospace terminal text typing `npx hyperframes init my-video`, then `claude` invoked with the prompt 'Add a CRT effect using HTML-in-canvas'. Apply a subtle convex-curvature shader, scanlines, slight chromatic aberration, and a soft phosphor glow on top of the live DOM via html-in-canvas. The terminal text stays as real CSS so it's pixel-sharp before the shader pass.",
  },
  {
    icon: '◈',
    title: 'Glitch breakdown',
    tag: 'Glitch',
    prompt:
      'Build a 6-second composition that displays a hero headline and a one-line subhead on a dark canvas, then breaks into a hard digital glitch — RGB channel split, horizontal displacement bands, brief frame-stutter, and a final clean reset. Capture the live DOM via html-in-canvas and run the glitch pass on top, so the type is real CSS underneath the shader.',
  },
];

// Speech-focused audio starters — the New Project audio panel only
// surfaces the `speech` kind today (see MediaProjectOptions), so we
// match that. If/when the music + sfx tabs come back, broaden this set.
const AUDIO_STARTERS: StarterPrompt[] = [
  {
    icon: '♪',
    title: 'Brand voiceover',
    tag: 'Speech',
    prompt:
      "A 30-second warm-toned narrative voiceover for a product launch video — confident but conversational, mid-tempo, with a beat of pause after the brand name. Script: 'Three years in the making. One simple promise. Meet [product name] — the way work was supposed to feel.' English, neutral North American accent.",
  },
  {
    icon: '♫',
    title: 'Onboarding narration',
    tag: 'Speech',
    prompt:
      "A 20-second friendly onboarding narration for a mobile app's first-launch screen. Reassuring, smiling tone, slow enough to feel attentive without sounding scripted. Script: 'Welcome to Loop. Let's set up your space — three quick questions and you're in. You can change any of this later.'",
  },
  {
    icon: '♬',
    title: 'Story passage read',
    tag: 'Speech',
    prompt:
      "A 45-second cinematic read of an opening passage. Low, measured delivery with breath between sentences, slightly intimate close-mic'd quality. Script: 'The city sleeps in pieces. A neon sign flickers above the ramen counter. Across the avenue, a window glows — the only one still on this side of midnight.'",
  },
];

function pickStarters(
  metadata: ProjectMetadata | undefined,
  t: TranslateFn,
): StarterPrompt[] {
  const kind = metadata?.kind;
  if (kind === 'image') return IMAGE_STARTERS;
  if (kind === 'video') {
    return metadata?.videoModel === 'hyperframes-html'
      ? VIDEO_HYPERFRAMES_STARTERS
      : VIDEO_SEEDANCE_STARTERS;
  }
  if (kind === 'audio') return AUDIO_STARTERS;
  return DEFAULT_STARTER_KEYS.map((entry) => ({
    icon: entry.icon,
    title: t(entry.titleKey),
    tag: t(entry.tagKey),
    prompt: t(entry.promptKey),
  }));
}

function sortArtifactsByModified(files: ProjectFile[]): ProjectFile[] {
  return [...files].sort(
    (a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name),
  );
}

function ImportedFolderArtifacts({
  projectId,
  files,
  onOpenFile,
  t,
}: {
  projectId: string | null;
  files: ProjectFile[];
  onOpenFile?: (name: string) => void;
  t: TranslateFn;
}) {
  const [visibleCount, setVisibleCount] = useState(IMPORTED_ARTIFACTS_INITIAL_VISIBLE_COUNT);

  useEffect(() => {
    setVisibleCount(IMPORTED_ARTIFACTS_INITIAL_VISIBLE_COUNT);
  }, [files]);

  if (files.length === 0) {
    return (
      <div className="chat-design-artifacts-empty" data-testid="chat-design-artifacts-empty">
        {t('designFiles.empty')}
      </div>
    );
  }

  const visibleFiles = files.slice(0, visibleCount);
  const hiddenCount = Math.max(0, files.length - visibleFiles.length);
  const revealCount = Math.min(IMPORTED_ARTIFACTS_REVEAL_COUNT, hiddenCount);
  const revealLabel = t('chat.designArtifactsShowMore', { count: revealCount });

  return (
    <div className="chat-design-artifacts" data-testid="chat-design-artifacts">
      {visibleFiles.map((file, index) => {
        const openable = Boolean(onOpenFile);
        const openLabel = `${t('designFiles.previewOpen')} ${file.name}`;
        const openFile = () => {
          onOpenFile?.(file.name);
        };
        return (
          <div
            key={file.name}
            className="chat-design-artifact"
            data-kind={file.kind}
            data-file-name={file.name}
            data-testid={`chat-design-artifact-${index}`}
            role={openable ? 'button' : 'listitem'}
            tabIndex={openable ? 0 : undefined}
            title={openLabel}
            aria-label={openLabel}
            onDoubleClick={openable ? openFile : undefined}
            onKeyDown={
              openable
                ? (event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    openFile();
                  }
                : undefined
            }
          >
            <div className="chat-design-artifact-preview" aria-hidden>
              <ChatArtifactPreview projectId={projectId} file={file} />
            </div>
            <div className="chat-design-artifact-meta">
              <span className="chat-design-artifact-name" title={file.name}>
                {file.name}
              </span>
              <span className="chat-design-artifact-kind">
                {chatArtifactKindLabel(file.kind, t)}
              </span>
            </div>
          </div>
        );
      })}
      {hiddenCount > 0 ? (
        <button
          type="button"
          className="chat-design-artifact chat-design-artifact-more"
          data-testid="chat-design-artifacts-more"
          aria-label={revealLabel}
          title={revealLabel}
          onClick={() => {
            setVisibleCount((current) =>
              Math.min(files.length, current + IMPORTED_ARTIFACTS_REVEAL_COUNT),
            );
          }}
        >
          <span className="chat-design-artifact-more-icon" aria-hidden>
            +
          </span>
          <span className="chat-design-artifact-more-count">
            {revealLabel}
          </span>
        </button>
      ) : null}
    </div>
  );
}

function ChatArtifactPreview({
  projectId,
  file,
}: {
  projectId: string | null;
  file: ProjectFile;
}) {
  const { workspaceContext } = useProjectCollabContext();
  if (!projectId) {
    return <ChatArtifactFallback kind={file.kind} />;
  }

  const url = appendResourceQuery(
    projectRawUrl(projectId, file.name, workspaceContext),
    `v=${Math.round(file.mtime)}`,
  );
  if (isRenderableSketchJson(file)) {
    return (
      <SketchPreview
        projectId={projectId}
        file={file}
        workspaceContext={workspaceContext}
      />
    );
  }
  if (file.kind === 'image' || file.kind === 'sketch') {
    return <img src={url} alt="" loading="lazy" />;
  }
  if (file.kind === 'html') {
    return (
      <iframe
        title={file.name}
        src={url}
        sandbox="allow-scripts allow-downloads"
        loading="lazy"
      />
    );
  }
  if (file.kind === 'video') {
    return <video src={url} muted playsInline preload="metadata" />;
  }
  return <ChatArtifactFallback kind={file.kind} />;
}

function ChatArtifactFallback({ kind }: { kind: ProjectFile['kind'] }) {
  return (
    <span className="chat-design-artifact-fallback">
      <Icon name={chatArtifactIcon(kind)} size={28} />
      <span>{chatArtifactShortKind(kind)}</span>
    </span>
  );
}

function chatArtifactIcon(kind: ProjectFile['kind']): IconName {
  if (kind === 'html' || kind === 'code') return 'file-code';
  if (kind === 'image' || kind === 'sketch') return 'image';
  if (kind === 'video' || kind === 'audio') return 'play';
  if (kind === 'presentation') return 'present';
  return 'file';
}

function chatArtifactShortKind(kind: ProjectFile['kind']): string {
  if (kind === 'html') return 'HTML';
  if (kind === 'image') return 'IMG';
  if (kind === 'sketch') return 'SKETCH';
  if (kind === 'video') return 'VIDEO';
  if (kind === 'pdf') return 'PDF';
  if (kind === 'presentation') return 'PPT';
  if (kind === 'document') return 'DOC';
  return 'FILE';
}

function chatArtifactKindLabel(kind: ProjectFile['kind'], t: TranslateFn): string {
  if (kind === 'html') return t('designFiles.kindHtml');
  if (kind === 'image') return t('designFiles.kindImage');
  if (kind === 'sketch') return t('designFiles.kindSketch');
  if (kind === 'video') return 'Video';
  if (kind === 'audio') return 'Audio';
  if (kind === 'pdf') return t('designFiles.kindPdf');
  if (kind === 'document') return t('designFiles.kindDocument');
  if (kind === 'presentation') return t('designFiles.kindPresentation');
  if (kind === 'spreadsheet') return t('designFiles.kindSpreadsheet');
  return t('designFiles.kindBinary');
}

interface Props {
  messages: ChatMessage[];
  streaming: boolean;
  loading?: boolean;
  error: string | null;
  // Identifies a pane-level error produced by an assistant run. This lets the
  // pane distinguish a stale run error from a later failure with identical
  // canonical text; non-run errors leave the source undefined.
  errorSourceAssistantId?: string | null;
  projectId: string | null;
  sessionMode?: ChatSessionMode;
  onSessionModeChange?: (mode: ChatSessionMode) => void;
  // Analytics-only — forwarded to AssistantMessage so the feedback
  // events know which project surface the rating applies to. Optional
  // (defaults to null/'prototype') so unit tests can mount ChatPane
  // without project context.
  projectKindForTracking?: TrackingProjectKind | null;
  projectFiles: ProjectFile[];
  activeProjectFileName?: string | null;
  hasActiveDesignSystem?: boolean;
  activeDesignSystem?: DesignSystemSummary | null;
  sendDisabled?: boolean;
  // Read-only viewer of a team-shared project. Beyond `sendDisabled` (which only
  // blocks the send action), this also disables the composer input itself and
  // hides the empty-state starter cards, since a member cannot start a
  // conversation on someone else's shared project.
  viewerOnly?: boolean;
  queuedItems?: QueuedSendItem[];
  onRemoveQueuedSend?: (id: string) => void;
  onUpdateQueuedSend?: (id: string, update: QueuedSendUpdate) => void;
  onReorderQueuedSends?: (orderedIds: string[]) => void;
  onSendQueuedNow?: (id: string) => void;
  /**
   * B11 「引导对话」: deliver a queued item into the turn that is still
   * running. Supplied only when the host has both a live run and an agent
   * whose CLI keeps reading stdin mid-turn; absent means the queue row
   * falls back to `onSendQueuedNow` under its own name.
   */
  onSteerQueuedSend?: (id: string) => void;
  /** Why steering is unavailable right now, shown on the fallback button. */
  steerBlockedReason?: string | null;
  // Names that exist in the project folder. Tool cards and chips use this
  // set to decide whether a path can be opened as a tab.
  projectFileNames?: Set<string>;
  // Daemon-resolved on-disk working directory of the current project —
  // positive-proof anchor for chat file-link routing (see AssistantMessage).
  projectResolvedDir?: string | null;
  onEnsureProject: () => Promise<string | null>;
  previewComments?: PreviewComment[];
  attachedComments?: PreviewComment[];
  onAttachComment?: (comment: PreviewComment) => void;
  onDetachComment?: (commentId: string) => void;
  onDeleteComment?: (commentId: string) => void;
  onSend: (
    prompt: string,
    attachments: ChatAttachment[],
    commentAttachments: ChatCommentAttachment[],
    meta?: ChatSendMeta,
  ) => ChatSendOutcome | Promise<ChatSendOutcome>;
  onRetry?: (
    assistantMessage: ChatMessage,
    recoveryActionType?: TrackingRunRecoveryActionType,
  ) => void;
  amrAuthRetryContinuation?: AmrAuthRetryContinuation | null;
  amrAuthRetryMountId?: string;
  amrAuthRetryWorkspaceIdentityKey?: string;
  amrAuthRetryPersonalAdoptionWitness?: AmrAuthRetryPersonalAdoptionWitness | null;
  onArmAmrAuthRetryContinuation?: (
    continuation: Omit<AmrAuthRetryContinuation, 'accountIdAtArm' | 'createdAtMs'>,
  ) => void;
  onConsumeAmrAuthRetryContinuation?: (
    continuation: AmrAuthRetryContinuation,
  ) => boolean;
  onDiscardAmrAuthRetryContinuation?: (
    continuation: AmrAuthRetryContinuation,
  ) => void;
  onResumeRun?: (assistantMessage: ChatMessage) => void;
  onStop: () => void;
  // Skills available for @-mention assembly. ProjectView filters out the
  // user's disabled set before passing them in here.
  skills?: SkillSummary[];
  // Click-to-open chain: passes a basename up to ProjectView, which sets
  // FileWorkspace's openRequest. Tool cards, attachment chips, and
  // produced-file chips all call this.
  onRequestOpenFile?: (name: string) => void;
  onRequestPluginDetails?: (pluginId: string) => void;
  onRequestDesignSystemDetails?: (system: DesignSystemSummary) => void;
  onRequestPluginFolderAgentAction?: (
    relativePath: string,
    action: PluginFolderAgentAction,
  ) => Promise<{ message?: string; url?: string } | void> | { message?: string; url?: string } | void;
  activePluginActionPaths?: Set<string>;
  hiddenPluginActionPaths?: Set<string>;
  // "Share to OpenDesign" button on each completed assistant message —
  // wired by ProjectView to handleSend with the bundled
  // `od-share-to-community` scenario's trigger prompt.
  onShareToOpenDesign?: (assistantMessageId: string) => void;
  shareToOpenDesignBusyMessageId?: string | null;
  forceStreamingMessageIds?: Set<string>;
  initialDraft?: string;
  // Product path of the Home recommendation that started this project. When
  // set (and concrete), the empty-conversation starter cards show that path's
  // starters — one-click composer replacements — instead of the generic set.
  onboardingStarterPath?: ProductType | null;
  composerPlaceholder?: string;
  onSubmitQuestionForm?: QuestionFormSubmitHandler;
  questionFormSubmitDisabled?: boolean;
  onContinueRemainingTasks?: (
    assistantMessage: ChatMessage,
    todos: TodoItem[],
  ) => boolean | void | Promise<boolean | void>;
  onAssistantFeedback?: (assistantMessage: ChatMessage, change: ChatMessageFeedbackChange) => void;
  // Client-side action for a brand-browser-assist od-card: open/focus the
  // Browser tab. Routed through the stable callbacks ref.
  onBrandBrowserAssistConfirm?: BrandBrowserAssistConfirm;
  // "Next step" affordance handlers forwarded to the last assistant message.
  // The featured design-toolbox rows are driven directly off the composer ref
  // owned here, so they need no handler from ProjectView (unlike onArtifactShare).
  /** `anchorId` 由产物卡那枚胶囊带上:菜单开在它旁边,而不是预览区右上角。 */
  onArtifactShare?: (fileName: string, anchorId?: string) => void;
  /** `anchorId` 同上。 */
  onArtifactDownload?: (fileName: string, anchorId?: string) => void;
  onForkFromMessage?: (assistantMessage: ChatMessage) => void;
  forkingMessageId?: string | null;
  // Header "+" button — kicks off ProjectView's create-conversation flow.
  onNewConversation?: () => void;
  newConversationDisabled?: boolean;
  // Conversation list that used to live in the topbar. The chat tab now
  // owns the list so users can browse + switch conversations without
  // leaving the pane.
  conversations: Conversation[];
  activeConversationId: string | null;
  // The conversation whose history the live `messages` array currently
  // reflects. Null while a switch is mid-flight (or after a load failure),
  // which is exactly when `messages.length` must NOT be trusted as the active
  // conversation's count — see `conversationMessageCount`. Callers that do not
  // track this (mounts whose loader resets/retags `messages` asynchronously)
  // leave it undefined and fall back to the persisted `conversation.messageCount`
  // for a stable list count.
  messagesConversationId?: string | null;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  // Composer settings/CLI button forwards to here. The dialog lives in App
  // (it owns the AppConfig lifecycle) so we just pass the open trigger.
  onOpenSettings?: (section?: SettingsSection) => void;
  /**
   * 〔更换模型〕—— 交付稿要的是「**直接打开模型选择器**,选完自动重跑」
   * (`error-ux-design.md:130`,S08)。宿主接上这个就走内联选择器;
   * 没接的宿主(首页那种没有内联列表的)回落到设置面板,总好过按了没反应。
   */
  onSwitchModel?: (assistantMessage: ChatMessage) => void;
  /**
   * 钱包余额提示(交付稿第 75 / 76 格的升级卡),`null` = 不提示。
   *
   * 单位美元,两档由余额自己决定:`> 0` 是「撑不完下一个任务」的暖橙档,
   * `= 0` 是「现在无法开始新任务」的红档。判定在 `runtime/amr-balance-gate.ts`,
   * 这里只负责**呈现** —— 卡在流水里,不挡发送(D4)。
   */
  amrBalanceCardUsd?: number | null;
  /**
   * 升级卡那颗按钮点下去做什么。给了就用它,没给就退回本组件自己的 plans 深链。
   *
   * 之所以由调用方给:**点了跳哪由身份 × 订阅决定**(规格 §6.V 的四组),而那份
   * 判据握在 ProjectView / EntryShell 手里 —— 它们才知道这一次要付钱的是哪个
   * 工作区、这个人有没有账单权限。聊天面板不该自己去猜。
   */
  onAmrBalanceUpgrade?: () => void;
  showByokRecoveryAction?: boolean;
  onSwitchToLocalCli?: () => void;
  onOpenAmrSettings?: () => void;
  onSwitchToAmrAndRetry?: (failedAssistant: ChatMessage) => void;
  // PR #3157: Antigravity's `agy -p` can't complete OAuth on its own,
  // so the auth banner offers a "Sign in via terminal" button that
  // POSTs to /api/agents/antigravity/oauth-launch. Handler resolves
  // after the daemon kicks off `osascript`/`x-terminal-emulator`/
  // `cmd /c start` so the UI can disable the button while in flight.
  onLaunchAntigravityOauth?: () => Promise<void>;
  // Same dialog, but landing on the External MCP tab. Forwarded to the
  // composer's `/mcp` slash and MCP picker button.
  onOpenMcpSettings?: () => void;
  // The composer "+" menu's "add plugin" / "add connector" rows route to the
  // home plugin-registry / connector-integration surfaces.
  onBrowsePlugins?: () => void;
  onOpenConnectors?: () => void;
  // True when this project is a GitHub-backed design system whose repository
  // evidence has not fully landed. Surfaces a "Connect your repo" CTA in the
  // empty chat state alongside the starter examples.
  connectRepoNeeded?: boolean;
  // Live GitHub connector status, used only to pick the connect-repo CTA copy
  // (connect vs re-import). Undefined until the status fetch resolves.
  githubConnected?: boolean;
  // Fires when the connect-repo CTA button is clicked. The parent decides what
  // it does based on connector status (open Connectors, or prefill the composer
  // with the import instruction).
  onConnectRepo?: () => void;
  // True once the deterministic brand extraction actually reached ready. Until
  // then the next-step card must stay on continue/recover actions even if the
  // latest assistant row is terminal.
  brandExtractionComplete?: boolean;
  // True for a programmatically-extracted brand project whose AI enrichment
  // never ran. The next-step card uses this to offer AI Optimize after the
  // extraction completion message.
  brandEnrichmentEligible?: boolean;
  // Runs the optional brand-enrichment turn. The parent sends the project's
  // seeded enrichment prompt with the default per-turn skill bundle.
  onContinueBrandEnrichment?: () => void;
  brandEnrichmentBusy?: boolean;
  // Runs or resumes the selected agent for an incomplete brand extraction
  // scaffold. Distinct from AI Optimize, which assumes a ready system exists.
  onContinueBrandAgentExtraction?: () => void;
  continueBrandAgentExtractionBusy?: boolean;
  // Restarts the deterministic programmatic pass for an incomplete brand
  // extraction without creating a duplicate design-system item.
  onContinueBrandExtraction?: () => void;
  continueBrandExtractionBusy?: boolean;
  // Creates a fresh design project using the current extracted design system.
  onCreateDesignFromActiveDesignSystem?: () => void;
  createDesignFromActiveDesignSystemBusy?: boolean;
  // Duplicates a regular project into a new design-system workspace and starts
  // the design-system generation pass from that copied evidence.
  onCreateDesignSystemFromProject?: () => void;
  createDesignSystemFromProjectBusy?: boolean;
  // Bumped by the parent to push a draft into the composer (used by the
  // "Import repo" CTA). The nonce lets the same text fire more than once.
  composerDraftSignal?: { text: string; nonce: number };
  // Optional pet wiring forwarded straight through to ChatComposer's
  // /pet button. When omitted the composer hides the button entirely.
  petConfig?: AppConfig['pet'];
  onAdoptPet?: (petId: string) => void;
  onTogglePet?: () => void;
  onOpenPetSettings?: () => void;
  projectMetadata?: ProjectMetadata;
  // Authoritative post-patch project from the daemon — see ChatComposer's
  // prop of the same name for the recency invariant.
  onProjectMetadataChange?: (updated: Project) => void;
  activeWorkspaceContext?: WorkspaceContextItem | null;
  initialWorkspaceContexts?: WorkspaceContextItem[];
  workspaceContexts?: WorkspaceContextItem[];
  currentSkillId?: string | null;
  onProjectSkillChange?: (skillId: string | null) => void;
  researchAvailable?: boolean;
  // Immutable snapshot of the plugin pinned to this project. When set
  // we suppress the in-composer plugin rail (the user already picked a
  // plugin on Home) and render the active plugin as a context chip on
  // each user message — that satisfies §8 "show context inside the run
  // message" without forcing a separate side widget.
  activePluginSnapshot?: AppliedPluginSnapshot | null;
  // SenseAudio BYOK only — wired straight through to ChatComposer for the
  // in-composer image-model picker. Active protocol is read so the picker
  // hides when the user is on any other BYOK tab (azure / openai / …).
  byokApiProtocol?: AppConfig['apiProtocol'];
  byokImageModel?: string;
  onChangeByokImageModel?: (model: string) => void;
  byokVideoModel?: string;
  onChangeByokVideoModel?: (model: string) => void;
  byokSpeechModel?: string;
  onChangeByokSpeechModel?: (model: string) => void;
  byokSpeechVoice?: string;
  onChangeByokSpeechVoice?: (voice: string) => void;
  composerFooterAccessory?: ReactNode;
  // Slot rendered next to the composer's "+" menu (e.g. the working-dir pill).
  composerLeadingAccessory?: ReactNode;
  // Forwarded straight to the chat composer's mid-chat design-system
  // switcher. ProjectView owns the project record so the parent is the
  // natural place to mirror the patched project after a PATCH lands.
  currentDesignSystemId?: string | null;
  onActiveDesignSystemChange?: (project: Project) => void;
  onShowToast?: (message: string) => void;
  // Optional transient UI owned by the project shell. Rendering it inside the
  // scroll-area wrapper keeps it structurally above the variable-height
  // composer instead of guessing a bottom offset from outside ChatPane.
  chatLogTray?: ReactNode;
  /**
   * 组件 22 · 重连(第 82–84 格)· S29。掉线期间流水的**最后一行**,`null` = 没掉线。
   *
   * 状态由 `runtime/chat/reconnect-state.ts` 推,信号来自传输层的 `onReconnect`;
   * 这里只负责把它画在该在的位置。恢复后调用方把这个 prop 置回 `null`,整行消失
   * ——设计稿明说不留「已恢复」。
   */
  reconnect?: ChatReconnectView | null;
  /**
   * 〔重新连接〕按下去做什么(22-3,预算用尽后那颗按钮)。
   *
   * 语义是**接回同一轮的流**(`?after=<lastEventId>` 续上),不是「重试」——
   * 重试会新建一轮,把已经跑出来的东西丢掉。不传就不出那颗按钮。
   */
  onManualReconnect?: () => void;
  // Project header slot. The former standalone chrome header row was removed;
  // its back button, project title (editable) and design-system picker moved
  // into the top of the chat pane. ProjectView owns the project record so it
  // renders these as slots rather than ChatPane re-deriving the data.
  onBack?: () => void;
  /** Collapse the conversation pane into workspace-focused mode (#5517's
   *  panel-left control). Takes precedence over onBack in the header. */
  onCollapse?: () => void;
  /** True when the collapse control renders OUTSIDE this pane (lifted into
   *  the tabs dock row) — suppresses the header's collapse/back slot. */
  collapseControlLifted?: boolean;
  backLabel?: string;
  projectHeader?: ReactNode;
  designSystemPicker?: ReactNode;
  config?: AppConfig;
}

const AMR_PROFILE_ENV_KEY = 'OPEN_DESIGN_AMR_PROFILE';

type Tab = 'chat' | 'comments';

const CHAT_MESSAGE_VIRTUALIZE_THRESHOLD = 80;
const CHAT_MESSAGE_OVERSCAN_PX = 900;
const CHAT_VIRTUAL_ROW_GAP_PX = 14;
const CHAT_VIRTUAL_MIN_ROW_HEIGHT = 36;
const CHAT_VIRTUAL_DEFAULT_VIEWPORT_PX = 640;
const CHAT_VIRTUAL_INITIAL_TAIL_ROWS = 16;
const CONVERSATION_ROW_HEIGHT_PX = 34;
const CONVERSATION_VIRTUALIZE_THRESHOLD = 36;
const CONVERSATION_OVERSCAN_ROWS = 8;

interface RunErrorDiagnosticInput {
  message: string;
  rawMessage?: string | null;
  errorCode?: string;
  /**
   * What the agent process actually printed before it died — already bounded
   * and secret-redacted by the daemon (`failureCardStderrTail`). This is the
   * "original error" the card's copy promises: for a whole family of failures
   * the daemon's own sentence is generic ("…exited without a terminal result")
   * and the real cause exists nowhere else the user can reach.
   */
  stderrTail?: string | null;
  traceId?: string;
  projectId?: string | null;
  conversationId?: string | null;
  assistantMessageId?: string;
  agentId?: string;
}

interface QueuedSendItem {
  id: string;
  prompt: string;
  attachments?: ChatAttachment[];
  commentAttachments?: ChatCommentAttachment[];
  meta?: ChatSendMeta;
}

interface QueuedSendUpdate {
  prompt: string;
  attachments: ChatAttachment[];
  commentAttachments: ChatCommentAttachment[];
  meta?: ChatSendMeta;
}

// Gap left above the anchored user message when it is pinned to the top.
const ANCHOR_TOP_PADDING = 12;

/**
 * Fold an OD Next logical task into ONE conversation turn.
 *
 * A Full Plan turn runs as several physical Runs (request -> production). The
 * user asked once, and the daemon-issued continuation carries no prompt of its
 * own, so rendering each Run as its own message shows an answer nobody asked
 * for — with its own author line and its own "finished" affordances mid-turn.
 *
 * The daemon stays the single writer of one message per Run; only the view is
 * folded. Every continuation's content, events and produced files are appended
 * to the turn's first message in Run order, so nothing is dropped and nothing
 * is duplicated.
 */
export function foldStrategyTaskTurns(messages: ChatMessage[]): ChatMessage[] {
  if (!messages.some((message) => (message.strategyTaskRunIndex ?? 0) > 0)) {
    return messages;
  }
  const folded: ChatMessage[] = [];
  const turnHeadIndexByTask = new Map<string, number>();
  for (const message of messages) {
    const taskId = message.strategyTaskExecutionId;
    const runIndex = message.strategyTaskRunIndex ?? 0;
    if (message.role !== 'assistant' || !taskId) {
      folded.push(message);
      continue;
    }
    if (runIndex === 0 || !turnHeadIndexByTask.has(taskId)) {
      turnHeadIndexByTask.set(taskId, folded.length);
      folded.push(message);
      continue;
    }
    const headIndex = turnHeadIndexByTask.get(taskId)!;
    const head = folded[headIndex]!;
    const headContent = head.content ?? '';
    const tailContent = message.content ?? '';
    folded[headIndex] = {
      ...head,
      content: tailContent
        ? `${headContent}${headContent && !headContent.endsWith('\n') ? '\n\n' : ''}${tailContent}`
        : headContent,
      events: [...(head.events ?? []), ...(message.events ?? [])],
      producedFiles: [...(head.producedFiles ?? []), ...(message.producedFiles ?? [])],
      // The turn's status is the latest Run's: the earlier Runs finishing is an
      // internal step, not the turn ending.
      runId: message.runId ?? head.runId,
      runStatus: message.runStatus ?? head.runStatus,
      // Likewise the task verdict: only the final Run of the chain carries it,
      // and the folded turn is what the pinned todo card reads.
      ...(message.strategyTaskDelivered
        ? { strategyTaskDelivered: message.strategyTaskDelivered }
        : {}),
      ...(message.endedAt ? { endedAt: message.endedAt } : {}),
      ...(message.resultDeliveryState
        ? { resultDeliveryState: message.resultDeliveryState }
        : {}),
    };
  }
  return folded;
}

function shouldHideEmptyBrandAssistantMessage(message: ChatMessage, metadata?: ProjectMetadata): boolean {
  if (metadata?.importedFrom !== 'brand-extraction' && metadata?.kind !== 'brand') return false;
  if (message.role !== 'assistant') return false;
  if (brandAssistantTextHasVisibleContent(message.content)) return false;
  if ((message.events ?? []).some(hasVisibleBrandAssistantEvent)) return false;
  if ((message.producedFiles?.length ?? 0) > 0) return false;
  return Boolean(message.runStatus || message.endedAt);
}

function brandAssistantTextHasVisibleContent(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (hasOdCard(trimmed)) return true;
  const withoutArtifacts = stripArtifact(trimmed).trim();
  if (!withoutArtifacts) return false;
  return splitOnQuestionForms(withoutArtifacts).some((segment) => {
    if (segment.kind === 'form') return true;
    return segment.text.trim().length > 0;
  });
}

const HIDDEN_BRAND_ASSISTANT_STATUS_LABELS = new Set([
  'streaming',
  'starting',
  'running',
  'working',
  'requesting',
  'thinking',
  'empty_response',
  'done',
  'completed',
]);

function hasVisibleBrandAssistantEvent(event: NonNullable<ChatMessage['events']>[number]): boolean {
  switch (event.kind) {
    case 'text':
      return brandAssistantTextHasVisibleContent(event.text);
    case 'thinking':
      return event.text.trim().length > 0;
    case 'tool_use':
    case 'live_artifact':
    case 'live_artifact_refresh':
    case 'plugin_candidate':
      return true;
    case 'tool_result':
      return false;
    case 'raw':
      return false;
    case 'status':
      return !HIDDEN_BRAND_ASSISTANT_STATUS_LABELS.has(event.label);
    case 'usage':
    case 'diagnostic':
    case 'conversation_title':
    // Protocol metadata for this turn's done marker — never user-visible.
    case 'done_key':
    // The follow-up suggestions are an affordance under the answer, not
    // content of the answer — a turn that produced only these is still empty.
    case 'next_steps':
    // Same for the display intent: `<od-focus …/>` says which artifacts to
    // show and which file to open. It is a directive ABOUT the turn's output,
    // never output itself, so a turn carrying only this is still empty.
    case 'artifact_focus':
      return false;
  }
}

function mediaTaskRunKey(
  messages: ChatMessage[],
  includeLatestAssistantRun: boolean,
): string {
  const runIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.runId) continue;
    const hasMediaCall = (message.events ?? []).some((event) => {
      if (event.kind !== 'tool_use' || !event.input || typeof event.input !== 'object') return false;
      const command = (event.input as Record<string, unknown>).command;
      return typeof command === 'string' && /media\s+generate/.test(command) && !/--help\b/.test(command);
    });
    if (hasMediaCall) runIds.add(message.runId);
  }
  /*
   * ACP reports terminal-backed tool_use only after the command exits. While
   * an image call is still running, the run's media task is therefore the
   * first (and only) observable signal. Track the active streaming run even
   * before a media command appears so polling can discover that task.
   */
  if (includeLatestAssistantRun) {
    const latestRunId = latestAssistantRunId(messages);
    if (latestRunId) runIds.add(latestRunId);
  }
  return [...runIds].sort().join(',');
}

function sameMediaTasks(a: ProjectMediaTask[], b: ProjectMediaTask[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((task, index) => {
    const other = b[index];
    return other !== undefined
      && task.taskId === other.taskId
      && task.runId === other.runId
      && task.status === other.status
      && task.startedAt === other.startedAt
      && task.endedAt === other.endedAt
      && task.file?.name === other.file?.name
      && task.error?.code === other.error?.code
      && task.error?.message === other.error?.message;
  });
}

function latestAssistantRunId(messages: ChatMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant') return message.runId;
  }
  return undefined;
}

export function ChatPane({
  messages,
  streaming,
  loading = false,
  sendDisabled = false,
  viewerOnly = false,
  queuedItems = [],
  error,
  errorSourceAssistantId,
  projectId,
  sessionMode = 'design',
  onSessionModeChange,
  projectKindForTracking = null,
  projectFiles,
  activeProjectFileName = null,
  hasActiveDesignSystem = false,
  activeDesignSystem = null,
  projectFileNames,
  projectResolvedDir,
  onEnsureProject,
  previewComments = [],
  attachedComments = [],
  onAttachComment,
  onDetachComment,
  onDeleteComment,
  onSend,
  onRetry,
  amrAuthRetryContinuation = null,
  amrAuthRetryMountId,
  amrAuthRetryWorkspaceIdentityKey,
  amrAuthRetryPersonalAdoptionWitness = null,
  onArmAmrAuthRetryContinuation,
  onConsumeAmrAuthRetryContinuation,
  onDiscardAmrAuthRetryContinuation,
  onResumeRun,
  onStop,
  onRemoveQueuedSend,
  onUpdateQueuedSend,
  onReorderQueuedSends,
  onSendQueuedNow,
  onSteerQueuedSend,
  steerBlockedReason,
  onRequestOpenFile,
  onRequestPluginDetails,
  onRequestDesignSystemDetails,
  onRequestPluginFolderAgentAction,
  activePluginActionPaths,
  hiddenPluginActionPaths,
  onShareToOpenDesign,
  shareToOpenDesignBusyMessageId,
  forceStreamingMessageIds,
  initialDraft,
  onboardingStarterPath = null,
  composerPlaceholder,
  onSubmitQuestionForm,
  questionFormSubmitDisabled = false,
  onContinueRemainingTasks,
  onAssistantFeedback,
  onBrandBrowserAssistConfirm,
  onArtifactShare,
  onArtifactDownload,
  onForkFromMessage,
  forkingMessageId = null,
  onNewConversation,
  newConversationDisabled = false,
  conversations,
  activeConversationId,
  messagesConversationId = null,
  onSelectConversation,
  onDeleteConversation,
  onOpenSettings,
  onSwitchModel,
  amrBalanceCardUsd = null,
  onAmrBalanceUpgrade,
  showByokRecoveryAction = false,
  onSwitchToLocalCli,
  onOpenAmrSettings,
  onSwitchToAmrAndRetry,
  onLaunchAntigravityOauth,
  onOpenMcpSettings,
  onBrowsePlugins,
  onOpenConnectors,
  connectRepoNeeded,
  githubConnected,
  onConnectRepo,
  brandExtractionComplete = false,
  brandEnrichmentEligible,
  onContinueBrandEnrichment,
  brandEnrichmentBusy,
  onContinueBrandAgentExtraction,
  continueBrandAgentExtractionBusy,
  onContinueBrandExtraction,
  continueBrandExtractionBusy,
  onCreateDesignFromActiveDesignSystem,
  createDesignFromActiveDesignSystemBusy,
  onCreateDesignSystemFromProject,
  createDesignSystemFromProjectBusy,
  composerDraftSignal,
  petConfig,
  onAdoptPet,
  onTogglePet,
  onOpenPetSettings,
  projectMetadata,
  onProjectMetadataChange,
  activeWorkspaceContext,
  initialWorkspaceContexts = [],
  workspaceContexts = [],
  currentSkillId = null,
  onProjectSkillChange,
  researchAvailable,
  activePluginSnapshot,
  skills = [],
  byokApiProtocol,
  byokImageModel,
  onChangeByokImageModel,
  byokVideoModel,
  onChangeByokVideoModel,
  byokSpeechModel,
  onChangeByokSpeechModel,
  byokSpeechVoice,
  onChangeByokSpeechVoice,
  composerLeadingAccessory,
  composerFooterAccessory,
  currentDesignSystemId,
  onActiveDesignSystemChange,
  onShowToast,
  chatLogTray,
  reconnect = null,
  onManualReconnect,
  onBack,
  onCollapse,
  collapseControlLifted,
  backLabel,
  projectHeader,
  designSystemPicker,
  config,
}: Props) {
  const { workspaceContext } = useProjectCollabContext();
  const { t, locale } = useI18n();
  const analytics = useAnalytics();
  const displayMessages = useMemo(
    () => foldStrategyTaskTurns(
      messages.filter((message) => !shouldHideEmptyBrandAssistantMessage(message, projectMetadata)),
    ),
    [messages, projectMetadata],
  );
  const trackedMediaRunKey = useMemo(
    () => mediaTaskRunKey(displayMessages, streaming),
    [displayMessages, streaming],
  );
  const liveMediaRun = useMemo(() => {
    if (!streaming || !trackedMediaRunKey) return false;
    const runId = latestAssistantRunId(displayMessages);
    return Boolean(runId && trackedMediaRunKey.split(',').includes(runId));
  }, [displayMessages, streaming, trackedMediaRunKey]);
  const [projectMediaTasks, setProjectMediaTasks] = useState<ProjectMediaTask[]>([]);
  useEffect(() => {
    if (!projectId || !trackedMediaRunKey) {
      setProjectMediaTasks([]);
      return;
    }
    const trackedRunIds = new Set(trackedMediaRunKey.split(','));
    let canceled = false;
    let timer: number | undefined;
    const refresh = async (): Promise<void> => {
      try {
        const response = await fetchProjectMediaTasks(projectId, workspaceContext);
        if (canceled) return;
        const relevant = response.tasks
          .filter((task) => task.surface === 'image' && task.runId && trackedRunIds.has(task.runId))
          .sort((a, b) => a.startedAt - b.startedAt);
        setProjectMediaTasks((current) => sameMediaTasks(current, relevant) ? current : relevant);
        if (liveMediaRun || relevant.some((task) => task.status === 'queued' || task.status === 'running')) {
          timer = window.setTimeout(() => void refresh(), 750);
        }
      } catch {
        if (!canceled && liveMediaRun) timer = window.setTimeout(() => void refresh(), 1500);
      }
    };
    void refresh();
    return () => {
      canceled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [liveMediaRun, projectId, trackedMediaRunKey, workspaceContext]);
  const mediaTasksByRunId = useMemo(() => {
    const grouped = new Map<string, ProjectMediaTask[]>();
    for (const task of projectMediaTasks) {
      if (!task.runId) continue;
      const tasks = grouped.get(task.runId) ?? [];
      tasks.push(task);
      grouped.set(task.runId, tasks);
    }
    return grouped;
  }, [projectMediaTasks]);
  const amrProfile = config?.agentCliEnv?.amr?.[AMR_PROFILE_ENV_KEY] ?? null;
  const [inlineAmrLoginStatus, setInlineAmrLoginStatus] =
    useState<VelaLoginStatus | null>(null);
  const amrAuthRetrySignedOutWitnessRef =
    useRef<AmrAuthRetryContinuation | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const chatLogScrollIdleTimerRef = useRef<number | null>(null);
  const historyWrapRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<ChatComposerHandle | null>(null);
  const composerSlotRef = useRef<HTMLDivElement | null>(null);
  const composerLayerRef = useRef<HTMLDivElement | null>(null);
  const queuedSendStripRef = useRef<HTMLDivElement | null>(null);
  const didInitialScrollRef = useRef(false);
  const runFailedToastSurfaceKeysRef = useRef<Set<string>>(new Set());
  const runRecoverySurfaceKeysRef = useRef<Set<string>>(new Set());
  /*
   * 「还跟着最新输出吗」的**意图**,以及上一次已知的滚动几何(判方向要用)。
   * 规则全在 `runtime/chat/stick-to-bottom.ts`,那里也写了为什么不能像以前那样
   * 从 `distance < 80` 反推 —— 反推会在流式输出下锁死,用户就滚不上去了。
   *
   * 这两个都是 ref:它们每帧都可能被读写,进 state 会把整个面板重渲一遍
   * (`use-stick-to-bottom` 抱怨最多的 issue #14 就是这个)。给屏幕看的那一个
   * 布尔量(浮标显不显示)才是 state。
   */
  const followIntentRef = useRef<FollowIntent>({ following: true, escaped: false });
  const lastScrollSampleRef = useRef<ScrollSample>({
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  });
  const scrolledToFormRef = useRef<Set<string>>(new Set());
  const refreshInlineAmrLoginStatus = useCallback(async (options: { refresh?: boolean } = {}) => {
    const next = await fetchVelaLoginStatus(options).catch(() => null);
    if (next) setInlineAmrLoginStatus(next);
    return next;
  }, []);

  useEffect(() => {
    void refreshInlineAmrLoginStatus();
    const onAmrLoginStatusChange = (event: Event) => {
      const reason = amrLoginStatusEventReason(event);
      if (reason === 'login-canceled') return;
      void refreshInlineAmrLoginStatus();
    };
    window.addEventListener(AMR_LOGIN_STATUS_EVENT, onAmrLoginStatusChange);
    return () => {
      window.removeEventListener(AMR_LOGIN_STATUS_EVENT, onAmrLoginStatusChange);
    };
  }, [refreshInlineAmrLoginStatus]);

  useEffect(() => {
    const refreshAfterExternalAmrReturn = () => {
      if (document.visibilityState === 'hidden') return;
      void refreshInlineAmrLoginStatus({ refresh: true });
    };
    window.addEventListener('focus', refreshAfterExternalAmrReturn);
    document.addEventListener('visibilitychange', refreshAfterExternalAmrReturn);
    return () => {
      window.removeEventListener('focus', refreshAfterExternalAmrReturn);
      document.removeEventListener('visibilitychange', refreshAfterExternalAmrReturn);
    };
  }, [refreshInlineAmrLoginStatus]);

  // "Anchor the just-sent turn to the top" (ChatGPT-style). On send we pin
  // the user's message to the top of the viewport and let the reply stream
  // below it instead of following the bottom. `pending` is armed by the
  // composer's onSend; the messages effect promotes it to `active` once the
  // new user turn actually renders. A dynamic tail spacer reserves just
  // enough real, scrollable blank space below the turn so the message can
  // reach the top even when the reply is short. The spacer is only resized
  // while the message sits at its pinned position — once the user scrolls
  // below it, the reserved blank stays put (no collapse, no jump).
  const anchorPendingRef = useRef(false);
  const anchorActiveRef = useRef(false);
  const tailSpacerRef = useRef<HTMLDivElement | null>(null);
  const chatRailHighlightTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const [chatRailHighlightedMessageId, setChatRailHighlightedMessageId] =
    useState<string | null>(null);
  const prevStreamingRef = useRef(streaming);
  const prevLastUserIdRef = useRef<string | undefined>(undefined);
  // AssistantMessage's interaction callbacks are re-created per render and
  // excluded from its memo comparison (so streaming doesn't re-render every
  // message). Route them through this ref so a memoized message still calls the
  // LATEST handler. See areAssistantMessagePropsEqual in AssistantMessage.tsx.
  const assistantCallbacksRef = useRef<AssistantCallbacks>({
    onSubmitQuestionForm,
    onContinueRemainingTasks,
    onAssistantFeedback,
    onBrandBrowserAssistConfirm,
    onArtifactShare,
    onForkFromMessage,
    onShareToOpenDesign,
    onNextStepAiOptimize: onContinueBrandEnrichment,
    onNextStepContinueExtraction: onContinueBrandExtraction,
    onNextStepContinueAiExtraction: onContinueBrandAgentExtraction,
    onNextStepCreateDesign: onCreateDesignFromActiveDesignSystem,
    onNextStepCreateDesignSystem: onCreateDesignSystemFromProject,
  });
  assistantCallbacksRef.current = {
    onSubmitQuestionForm,
    onContinueRemainingTasks,
    onAssistantFeedback,
    onBrandBrowserAssistConfirm,
    onArtifactShare,
    onForkFromMessage,
    onShareToOpenDesign,
    onNextStepAiOptimize: onContinueBrandEnrichment,
    onNextStepContinueExtraction: onContinueBrandExtraction,
    onNextStepContinueAiExtraction: onContinueBrandAgentExtraction,
    onNextStepCreateDesign: onCreateDesignFromActiveDesignSystem,
    onNextStepCreateDesignSystem: onCreateDesignSystemFromProject,
  };
  // Featured design-toolbox follow-up rows on the assistant "next step" card.
  // The toolbox left the "+" menu, so these route straight into the composer
  // we own here: seeding an action's prompt+skill, or opening the full panel.
  // Both stay stable (composer ref + no deps) so AssistantMessage stays memoized.
  const handleToolboxAction = useCallback((id: DesignToolboxActionId) => {
    composerRef.current?.applyDesignToolboxAction(id);
  }, []);
  const handleNextStepPromptAction = useCallback((
    prompt: string,
    options?: { sessionMode?: ChatSessionMode },
  ) => {
    if (options?.sessionMode && options.sessionMode !== sessionMode) {
      onSessionModeChange?.(options.sessionMode);
    }
    composerRef.current?.setDraft(prompt, {
      entryFrom: 'next_step',
      sessionMode: options?.sessionMode,
    });
  }, [onSessionModeChange, sessionMode]);

  /**
   * 下一步建议只是可编辑的起草入口。它与其他 next-step prompt
   * 共用 Composer 的 `setDraft` 路径,保留 `entryFrom` 归因;只有用户
   * 显式点击发送才会调用 `onSend`、持久化消息并创建 run。
   */
  const handleNextStepSuggestion = useCallback(
    (text: string) => {
      const prompt = text.trim();
      if (!prompt) return;
      composerRef.current?.setDraft(prompt, { entryFrom: 'next_step' });
    },
    [],
  );

  const handleChatRailNavigate = useCallback(
    (message: ChatMessage, messageIndex: number) => {
      const log = logRef.current;
      if (!log) return;
      releaseFollow();
      anchorActiveRef.current = false;
      scrollChatLogToMessage(log, displayMessages, message.id, messageIndex);
      // 浮标由几何说了算,不在这里硬点亮:这次跳转可能落在一条**已经在底部**的
      // 消息上(短会话里点最后一条),那时底下没有可回的东西。
      syncFollowState();
      setChatRailHighlightedMessageId(message.id);
      if (chatRailHighlightTimerRef.current) {
        clearTimeout(chatRailHighlightTimerRef.current);
      }
      chatRailHighlightTimerRef.current = setTimeout(() => {
        setChatRailHighlightedMessageId((current) =>
          current === message.id ? null : current,
        );
        chatRailHighlightTimerRef.current = undefined;
      }, CHAT_RAIL_HIGHLIGHT_MS);
    },
    [displayMessages],
  );

  useEffect(() => {
    return () => {
      if (chatRailHighlightTimerRef.current) {
        clearTimeout(chatRailHighlightTimerRef.current);
      }
    };
  }, []);
  const handlePickSkill = useCallback((skillId: string) => {
    composerRef.current?.applyDesignToolboxSkill(skillId);
  }, []);
  /**
   * 生图失败格的「重试」(设计稿组件 12 · 第 11 格)。
   *
   * 事件流里既没有「重发第 N 张」这条动作,也没有「哪一张砸了」的顺序信息 ——
   * 拿得到的只有「这一行一共几张、成了几张、砸了几张」。所以重试走**正常的发送路径**:
   * 组一句人话交给 agent(它知道刚才在生成什么),而不是伪造一条工具调用。
   * 这是今天能真正接上的做法;等 daemon 补了逐张重发的动作再换成直连(规格 D59)。
   */
  /**
   * 正文取词(设计稿组件 23)。在助手正文里选中一段话 → 浮条 →「添加到对话」→
   * 输入框上方多一枚芯片。发送时把这几段话作为**引文前缀**带给 agent。
   */
  const [quotes, setQuotes] = useState<ChatQuote[]>([]);
  const handleQuote = useCallback((text: string, messageId: string | null) => {
    setQuotes((prev) => appendQuote(prev, {
      id: `${Date.now()}-${prev.length}`,
      text,
      messageId: messageId ?? '',
    }));
    // 收掉选区,浮条跟着消失 —— 不然它会一直浮在那儿
    window.getSelection()?.removeAllRanges();
  }, []);
  const clearQuotes = useCallback(() => setQuotes([]), []);

  const handleRetryImage = useCallback((row: { total: number; done: number; failed: number }, index: number) => {
    // The media-task row now preserves actual task order. Keep the localized
    // retry sentence, and append the universal slot coordinate so the agent
    // retries only the clicked output when more than one cell failed.
    const prompt = `${t('chat.record.retryImage', { count: 1 })} (${index + 1}/${row.total})`;
    void onSend(prompt, [], []);
  }, [onSend, t]);
  const latestAssistantForBrandState = useMemo(() => {
    for (let i = displayMessages.length - 1; i >= 0; i -= 1) {
      const message = displayMessages[i]!;
      if (message.role === 'assistant') return message;
    }
    return null;
  }, [displayMessages]);
  const nextStepVariant: NextStepActionsVariant = sessionMode === 'plan'
    ? 'plan'
    : isDesignSystemNextStepProject(projectMetadata)
      ? isBrandExtractionNextStepProject(projectMetadata)
        ? brandExtractionComplete
          ? 'brand-extraction'
          : !latestAssistantForBrandState || isProgrammaticBrandAssistantMessage(latestAssistantForBrandState)
            ? 'brand-programmatic-incomplete'
            : 'brand-ai-incomplete'
        : 'design-system'
      : 'default';
  const blankProjectComposerScenarios = useMemo<PlaceholderScenario[]>(
    () => pickStarters(projectMetadata, t).map((starter, index) => ({
      id: `blank-${projectMetadata?.kind ?? 'prototype'}-${index}`,
      text: starter.prompt,
      chipId: 'project',
    })),
    [projectMetadata, t],
  );
  const followUpComposerScenarios = useMemo<PlaceholderScenario[]>(() => {
    if (nextStepVariant === 'design-system') {
      return DESIGN_SYSTEM_NEXT_STEP_ACTIONS.map((action) => ({
        id: action.id,
        text: action.prompt,
        chipId: 'design-system',
      }));
    }
    if (nextStepVariant === 'plan') {
      return [
        {
          id: 'plan-generate-from-doc',
          text: t('nextStep.planGeneratePrompt'),
          chipId: 'plan',
          sessionMode: 'design',
        },
        {
          id: 'plan-improve-doc',
          text: t('nextStep.planImprovePrompt'),
          chipId: 'plan',
          sessionMode: 'plan',
        },
      ];
    }
    const promptPairs: Array<[string, string]> = [
      ['auto-match', t('chat.designToolbox.prompt.autoMatchIntro')],
      ['visual-polish', t('chat.designToolbox.prompt.visualPolish')],
      ['asset-search', t('chat.designToolbox.prompt.assetSearch')],
      ['icon-workflow', t('chat.designToolbox.prompt.iconWorkflow')],
      ['anti-ai-polish', t('chat.designToolbox.prompt.antiAiPolish')],
      ['motion-polish', t('chat.designToolbox.prompt.motionPolish')],
      ['chart-gen', t('chat.designToolbox.prompt.chartGen')],
    ];
    return promptPairs.map(([id, text]) => ({
      id: `follow-up-${id}`,
      text,
      chipId: 'design-toolbox',
    }));
  }, [nextStepVariant, t]);
  const composerPlaceholderScenarios = useMemo<PlaceholderScenario[]>(() => {
    if (loading || initialDraft?.trim()) return [];
    if (displayMessages.length === 0 && queuedItems.length === 0) return blankProjectComposerScenarios;
    if (displayMessages.length > 0) return followUpComposerScenarios;
    return [];
  }, [
    blankProjectComposerScenarios,
    displayMessages.length,
    followUpComposerScenarios,
    initialDraft,
    loading,
    queuedItems.length,
  ]);
  const [tab, setTab] = useState<Tab>('chat');
  const [showConvList, setShowConvList] = useState(false);
  const [conversationSearch, setConversationSearch] = useState('');
  const deferredConversationSearch = useDeferredValue(conversationSearch);
  const [scrolledFromBottom, setScrolledFromBottom] = useState(false);
  // SDF liquid-glass refraction on the jump pill (frosted fallback via CSS).
  const jumpBtnGlassRef = useLiquidGlass<HTMLButtonElement>({ strength: 0.2 });
  const [chatLogScrollable, setChatLogScrollable] = useState(false);
  const [chatLogScrolling, setChatLogScrolling] = useState(false);
  const [composerPortalTarget, setComposerPortalTarget] = useState<HTMLElement | null>(null);
  const [composerPortalRect, setComposerPortalRect] = useState<{
    left: number;
    width: number;
    bottom: number;
  } | null>(null);
  const [composerSlotHeight, setComposerSlotHeight] = useState(0);
  const [editingQueuedSendId, setEditingQueuedSendId] = useState<string | null>(null);
  // Reverse scan (no array copy) + memo so this and the maps below don't
  // recompute on every non-`messages` render (scroll, hover, toggles).
  const lastAssistantId = useMemo(() => {
    for (let i = displayMessages.length - 1; i >= 0; i--) {
      if (displayMessages[i]!.role === 'assistant') return displayMessages[i]!.id;
    }
    return undefined;
  }, [displayMessages]);
  const hasActiveRunMessage = displayMessages.some(
    (m) => m.role === 'assistant' && isActiveRunStatus(m.runStatus),
  );
  /*
   * 输入框上方那枚「第 N / M 步」药丸的两个输入。
   *
   * 药丸**不属于某一条消息**,所以它要的是「整个会话里最新的那一份清单」——
   * 沿用会话级的那条既有链路(`latestTodoWriteInputFromMessages` → `parseTodoWriteInput`),
   * 不另起一套发现逻辑;这样它和执行记录里那份分段读的是同一个 TodoWrite 快照。
   *
   * 「还在跑吗」照抄 `shouldBalanceFinishedTranscript` 的那对判据:`streaming` 是本地
   * 流式旗标,`hasActiveRunMessage` 兜住刷新后 run 仍在跑的那一路(此时没有本地流)。
   */
  const planPillTodos = useMemo(
    () => parseTodoWriteInput(latestTodoWriteInputFromMessages(displayMessages)),
    [displayMessages],
  );
  const planPillRunning = streaming || hasActiveRunMessage;
  const planPillVisible = planPillState(planPillTodos, planPillRunning) !== null;
  const showJumpToLatest = scrolledFromBottom && !planPillVisible;
  const retryAssistant = retryableAssistantMessage(displayMessages, lastAssistantId, streaming);
  // The failed run's error event lives on the (persisted) assistant message, so
  // the error card + AMR card survive a reload — unlike the ephemeral global
  // `error` state. Drive both off this event.
  const failedRunErrorEvent = (() => {
    const evs = retryAssistant?.events ?? [];
    for (let i = evs.length - 1; i >= 0; i--) {
      const ev = evs[i];
      if (ev?.kind === 'status' && ev.label === 'error') return ev;
    }
    return null;
  })();
  // Per-case failure UI (button + copy + whether to promote AMR). Only
  // meaningful for a failed run (retryAssistant present).
  const runFailureUi = retryAssistant
    ? resolveRunFailureUi(
        failedRunErrorEvent?.code,
        failedRunErrorEvent?.failureDetail,
        retryAssistant.agentId,
        // The raw upstream sentence, so a failure whose copy names something the
        // gateway reported (the instant a model window reopens) can read it back
        // out. Same string the card renders under 「查看详情」.
        failedRunErrorEvent?.detail,
      )
    : null;
  const hasInlineAmrAuthorizeFailure = Boolean(
    retryAssistant && onRetry && runFailureUi?.primaryAction === 'authorize',
  );
  useEffect(() => {
    if (
      !amrAuthRetryContinuation
      || !onDiscardAmrAuthRetryContinuation
      || loading
      || !projectId
      || !activeConversationId
      || messagesConversationId !== activeConversationId
    ) {
      return;
    }
    const personalAdoptionAuthorityTransition =
      amrAuthRetryContinuation.workspaceIdentityKey === 'none'
      && amrAuthRetryContinuation.originMountId === amrAuthRetryMountId
      && amrAuthRetryPersonalAdoptionWitness?.workspaceIdentityKey
        === amrAuthRetryWorkspaceIdentityKey;
    const mismatched =
      amrAuthRetryContinuation.projectId !== projectId
      || amrAuthRetryContinuation.conversationId !== activeConversationId
      || amrAuthRetryContinuation.assistantId !== retryAssistant?.id
      || (
        amrAuthRetryWorkspaceIdentityKey !== undefined
        && amrAuthRetryContinuation.workspaceIdentityKey
          !== amrAuthRetryWorkspaceIdentityKey
        && !personalAdoptionAuthorityTransition
      );
    if (mismatched) {
      onDiscardAmrAuthRetryContinuation(amrAuthRetryContinuation);
    }
  }, [
    activeConversationId,
    amrAuthRetryContinuation,
    amrAuthRetryMountId,
    amrAuthRetryPersonalAdoptionWitness,
    amrAuthRetryWorkspaceIdentityKey,
    loading,
    messagesConversationId,
    onDiscardAmrAuthRetryContinuation,
    projectId,
    retryAssistant?.id,
  ]);
  const consumeAmrAuthRetryIfAuthorized = useCallback((status: VelaLoginStatus | null) => {
    if (!isAmrSessionAuthenticated(status)) {
      if (
        status?.loginInFlight === true
        && amrAuthRetryContinuation
        && amrAuthRetryContinuation.workspaceIdentityKey === 'none'
        && amrAuthRetryContinuation.originMountId === amrAuthRetryMountId
      ) {
        amrAuthRetrySignedOutWitnessRef.current = amrAuthRetryContinuation;
      }
      return;
    }
    if (
      !isAmrSessionAuthenticated(status)
      || !amrAuthRetryContinuation
      || !amrAuthRetryMountId
      || !amrAuthRetryWorkspaceIdentityKey
      || !projectId
      || !activeConversationId
      || !retryAssistant
      || !onRetry
      || !onConsumeAmrAuthRetryContinuation
    ) {
      return;
    }
    const originMountObservedSignedOut =
      amrAuthRetrySignedOutWitnessRef.current === amrAuthRetryContinuation;
    // Every continuation is consumed against the account identity returned by
    // this exact status observation. An ambient shell snapshot can belong to a
    // prior account during sign-out/sign-in transitions.
    const loggedInAccountId = status?.user?.id ?? null;
    if (!canConsumeAmrAuthRetryContinuation(amrAuthRetryContinuation, {
      projectId,
      conversationId: activeConversationId,
      assistantId: retryAssistant.id,
      workspaceIdentityKey: amrAuthRetryWorkspaceIdentityKey,
      mountId: amrAuthRetryMountId,
      loggedInAccountId,
      nowMs: Date.now(),
      originMountObservedSignedOut,
      personalAdoptionWitness: amrAuthRetryPersonalAdoptionWitness,
    })) {
      return;
    }
    if (onConsumeAmrAuthRetryContinuation(amrAuthRetryContinuation)) {
      amrAuthRetrySignedOutWitnessRef.current = null;
      onRetry(
        retryAssistant,
        retryAssistant.agentId === 'amr'
          ? 'authorize_and_retry'
          : 'switch_runtime_retry',
      );
    }
  }, [
    activeConversationId,
    amrAuthRetryContinuation,
    amrAuthRetryMountId,
    amrAuthRetryPersonalAdoptionWitness,
    amrAuthRetryWorkspaceIdentityKey,
    onConsumeAmrAuthRetryContinuation,
    onRetry,
    projectId,
    retryAssistant,
  ]);
  useEffect(() => {
    if (!amrAuthRetryContinuation || !isAmrSessionAuthenticated(inlineAmrLoginStatus)) return;
    // A Settings handoff remounts the whole project surface, so there is no
    // inline AmrLoginPill callback to drive consumption. The fresh pane's own
    // status read may request the one-shot retry; the common guard above still
    // requires the exact project, conversation, failed assistant, account,
    // fresh mount and Workspace authority.
    consumeAmrAuthRetryIfAuthorized(inlineAmrLoginStatus);
  }, [
    amrAuthRetryContinuation,
    consumeAmrAuthRetryIfAuthorized,
    inlineAmrLoginStatus,
  ]);
  useEffect(() => {
    if (
      amrAuthRetrySignedOutWitnessRef.current
      && amrAuthRetrySignedOutWitnessRef.current !== amrAuthRetryContinuation
    ) {
      amrAuthRetrySignedOutWitnessRef.current = null;
    }
  }, [amrAuthRetryContinuation]);
  useEffect(() => {
    if (!hasInlineAmrAuthorizeFailure || !retryAssistant || !onRetry) return;
    let stopped = false;
    const retryIfSignedIn = async () => {
      const next = await refreshInlineAmrLoginStatus();
      if (stopped) return;
      consumeAmrAuthRetryIfAuthorized(next);
    };
    void retryIfSignedIn();
    const interval = window.setInterval(() => {
      void retryIfSignedIn();
    }, 500);
    return () => {
      stopped = true;
      window.clearInterval(interval);
    };
  }, [
    consumeAmrAuthRetryIfAuthorized,
    hasInlineAmrAuthorizeFailure,
    onRetry,
    refreshInlineAmrLoginStatus,
    retryAssistant,
  ]);
  // Offer Continue (resume) when the failed run is resumable AND the active
  // agent still matches the agent that produced it. The daemon stores a
  // resumable session per (conversation, agent); after an agent switch the new
  // agent has no id for that session, so a resume would silently start fresh —
  // fall back to the from-scratch Retry instead. We do NOT require `onResumeRun`
  // here: because the daemon persists the resumable session, the plain Retry
  // path (which re-sends the original prompt) would itself silently resume that
  // session and double the work. So every ChatPane surface must offer Continue
  // for a resumable failure — `onResumeRun` when wired (primary chat, carries
  // the resume_continue analytics), otherwise a plain `onSend` of the canonical
  // continue prompt (resumes the session without re-sending the original turn).
  const canResumeFailedRun =
    !!retryAssistant?.resumable &&
    !!retryAssistant?.agentId &&
    retryAssistant.agentId === config?.agentId;
  // `error` is a shared escape hatch for both run failures and unrelated pane
  // errors. A run error also lives durably on its assistant message. Suppress
  // it only when its exact source assistant owns the persisted diagnostic and
  // a later assistant has succeeded; canonical error text alone cannot prove
  // ownership because a new run can fail with the same detail.
  const historicalRunError = useMemo(
    () =>
      !retryAssistant &&
      isRecoveredAssistantRunError(
        displayMessages,
        error,
        errorSourceAssistantId,
      ),
    [displayMessages, error, errorSourceAssistantId, retryAssistant],
  );
  const currentGlobalError = historicalRunError ? null : error;
  // Prefer a case-specific message (AMR auth / balance) over the raw upstream
  // string; otherwise keep a current pane-level error ahead of the persisted
  // failed-run detail. Historical run errors were already removed above.
  const rawError = currentGlobalError ?? failedRunErrorEvent?.detail ?? null;
  // Friendly agent name for {agent} interpolation in failure copy (e.g. the
  // sign-in messages). Falls back to a neutral word when unreadable, never null.
  const failedAgentLabel =
    agentDisplayName(retryAssistant?.agentId, retryAssistant?.agentName) ??
    t('chat.runError.agentFallback');
  // Values the failure copy names, localized before interpolation: the gateway
  // reports a UTC instant, the reader waits on their own clock.
  const runFailureMessageVars = runFailureUi?.messageVars?.retryAt
    ? {
        ...runFailureUi.messageVars,
        retryAt: formatModelWindowRetryAt(runFailureUi.messageVars.retryAt, locale),
      }
    : runFailureUi?.messageVars;
  // 卡面上只放人话。命中映射表的用它自己的文案;没命中的用兜底那一句 ——
  // **不再把上游原文摊在卡上**(设计原则五)。卡上也不再收着它:曾经那个
  // 「错误详情」折叠已经整块下线(用户 2026-08-27),要原始日志走〔导出日志〕。
  //
  // 兜底只接手**这一轮自己的原始报错**。两个条件缺一不可:
  //  · `runFailureUi` —— 这条助手消息确实是终态失败,不然凭空多出一张卡;
  //  · 面板级那条错误不是**这一轮自己填的** —— 面板错误(会话加载失败之类)本来就是
  //    我们自己写的人话,而且优先级更高(见上面 `rawError` 的取值顺序)。少了这一条,
  //    「一边是面板错误、一边有条失败的旧运行」时,那句人话会被兜底句顶掉。
  //
  //    判据不能是「面板里有没有错误」:面板那个槽是**共用**的,运行失败自己也会
  //    往里填(`setRunError(err.message, assistantId)`,ProjectView 三处)。按
  //    「有没有」判,这一轮自己的上游原文就正好绕过兜底,从最后那条 `: rawError`
  //    漏到卡面上 —— 用户 2026-08-27 看到的那串 JSON-RPC 走的就是这条路。
  //
  //    真正的判据是**谁填的**:`setRunError` 带 `sourceAssistantId`,`setError`
  //    一律置 null。所以「来源就是这条失败的助手消息」= 那段字是这一轮的上游原文,
  //    该由兜底句接手;来源为空或指向别的助手,那句话跟这一轮无关,原样留着。
  //
  // R9:断线是唯一一条**整张卡都不出**的 —— 流水最后一行的重连行(第 84 格 ·
  // S29)已经在说同一件事,而且给的是对的那颗按钮〔重新连接〕。两块 UI 说一件事、
  // 还是两种说法,正是设计稿要避免的。判据两条线索都看:结构化的 code,和这条码
  // 引入之前落库的原文 —— 跟 `ProjectView.hasGenericDisconnectFailureEvent` 同一对。
  // 面板级的那条错误(还没落到消息上)也要过这一道,否则重连行在场时它照样冒出来。
  const reconnectOwnsFailure =
    runFailureUi?.suppressCard === true
    || isReconnectOwnedFailure(failedRunErrorEvent?.code, rawError);
  // 面板里那段字是不是**这一轮自己**的上游原文。见上面兜底那两条件的说明。
  const globalErrorIsThisRunsRawText =
    !!currentGlobalError
    && errorSourceAssistantId != null
    && errorSourceAssistantId === retryAssistant?.id;
  const displayError = reconnectOwnsFailure
    ? null
    : runFailureUi?.messageKey
      ? t(runFailureUi.messageKey, { agent: failedAgentLabel, ...runFailureMessageVars })
      : runFailureUi && (!currentGlobalError || globalErrorIsThisRunsRawText) && rawError
        ? t(RUN_FAILURE_FALLBACK_MESSAGE_KEY)
        : rawError;
  // Brand (accent) for AMR sign-in/top-up, warning for a self-healing
  // connection drop, danger for everything else. The shared action card only
  // tints its icon; the surface itself stays neutral.
  const runErrorTone: UserActionCardTone =
    runFailureUi?.primaryAction === 'authorize' ||
    runFailureUi?.primaryAction === 'recharge' ||
    runFailureUi?.primaryAction === 'upgrade'
      ? 'brand'
      : failedRunErrorEvent?.code === 'AGENT_CONNECTION_DROPPED'
        ? 'warning'
        : 'danger';
  // 阶梯第 4 档的唯一外显:常驻次级的〔联系支持〕升格成主按钮。
  const contactSupportIsPrimary = runFailureUi?.primaryAction === 'contact-support';
  // The failed run whose error this top-level card represents. AssistantMessage
  // suppresses only THIS message's per-message error pill (to avoid the
  // duplicate); other failed turns — older history, or once a follow-up makes
  // this no longer the last assistant — keep their pill so the error survives.
  const errorCardOwnerId =
    retryAssistant && failedRunErrorEvent ? retryAssistant.id : null;
  // AMR promotion card payload (only the non-AMR model/auth/quota case).
  const amrSwitchPayload =
    runFailureUi?.showSwitchCard
    && failedRunErrorEvent?.code !== 'UPSTREAM_UNAVAILABLE'
    && retryAssistant
    && failedRunErrorEvent?.code
      ? {
          errorCode: failedRunErrorEvent.code,
          projectId: projectId ?? '',
          projectKind: projectKindForTracking,
          conversationId: activeConversationId,
          assistantMessageId: retryAssistant.id,
          runId: retryAssistant.runId ?? null,
        }
      : null;
  // 阶梯第 3 / 4 档的卡自己画不出「能把这次失败推进下去」的按钮:第 3 档那颗
  // 在下面那张切换卡上,第 4 档给的是〔联系支持〕(开对话,不是恢复)。判据抽成
  // `hasSelfContainedRecovery`,免得这里跟着阶梯的档位一档档手写。
  const runFailureHasAction = Boolean(
    retryAssistant &&
      onRetry &&
      runFailureUi &&
      (hasSelfContainedRecovery(runFailureUi) || canResumeFailedRun),
  );
  // The generic local-CLI escape hatch is only used when the failure card has
  // no direct recovery action. AMR guidance remains visible whenever the
  // classifier asks for it, alongside a case-specific retry when applicable.
  const showByokRecoveryCta =
    showByokRecoveryAction && Boolean(onSwitchToLocalCli) && !runFailureHasAction;
  const showErrorActions = showByokRecoveryCta || runFailureHasAction;
  const showAmrGuidance = Boolean(amrSwitchPayload);
  /**
   * 报错卡上那两颗**常驻**次级(交付稿第 78 格的前两颗)。
   *
   * 它们和 `showErrorActions` 无关 —— 那个旗标问的是「这一档有没有可用的恢复动作」,
   * 而「联系支持」「导出日志」在任何一档都成立:恰恰是**没有恢复动作**的那几档
   * (CPU 不支持、运行时定义非法)最需要它们,今天那些卡上一颗按钮都没有。
   */
  const [supportDialogOpen, setSupportDialogOpen] = useState(false);
  /**
   * 升级卡与报错卡上的「升级套餐」共用一条出站链路:同一个 plans URL、同一份归因、
   * 同样的 device id 传递规则(仅在同意指标上报时带)。入口来源分开记,
   * 这样漏斗能读出「卡」和「弹窗」各自带来多少升级。
   */
  const openAmrPlans = useCallback((entrySource: 'chat_error_upgrade' | 'chat_upgrade_card') => {
    const attribution = recordAmrEntry(analytics.track, entrySource, new Date(), {
      metricsConsent: config?.telemetry?.metrics === true,
    });
    const deviceId = amrHandoffDeviceId({
      metricsConsent: config?.telemetry?.metrics === true,
      resolvedDeviceId: getResolvedDeviceId(),
      installationId: config?.installationId,
    });
    window.open(
      attributedAmrUrl(amrPlansUrlForProfile(amrProfile), attribution, deviceId),
      '_blank',
      'noopener,noreferrer',
    );
  }, [amrProfile, analytics.track, config?.installationId, config?.telemetry?.metrics]);
  const visibleRecoveryActionTypes = useMemo(() => {
    const actions: TrackingRunRecoveryActionType[] = [];
    if (!retryAssistant || !onRetry || !runFailureUi) return actions;
    if (runFailureUi.primaryAction === 'authorize') actions.push('authorize_and_retry');
    if (runFailureUi.primaryAction === 'switch-model') actions.push('switch_model_retry');
    if (canResumeFailedRun) actions.push('resume_run');
    else if (runFailureUi.primaryAction === 'retry' || runFailureUi.secondaryRetry) {
      actions.push('manual_retry');
    }
    if (showAmrGuidance && onSwitchToAmrAndRetry) actions.push('switch_runtime_retry');
    return actions;
  }, [
    canResumeFailedRun,
    onRetry,
    onSwitchToAmrAndRetry,
    retryAssistant,
    runFailureUi,
    showAmrGuidance,
  ]);
  const recoveryAnalyticsProps = useCallback((
    assistantMessage: ChatMessage,
    actionType: TrackingRunRecoveryActionType,
  ) => {
    const task = buildRecoveryTaskAnalytics(displayMessages, assistantMessage, actionType);
    return {
      task_execution_id: task.taskExecutionId,
      recovery_action_instance_id: task.recoveryActionInstanceId!,
      recovery_action_type: actionType,
      ...(task.sourceRunId ? { source_run_id: task.sourceRunId } : {}),
      ...(assistantMessage.agentId
        ? { source_agent_provider_id: runAgentProviderId(assistantMessage.agentId) }
        : {}),
      ...(failedRunErrorEvent?.failureCategory
        ? { failure_category: failedRunErrorEvent.failureCategory }
        : {}),
      ...(failedRunErrorEvent?.failureDetail
        ? { failure_reason: failedRunErrorEvent.failureDetail }
        : {}),
    };
  }, [displayMessages, failedRunErrorEvent]);
  useEffect(() => {
    if (!retryAssistant) return;
    for (const actionType of visibleRecoveryActionTypes) {
      const props = recoveryAnalyticsProps(retryAssistant, actionType);
      const key = `${props.recovery_action_instance_id}:surface`;
      if (runRecoverySurfaceKeysRef.current.has(key)) continue;
      runRecoverySurfaceKeysRef.current.add(key);
      trackRunRecoveryActionSurfaceView(analytics.track, {
        page_name: 'chat_panel',
        area: 'chat_panel',
        element: 'run_recovery_action',
        ...props,
      });
    }
  }, [analytics.track, recoveryAnalyticsProps, retryAssistant, visibleRecoveryActionTypes]);
  const trackRecoveryClick = useCallback((
    assistantMessage: ChatMessage,
    actionType: TrackingRunRecoveryActionType,
    target?: { agentProviderId?: string; modelId?: string },
  ) => {
    trackRunRecoveryActionClick(analytics.track, {
      page_name: 'chat_panel',
      area: 'chat_panel',
      element: 'run_recovery_action',
      ...recoveryAnalyticsProps(assistantMessage, actionType),
      ...(target?.agentProviderId
        ? { target_agent_provider_id: target.agentProviderId }
        : {}),
      ...(target?.modelId ? { target_model_id: target.modelId } : {}),
    });
  }, [analytics.track, recoveryAnalyticsProps]);
  useEffect(() => {
    if (!displayError || !failedRunErrorEvent?.code || !retryAssistant) return;
    // The hosted-AMR nudge owns this same surface_view when it renders below
    // the error card. For all other failed-run guidance (AMR auth/balance,
    // Antigravity auth/quota, upstream outage, generic retry), the chat error
    // card itself is the visible run_failed_toast surface.
    if (showAmrGuidance) return;

    const key = [
      projectId ?? '',
      activeConversationId ?? '',
      retryAssistant.id,
      retryAssistant.runId ?? '',
      failedRunErrorEvent.code,
    ].join(':');
    if (runFailedToastSurfaceKeysRef.current.has(key)) return;
    runFailedToastSurfaceKeysRef.current.add(key);

    trackRunFailedToastSurfaceView(analytics.track, {
      page_name: 'chat_panel',
      area: 'chat_panel',
      element: 'run_failed_toast',
      error_code: failedRunErrorEvent.code,
      project_id: projectId ?? '',
      project_kind: projectKindForTracking,
      conversation_id: activeConversationId,
      assistant_message_id: retryAssistant.id,
      run_id: retryAssistant.runId ?? null,
    });
  }, [
    activeConversationId,
    analytics.track,
    showAmrGuidance,
    displayError,
    failedRunErrorEvent?.code,
    projectId,
    projectKindForTracking,
    retryAssistant,
  ]);
  const importedFolderArtifacts = useMemo(
    () =>
      projectMetadata?.importedFrom === 'folder'
        ? sortArtifactsByModified(
            listDesignArtifactCandidates(projectFiles, projectMetadata.entryFile),
          )
        : [],
    [projectFiles, projectMetadata?.entryFile, projectMetadata?.importedFrom],
  );
  const showImportedFolderArtifacts = projectMetadata?.importedFrom === 'folder';
  const composerDraftStorageKey = projectId && activeConversationId
    ? `od:chat-composer:draft:${projectId}:${activeConversationId}`
    : undefined;
  const shouldBalanceFinishedTranscript =
    !loading &&
    !streaming &&
    !displayError &&
    !hasActiveRunMessage &&
    displayMessages.length > 0;
  // Map each assistant message id to the user message that follows it (if any)
  // so structured form replies collapse into a readable summary on the
  // assistant message that asked them.
  const nextUserContentByAssistantId = useMemo(() => {
    const map = new Map<string, string>();
    for (let i = 0; i < displayMessages.length - 1; i++) {
      const m = displayMessages[i]!;
      const next = displayMessages[i + 1]!;
      if (m.role === 'assistant' && next.role === 'user') {
        map.set(m.id, next.content);
      }
    }
    return map;
  }, [displayMessages]);

  useEffect(() => {
    didInitialScrollRef.current = false;
    anchorPendingRef.current = false;
    anchorActiveRef.current = false;
    prevLastUserIdRef.current = undefined;
    resetTailSpacer();
    // A new conversation should land at the bottom (its own initial
    // scroll), not inherit the previous conversation's saved position —
    // including any anchor-to-top reserve still held by the tail spacer, which
    // would otherwise strand the freshly opened conversation below a dead gap.
    savedChatScrollRef.current = null;
    scrolledToFormRef.current = new Set();
    anchorActiveRef.current = false;
    anchorPendingRef.current = false;
    resetTailSpacer();
    /*
     * 跟随意图也归位。它是**上一条会话**的阅读状态:在长会话里滚上去挣脱过,
     * 切到另一条会话时那份「已挣脱」不该跟着走 —— 老写法里它跟着走了,于是浮标
     * 挂在一条一屏都装得下的新会话上。
     */
    armFollow();
    lastScrollSampleRef.current = { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
  }, [activeConversationId]);

  // ChatComposer's internal `seededRef` latches after the first
  // non-empty `initialDraft`, so a parent setting `initialDraft` back
  // to `undefined` will not flow into the composer's draft state. When
  // the parent does that transition (because the seed is now stale —
  // e.g. ProjectView discovered the conversation already has a sent
  // user message after a reload), reach into the composer and clear
  // the textarea so the user does not see the prompt they already
  // submitted.
  const lastSeenInitialDraftRef = useRef<string | undefined>(initialDraft);
  useEffect(() => {
    const previous = lastSeenInitialDraftRef.current;
    lastSeenInitialDraftRef.current = initialDraft;
    if (previous && initialDraft === undefined) {
      composerRef.current?.setDraft('');
    }
  }, [initialDraft]);

  // Parent-driven composer prefill (the "Import repo" CTA). Reuse the same
  // imperative setDraft the starter cards use; the nonce guards against
  // re-applying the same signal on unrelated re-renders.
  const lastDraftSignalNonceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!composerDraftSignal) return;
    if (lastDraftSignalNonceRef.current === composerDraftSignal.nonce) return;
    lastDraftSignalNonceRef.current = composerDraftSignal.nonce;
    composerRef.current?.setDraft(composerDraftSignal.text);
  }, [composerDraftSignal]);

  // Library "optimize design system" hand-off: when the user pushed selected
  // assets into this project's design system from the Library, pre-fill the
  // composer with the query + those assets (as attachment chips) so they only
  // need to review and Send. Fires once, after the composer mounts for the
  // routed conversation; re-checks on conversation change so an async-loaded
  // composer still gets seeded. The seed is consumed (cleared) on apply.
  const seededComposerSeedRef = useRef(false);
  useEffect(() => {
    if (seededComposerSeedRef.current) return;
    if (!projectId || !composerRef.current) return;
    const seed = takeComposerSeedFor(projectId);
    if (!seed) return;
    seededComposerSeedRef.current = true;
    composerRef.current.restoreDraft({ text: seed.text, attachments: seed.attachments });
  }, [projectId, activeConversationId]);

  useEffect(() => {
    if (!editingQueuedSendId) return;
    if (queuedItems.some((item) => item.id === editingQueuedSendId)) return;
    setEditingQueuedSendId(null);
  }, [editingQueuedSendId, queuedItems]);

  /**
   * "Edit" on a queued row means TAKE THE TURN OUT of the queue and put it
   * back into the composer with its whole payload — text, attachments, marks,
   * and the staged plugin / skill / MCP / connector / context bindings in its
   * meta. Leaving the row behind showed the same turn in two places at once,
   * which reads as "sending now will send it twice".
   *
   * Product ruling (2026-08, provisional): when the composer already holds an
   * unsent draft it is OVERWRITTEN. Not merged, not guarded by a confirm
   * dialog, not refused. Do not "helpfully" turn this back into a merge.
   *
   * Dequeuing needs a host that owns the queue. When there is no
   * `onRemoveQueuedSend` we keep the older in-place edit instead (the row
   * stays, marked as editing, and Send updates it) — pulling the turn into the
   * composer with no way to put it back would lose it outright.
   */
  const restoreQueuedSendToComposer = (item: QueuedSendItem) => {
    setEditingQueuedSendId(onRemoveQueuedSend ? null : item.id);
    onRemoveQueuedSend?.(item.id);
    composerRef.current?.restoreDraft({
      text: item.prompt,
      attachments: item.attachments ?? [],
      commentAttachments: item.commentAttachments ?? [],
      // 排队时折进正文的那段引文,靠这份结构数据拆回芯片。老队列里没有这个
      // 字段(它是后加的),那就退回「整段都是正文」——不报错,只是没有芯片。
      quotes: item.meta?.quotes ?? [],
      meta: item.meta,
    });
  };

  useEffect(() => {
    const el = logRef.current;
    if (!el || didInitialScrollRef.current || displayMessages.length === 0) return;
    didInitialScrollRef.current = true;
    requestAnimationFrame(() => {
      // If the last assistant message contains a question form, scroll to
      // the form instead of the bottom, so the user sees the form first.
      const lastAssistantMsg = [...displayMessages].reverse().find((m) => m.role === 'assistant');
      if (lastAssistantMsg?.content.includes('<question-form')) {
        const assistantEls = el.querySelectorAll('.msg.assistant');
        const lastAssistantEl = assistantEls[assistantEls.length - 1];
        const formEl = lastAssistantEl?.querySelector<HTMLElement>('[data-form-id]');
        if (formEl && !scrolledToFormRef.current.has(formEl.dataset.formId!)) {
          scrolledToFormRef.current.add(formEl.dataset.formId!);
          const distance = distanceFromBottomAfterAligningTop(el, formEl);
          // This is initial positioning, not a user-facing animated action.
          // Smooth scrolling emits intermediate scroll events after we have
          // predicted the destination, which makes those frames look like
          // user input and can rearm/escape follow incorrectly.
          formEl.scrollIntoView({ block: 'start', behavior: 'auto' });
          settleFollowAfterPredictedScroll(el, distance);
          return;
        }
        // Already handled by the auto-scroll effect — don't bottom-scroll.
        if (formEl) return;
      }
      // Initial-load bottom-pin must be instant — smooth scrollTo emits
      // intermediate scroll events that read as a user scroll and break follow.
      armFollow();
      writeLogScrollTop(el, el.scrollHeight);
      syncFollowState();
    });
    // `tab` is in the deps so that switching conversations while
    // Comments is open doesn't strand the new conversation at scrollTop:
    // 0. The activeConversationId-reset effect above clears
    // didInitialScrollRef while the chat-log is unmounted; this effect
    // then re-runs when the user returns to Chat and the element is
    // available, scrolling the new conversation to its initial bottom.
  }, [activeConversationId, displayMessages, tab]);

  // When a turn finishes streaming, release the anchor-to-top reserve. The
  // tail spacer only exists to give a streaming reply room to grow while the
  // user message stays pinned at the top; once the reply is final it must not
  // linger, or a short turn (typical of a fresh fork) is left with a large
  // dead gap below it. Collapsing the spacer lets the bottom-anchored layout
  // settle the finished transcript against the composer.
  useEffect(() => {
    const was = prevStreamingRef.current;
    prevStreamingRef.current = streaming;
    // The tail spacer only ever holds the anchor-to-top reserve for an actively
    // streaming reply, so once the turn ends it must collapse unconditionally —
    // even if a mid-turn scroll already cleared `anchorActiveRef` (which leaves
    // the spacer sized). Collapsing it lets the bottom-anchored layout settle a
    // finished short turn against the composer instead of below a dead gap.
    if (was && !streaming) {
      anchorActiveRef.current = false;
      resetTailSpacer();
    }
  }, [streaming]);

  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    // Auto-scroll only when the user was already pinned near the bottom,
    // so a scrollback session reading earlier output isn't yanked to the
    // latest message. We key off the pre-content follow intent
    // (a ref so it doesn't itself re-fire this effect on scroll) instead
    // of recomputing distance from the just-grown scrollHeight: a single
    // streamed chunk can add 100+ px in one render, which made the
    // post-content distance check skip auto-scroll even when the user
    // was glued to the bottom. We deliberately use the tighter 80px
    // cutoff tracked by the ref (not the wider 120px jump-button
    // threshold) so a deliberate ~90px scroll-up isn't snapped back the
    // next time content streams in. Issue #983.

    // A brand-new user turn from a local send: switch to "anchor to top"
    // mode and smooth-scroll their message to the top of the viewport.
    const lastUser = [...displayMessages].reverse().find((m) => m.role === 'user');
    const prevUserId = prevLastUserIdRef.current;
    prevLastUserIdRef.current = lastUser?.id;
    if (anchorPendingRef.current && lastUser && lastUser.id !== prevUserId) {
      anchorPendingRef.current = false;
      resetTailSpacer();
      anchorActiveRef.current = true;
      /*
       * anchor-to-top 接管 = 用户这一轮的阅读位置在**顶端**,不是底部。松开跟随,
       * 这样回合结束、占位块收掉之后,一段长回复不会突然被拽到最底下。
       * (短回合会在 `syncFollowState` 里因为「本来就贴着底」自动重新挂上。)
       */
      releaseFollow();
      /*
       * 浮标**不在这里点亮**。老写法在这里无条件 `setScrolledFromBottom(true)`,
       * 而这一刻底下压根没有东西可回:占位块马上会把空白撑到「这条用户消息刚好顶到
       * 视口顶端」,也就是**正正好在底部**。用户截图里那颗压在输入框上的浮标就是这么来的。
       * 现在交给 `syncFollowState` 按几何算 —— 预留空白已经被扣掉了。
       */
      requestAnimationFrame(() => {
        sizeAnchorSpacer();
        scrollAnchorToTop();
        /*
         * 占位块刚定完尺寸、视图刚落到 anchor 位置 —— 几何整个换了,必须重算一次。
         *
         * 上一拍(React effect 里)量到的是**旧**几何:占位块还是 0、视图还停在
         * 旧内容的底部。一轮的用户消息 + 「进行中」头如果一次撑出大半屏,那一拍
         * 就会算出「底下还有一大截」并把浮标点亮 —— 而这一帧过后底下只剩十几个像素。
         *
         * 子树变动那条路(`scheduleFollowSync`)也会重算,但两条都排 rAF、谁后跑
         * 没有保证;只有这一帧是确定跑在 `scrollAnchorToTop()` **之后**的。
         */
        syncFollowState();
      });
      return;
    }
    // While anchored, the message stays at the top on its own (nothing above
    // it changes), so we only shrink the spacer as the reply grows — never
    // re-scroll. This is what keeps scrolling down and the final settle smooth.
    if (anchorActiveRef.current) {
      requestAnimationFrame(() => {
        sizeAnchorSpacer();
        syncFollowState();
      });
      return;
    }

    if (isFollowingTail()) {
      // If the last assistant message contains a question form, scroll to
      // the form instead of the bottom, so the user lands on the form.
      const lastAssistantMsg = [...displayMessages].reverse().find((m) => m.role === 'assistant');
      if (lastAssistantMsg?.content.includes('<question-form')) {
        const assistantEls = el.querySelectorAll('.msg.assistant');
        const lastAssistantEl = assistantEls[assistantEls.length - 1];
        const formEl = lastAssistantEl?.querySelector<HTMLElement>('[data-form-id]');
        if (formEl && !scrolledToFormRef.current.has(formEl.dataset.formId!)) {
          scrolledToFormRef.current.add(formEl.dataset.formId!);
          const distance = distanceFromBottomAfterAligningTop(el, formEl);
          formEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
          settleFollowAfterPredictedScroll(el, distance);
          return;
        }
        // Form tag in content but the DOM element isn't ready yet (partial
        // stream) — skip bottom-scroll to avoid a jarring jump that gets
        // undone when the form finishes rendering.
        if (streaming) return;
      }
      // Streaming bottom-pin must be instant — smooth scrollTo emits
      // intermediate scroll events that read as a user scroll and break
      // auto-follow for subsequent chunks.
      writeLogScrollTop(el, el.scrollHeight);
    }
    syncFollowState();
  }, [displayMessages, error, streaming]);

  // Saved chat-log scroll state, preserved across tab switches. The
  // chat-log <div> is conditionally rendered so it unmounts when the
  // user switches to Comments. On remount it would default to
  // scrollTop: 0 and the initial-bottom-scroll effect skips because
  // didInitialScrollRef is already true. We capture either the absolute
  // scrollTop or a "pinned to bottom" flag while Chat is visible, so
  // bottom-followers stay pinned even when new messages stream in
  // off-tab. Issue #790.
  const savedChatScrollRef = useRef<
    { pinnedToBottom: true } | { pinnedToBottom: false; scrollTop: number } | null
  >(null);
  useEffect(() => {
    if (tab !== 'chat') return;
    const el = logRef.current;
    if (!el) return;

    function syncScrollable(target: HTMLDivElement) {
      const next = target.scrollHeight - target.clientHeight > 1;
      setChatLogScrollable((prev) => (prev === next ? prev : next));
      if (!next) setChatLogScrolling(false);
    }

    function markScrolling() {
      setChatLogScrolling(true);
      if (chatLogScrollIdleTimerRef.current !== null) {
        window.clearTimeout(chatLogScrollIdleTimerRef.current);
      }
      chatLogScrollIdleTimerRef.current = window.setTimeout(() => {
        chatLogScrollIdleTimerRef.current = null;
        setChatLogScrolling(false);
      }, 650);
    }

    // Restore previously-saved position on remount. Defer to the next
    // frame so the conditional <> contents finish layout before the
    // scrollTop write lands.
    const saved = savedChatScrollRef.current;
    if (saved !== null) {
      requestAnimationFrame(() => {
        const target = logRef.current;
        if (!target) return;
        if (saved.pinnedToBottom) {
          armFollow();
          writeLogScrollTop(target, target.scrollHeight);
        } else {
          releaseFollow();
          writeLogScrollTop(target, saved.scrollTop);
        }
        syncScrollable(target);
        // Resync the jump-to-latest affordance with the restored position.
        // Without this, a user who left Chat ~60px from the bottom and returns
        // to find new messages stacked underneath would land hundreds of pixels
        // above the latest turn while the pill stayed hidden until they scrolled.
        syncFollowState();
      });
    }

    function snapshot(target: HTMLDivElement) {
      // 存**意图**而不是「离底部够近吗」:用户离开 Chat 时如果正在跟随,回来就该
      // 还在跟随;如果他停在某个位置读东西,回来就该还在那个位置。
      savedChatScrollRef.current = followIntentRef.current.following
        ? { pinnedToBottom: true }
        : { pinnedToBottom: false, scrollTop: target.scrollTop };
    }

    function onScroll() {
      const target = logRef.current;
      if (!target) return;
      // A genuine user scroll (one that moves away from where the anchored
      // message currently sits) releases the auto-resize behavior. We do NOT
      // collapse the tail spacer: the reserved blank below stays as real,
      // scrollable space so scrolling down feels natural instead of snapping.
      if (anchorActiveRef.current) {
        const pinnedTop = lastUserMsgTopInContent(target);
        if (
          pinnedTop !== null &&
          Math.abs(target.scrollTop - (pinnedTop - ANCHOR_TOP_PADDING)) > 40
        ) {
          anchorActiveRef.current = false;
        }
      }
      syncScrollable(target);
      markScrolling();
      /*
       * 意图**只在这里**跟着用户的手改。方向 + 「`scrollHeight` 没变」两条一起,
       * 把我们自己写的 `scrollTop`、浏览器夹取、原生 scroll anchoring 的修正
       * 全都排除在「用户滚动」之外(见 `stick-to-bottom.ts`)。
       */
      // 真实几何,不扣预留空白 —— 见 `readViewportSample` 的注释。
      const sample = readViewportSample(target);
      followIntentRef.current = nextFollowIntent(
        followIntentRef.current,
        lastScrollSampleRef.current,
        sample,
      );
      lastScrollSampleRef.current = sample;
      snapshot(target);
      // `syncFollowState` 里的函数式更新在值没变时原地返回,所以流式期间那一串
      // scroll 事件不会每一跳都排一次重渲,也就不会撞上 React 的
      // "Maximum update depth exceeded"。
      syncFollowState();
    }

    /*
     * 滚轮往上 = 立刻松手,不等 scroll 事件。
     *
     * 这一条是给**快速流式**准备的:同一帧里我们如果写了 `scrollTop`,浏览器会把
     * 这一次滚轮滚动**直接取消掉**,于是那一格滚动连 scroll 事件都不会发 —— 用户的手
     * 在物理上被吃掉了。`use-stick-to-bottom` 也是为此单独挂了 wheel 监听。
     */
    function onWheel(event: WheelEvent) {
      const target = logRef.current;
      if (!target) return;
      if (event.deltaY >= 0) return;
      if (target.scrollHeight <= target.clientHeight) return;
      const { following, escaped } = followIntentRef.current;
      if (!following && escaped) return; // 已经松开了,不用每一格滚轮都重算一次
      releaseFollow();
      syncFollowState();
    }

    /*
     * 触屏同理:**手指往下拖**(内容跟着往下走 = 去看更早的东西)就松手。
     * `use-stick-to-bottom` 压根没挂 touch —— 它的 issue #9「Bad on iOS」就是这个:
     * 惯性滚动会把纯位移判据带偏,而移动端又没有 wheel 事件可依。
     */
    let touchStartY: number | null = null;
    function onTouchStart(event: TouchEvent) {
      touchStartY = event.touches[0]?.clientY ?? null;
    }
    function onTouchMove(event: TouchEvent) {
      const target = logRef.current;
      if (!target || touchStartY === null) return;
      const y = event.touches[0]?.clientY;
      if (y === undefined) return;
      // 手指往下拖 = 内容往下走 = 看更早的内容。
      if (y - touchStartY > 8 && target.scrollHeight > target.clientHeight) {
        releaseFollow();
        syncFollowState();
        touchStartY = null;
      }
    }

    syncScrollable(el);
    rememberScrollSample(el);
    el.addEventListener('scroll', onScroll);
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    return () => {
      // Capture final scroll state before unmount; the ref normally
      // tracks via onScroll, but programmatic scrolls or layout shifts
      // right before unmount can leave it stale.
      snapshot(el);
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      if (chatLogScrollIdleTimerRef.current !== null) {
        window.clearTimeout(chatLogScrollIdleTimerRef.current);
        chatLogScrollIdleTimerRef.current = null;
      }
      setChatLogScrolling(false);
    };
  }, [tab]);

  /**
   * 切标签 / 换会话 / 开始收尾一个 run 之后重算一次。
   *
   * 这几件事都可能在**没有任何 scroll 事件**的情况下改变几何(短会话根本滚不动,
   * 一个事件都不会发)。日常的高度变化由下面那组 Resize/Mutation 观察者兜住;
   * 这条只补那几个「观察者还没来得及重挂」的切换时刻。
   */
  useEffect(() => {
    syncFollowState();
  }, [tab, activeConversationId, displayMessages.length, streaming]);

  useEffect(() => {
    if (tab !== 'chat') return;
    const el = logRef.current;
    if (!el) return;

    let followFrame: number | null = null;
    /*
     * 几何变了(内容长高/变矮、面板改尺寸)之后归拢到一帧里处理一次。
     *
     * **这里不碰跟随意图**,只把意图落到屏幕上:该贴底就贴底,浮标该收就收。
     * 老写法在这里只在「正跟随」时做事,于是**用户停住时的高度变化压根没人管** ——
     * 浮标就那么挂在一屏已经滚不动的对话上。
     */
    const scheduleFollowSync = () => {
      if (followFrame !== null) return;
      followFrame = requestAnimationFrame(() => {
        followFrame = null;
        // While anchored, only shrink the tail spacer as the reply grows
        // (resize-only, never scroll) so the user message stays put without
        // fighting a manual scroll-down.
        if (anchorActiveRef.current) sizeAnchorSpacer();
        syncFollowState();
        // A layout-only resize changes the geometry that the next scroll
        // event is compared against. Refresh the baseline after the resize
        // has settled; otherwise the user's next real scroll still carries
        // the old scrollHeight and is mistaken for another layout correction.
        const target = logRef.current;
        if (target) rememberScrollSample(target);
      });
    };

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            const target = logRef.current;
            if (target) {
              const next = target.scrollHeight - target.clientHeight > 1;
              setChatLogScrollable((prev) => (prev === next ? prev : next));
              if (!next) setChatLogScrolling(false);
            }
            scheduleFollowSync();
          })
        : null;
    const observedChildren = new Set<Element>();
    const syncObservedChildren = () => {
      if (!resizeObserver) return;
      const currentChildren = new Set(Array.from(el.children));
      // The tail spacer's height is driven by the anchor logic; observing it
      // would feed its own resize back into followLatestIfPinned.
      if (tailSpacerRef.current) currentChildren.delete(tailSpacerRef.current);
      for (const child of currentChildren) {
        if (observedChildren.has(child)) continue;
        resizeObserver.observe(child);
        observedChildren.add(child);
      }
      for (const child of observedChildren) {
        if (currentChildren.has(child)) continue;
        resizeObserver.unobserve(child);
        observedChildren.delete(child);
      }
    };

    /* chat-log 之外、但会改变可用高度的发送队列随数据出没,
       所以要跟一份“当前观察的是谁”。PlanPill 已改为滚动区内的绝对定位浮层,
       不再改变可用高度,因此不得加入这个 observer 契约。 */
    const outsideLog = (ref: MutableRefObject<HTMLDivElement | null>) => {
      let observed: Element | null = null;
      return () => {
        if (!resizeObserver) return;
        const el2 = ref.current;
        if (el2 && observed !== el2) {
          if (observed) resizeObserver.unobserve(observed);
          resizeObserver.observe(el2);
          observed = el2;
        } else if (!el2 && observed) {
          resizeObserver.unobserve(observed);
          observed = null;
        }
      };
    };
    const syncQueuedSendStrip = outsideLog(queuedSendStripRef);

    /*
     * 滚动容器**自己**也要观察:输入框长高、软键盘弹出、旁边的 flex 兄弟变大,
     * 都只改可视高度、不改内容高度 —— 只盯内容就会静默失准
     * (`use-stick-to-bottom` 至今没修的 issue #40 就是这个)。
     */
    resizeObserver?.observe(el);
    syncObservedChildren();
    syncQueuedSendStrip();

    const mutationObserver =
      typeof MutationObserver !== 'undefined'
        ? new MutationObserver(() => {
            syncObservedChildren();
            syncQueuedSendStrip();
            scheduleFollowSync();
          })
        : null;
    // childList + subtree only — NOT characterData. Auto-follow during
    // streaming is driven by the ResizeObserver on each message child (text
    // growth changes height), so observing per-character text mutations would
    // re-run the full sync sweep on every streamed frame for no extra benefit.
    mutationObserver?.observe(el, {
      childList: true,
      subtree: true,
    });
    // QueuedSendStrip lives outside the chat-log subtree. Watch its nearest
    // common ancestor so resize observation follows it when it mounts/unmounts.
    const paneEl = el.closest('.pane');
    if (paneEl && mutationObserver) {
      mutationObserver.observe(paneEl, { childList: true });
    }

    return () => {
      if (followFrame !== null) cancelAnimationFrame(followFrame);
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
    };
  }, [tab]);

  // Close the conversation history dropdown on outside click / Escape.
  useEffect(() => {
    if (!showConvList) return;
    function onPointer(e: MouseEvent) {
      const target = e.target as Node;
      if (historyWrapRef.current?.contains(target)) return;
      setShowConvList(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setShowConvList(false);
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [showConvList]);

  useEffect(() => {
    if (showConvList) return;
    setConversationSearch('');
  }, [showConvList]);

  const activeConversation =
    conversations.find((c) => c.id === activeConversationId) ?? null;
  const filteredConversations = useMemo(
    () => filterConversations(conversations, deferredConversationSearch, t),
    [conversations, deferredConversationSearch, t],
  );

  function resetTailSpacer() {
    const s = tailSpacerRef.current;
    if (s) s.style.height = '0px';
  }

  /*
   * 尾部占位块此刻占了多少 —— **读内联样式,不读 `offsetHeight`**。
   * 这块高度是本组件自己写上去的(anchor-to-top 的预留空白),内联样式就是权威,
   * 而且省掉一次强制重排。
   */
  function reservedTailHeight(): number {
    const spacer = tailSpacerRef.current;
    if (!spacer) return 0;
    const parsed = Number.parseFloat(spacer.style.height);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /*
   * ── 同一块几何,两个问题,两个答案 ────────────────────────────────────
   *
   * anchor-to-top 会在回复下面撑一块空白(尾部占位块),好让刚发出的那条用户消息
   * 能顶到视口顶端。那块空白**既是真实可滚动的区域,又不是内容** —— 两句话都对,
   * 所以它必须按问题分开算:
   *
   *   ┌ 问题 ───────────────────────┬ 预留空白算不算 ┬ 用哪个 reader ─────┐
   *   │ 要不要亮「回到最新」浮标      │ 不算(是空)   │ readContentSample │
   *   │ 用户是不是自己滑走了、停不停手 │ 算(是滚动条) │ readViewportSample│
   *   └─────────────────────────────┴───────────────┴───────────────────┘
   *
   * 把扣过的数字喂给第二个问题,就是用户 2026-08-27 那条 bug:
   * 「运行期间,稍微向上滑动一点就突然自动滑成这样了」。真机量到的那一屏是
   * scrollTop 1357 / scrollHeight 1950 / clientHeight 440 / 占位块 250 —— 他离真实
   * 底部 153px,可扣掉空白之后算出来是 (1950−250)−1357−440 = −97 → 夹到 0,
   * 判成「贴着底」,跟随不松手,下一次写 `scrollTop` 就把他拽回去。
   * **只要他往上滑的距离不超过那块空白,程序就完全看不见他的手。**
   */

  /**
   * 用户手底下那根**真实滚动条**的几何 —— 一个像素都不减。
   *
   * 「用户是不是自己滑走了」只能拿这个判:他对着真实滚动条滑了 153px 就是滑了
   * 153px,预留空白正是那根滚动条的一部分。`nextFollowIntent` 的另外两条判据也
   * 依赖真实值 —— 「`scrollHeight` 没变 = 不是内容引起的」说的是**浏览器**看到的
   * 那个 `scrollHeight`(夹取和原生 scroll anchoring 都按它走),不是我们减完的数。
   */
  function readViewportSample(el: HTMLDivElement): ScrollSample {
    const clientHeight = el.clientHeight;
    return {
      scrollTop: el.scrollTop,
      scrollHeight: Math.max(clientHeight, el.scrollHeight),
      clientHeight,
    };
  }

  /**
   * 把预留空白扣掉之后的几何 —— **只回答「底下还有没有内容可看」**。
   *
   * 这是「回到最新」误报的另一半病根:那块空白是**预留的空**,不是内容 —— 可
   * 「离底部还有多远」照单全收,于是浮标被一屏空白点亮,而屏幕上明明就是最新的东西
   * (用户 2026-08-27 的截图:一条用户消息 + 一个「进行中」头,下面大半空着,浮标在)。
   */
  function readContentSample(el: HTMLDivElement): ScrollSample {
    const clientHeight = el.clientHeight;
    return {
      scrollTop: el.scrollTop,
      scrollHeight: Math.max(clientHeight, el.scrollHeight - reservedTailHeight()),
      clientHeight,
    };
  }

  /**
   * 把当前几何记成基线。**我们自己写完 `scrollTop` 之后必须叫一次**,否则下一次用户滚动的方向会算反。
   *
   * 记的是**真实**几何:下一次 scroll 事件也是拿真实几何来跟它相减的,两边单位必须一致。
   */
  function rememberScrollSample(el: HTMLDivElement) {
    lastScrollSampleRef.current = readViewportSample(el);
  }

  /** 唯一的 `scrollTop` 写入口:写完就记基线。 */
  function writeLogScrollTop(el: HTMLDivElement, top: number) {
    el.scrollTop = top;
    rememberScrollSample(el);
  }

  /** 此刻是不是真的在跟着最新输出跑。anchor-to-top 期间不是:那时用户消息钉在顶端,回复在下面长。 */
  function isFollowingTail(): boolean {
    return followIntentRef.current.following && !anchorActiveRef.current;
  }

  /**
   * 把跟随意图落到屏幕上:该贴底就贴底,该给入口就给入口。
   *
   * **任何会改变几何的事情之后都要叫它一次** —— 滚动、内容长高/变矮、切标签、切会话、
   * 面板改尺寸、折叠块展开收起、占位块重新定尺寸。这条是「浮标该不该在」的另一半:
   * 判据本身管「算的时候别算错」,这里管「变了要去算」。老写法只在 scroll 事件和
   * 「消息条数变了」时重算,于是内容在没有滚动事件的情况下变矮之后,浮标就那么挂着。
   *
   * 它**不改意图**。意图只由用户的动作改(见 `stick-to-bottom.ts`)。
   */
  function syncFollowState() {
    const el = logRef.current;
    if (!el) return;
    if (isFollowingTail()) {
      // 瞬时贴底,不用平滑滚动:平滑滚动会吐出一串中间 scroll 事件,
      // 那些事件看起来就像用户在滚,会把跟随打断(这也是当初写死 instant 的原因)。
      if (el.scrollTop !== el.scrollHeight) writeLogScrollTop(el, el.scrollHeight);
    }
    // 浮标问的是「底下还有没有**内容**」,所以这里用扣掉预留空白的那份。
    const sample = readContentSample(el);
    /*
     * 这里**一个字都不改跟随意图**。
     *
     * 试过在这里补一条「已经贴着底了就重新挂上跟随」—— 当场就把滚轮那条逃逸路径
     * 废掉了:快速流式时浏览器会把那一格滚轮滚动整个吃掉,位置纹丝不动,于是
     * 「贴着底」永远成立,刚松开的手立刻又被按回去。同理,在一屏装得下的对话里
     * 展开折叠块也会被判回跟随,接着折叠块一长高就把刚点的那一行顶走。
     *
     * 意图只由用户的动作改。「滚不动的对话上不该有浮标」由判据里那条不变量兜着
     * (`shouldShowJumpToLatest` 的 `scrollHeight <= clientHeight + 1`),不需要在这里
     * 反过来改意图。
     */
    setScrolledFromBottom((prev) => {
      const next = shouldShowJumpToLatest({
        distance: Math.max(0, sample.scrollHeight - sample.scrollTop - sample.clientHeight),
        clientHeight: sample.clientHeight,
        scrollHeight: sample.scrollHeight,
        shown: prev,
        following: isFollowingTail(),
      });
      return prev === next ? prev : next;
    });
  }

  /** 显式动作(点「回到最新」、发消息、切会话)重新挂上跟随。 */
  function armFollow() {
    followIntentRef.current = { following: true, escaped: false };
  }

  /**
   * 表单/消息滚到位之后,按**预测的**落点定跟随意图和浮标。
   *
   * 为什么用预测而不是等真实滚动落地:`scrollIntoView` 可能因为目标
   * 本来就在底部而**根本不产生滚动** —— 那种情况永远等不到 scroll 事件来纠正,
   * 浮标就会挂着没东西可回(recvqajMdAnfmd)。
   */
  function settleFollowAfterPredictedScroll(el: HTMLDivElement, distance: number) {
    const clientHeight = el.clientHeight;
    /*
     * 跟随意图和基线按**真实**几何定 —— `distance` 本来就是拿真实几何预测出来的
     * (`distanceFromBottomAfterAligningTop` 读的是 `el.scrollHeight`),而基线要跟
     * 下一次 scroll 事件的读数同单位,否则下一跳的方向会算反。
     */
    const viewport: ScrollSample = {
      scrollTop: Math.max(0, el.scrollHeight - clientHeight - distance),
      scrollHeight: Math.max(clientHeight, el.scrollHeight),
      clientHeight,
    };
    lastScrollSampleRef.current = viewport;
    followIntentRef.current = isSampleAtBottom(viewport)
      ? { following: true, escaped: false }
      : { following: false, escaped: true };
    // 浮标仍然按「底下还有没有内容」算 —— 预留空白不是内容。
    setScrolledFromBottom((prev) =>
      shouldShowJumpToLatest({
        distance,
        clientHeight,
        scrollHeight: Math.max(clientHeight, el.scrollHeight - reservedTailHeight()),
        shown: prev,
        following: isFollowingTail(),
      }),
    );
  }

  /** 显式动作(展开折叠块、anchor-to-top 接管)松开跟随。 */
  function releaseFollow() {
    followIntentRef.current = { following: false, escaped: true };
  }

  // Content offset (distance from the top of the scroll content) of the most
  // recent user message. Invariant to the current scrollTop, so it's safe to
  // call regardless of where the user has scrolled.
  function lastUserMsgTopInContent(el: HTMLDivElement): number | null {
    const userEls = el.querySelectorAll<HTMLElement>('.msg.user');
    const msgEl = userEls[userEls.length - 1];
    if (!msgEl) return null;
    const elRect = el.getBoundingClientRect();
    const msgRect = msgEl.getBoundingClientRect();
    return el.scrollTop + (msgRect.top - elRect.top);
  }

  // Predicts the post-settle "distance from bottom" (same metric `onScroll`
  // computes) after aligning `target`'s top edge with `el`'s top edge, the
  // way `target.scrollIntoView({ block: 'start' })` does. Reads current
  // geometry synchronously instead of waiting on the (possibly smooth,
  // possibly no-op) actual scroll to land: a short `target` — e.g. a
  // question form that is also the last thing in the log — clamps to the
  // real bottom, which never fires a native `scroll` event to correct a
  // hardcoded "still scrolled away" guess. That stale guess is what left the
  // jump-to-latest button stuck visible with nothing left to jump to
  // (recvqajMdAnfmd).
  function distanceFromBottomAfterAligningTop(el: HTMLDivElement, target: HTMLElement): number {
    const elRect = el.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const targetTopInContent = el.scrollTop + (targetRect.top - elRect.top);
    const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    const predictedScrollTop = Math.min(Math.max(0, targetTopInContent), maxScrollTop);
    return Math.max(0, maxScrollTop - predictedScrollTop);
  }

  // Resize the tail spacer so the anchored message can sit at the top with
  // just enough room below it — no more. This is a resize ONLY (never a
  // scroll): shrinking empty space below the fold can't shift what's visible
  // while the user is pinned near the top, so it never causes jitter. As the
  // reply streams in, `needed` shrinks monotonically toward 0.
  function sizeAnchorSpacer() {
    const el = logRef.current;
    const spacer = tailSpacerRef.current;
    if (!el || !spacer) return;
    const msgTopInContent = lastUserMsgTopInContent(el);
    if (msgTopInContent === null) return;
    const spacerH = spacer.offsetHeight;
    const contentBelow = el.scrollHeight - spacerH - msgTopInContent;
    const needed = Math.max(0, el.clientHeight - contentBelow - ANCHOR_TOP_PADDING);
    spacer.style.height = `${needed}px`;
  }

  // Smooth-scroll the anchored message to the top. Called ONCE per turn (on
  // send). The message then stays at the top on its own as the reply streams
  // below it, so we never re-scroll — re-scrolling each chunk is what caused
  // the scroll-down fight and the settle jitter.
  function scrollAnchorToTop() {
    const el = logRef.current;
    if (!el) return;
    const msgTopInContent = lastUserMsgTopInContent(el);
    if (msgTopInContent === null) return;
    const target = Math.max(0, msgTopInContent - ANCHOR_TOP_PADDING);
    el.scrollTo({ top: target, behavior: 'smooth' });
  }

  function jumpToBottom() {
    const el = logRef.current;
    if (!el) return;
    anchorActiveRef.current = false;
    armFollow();
    resetTailSpacer();
    // 这一下用平滑滚动是刻意的:它是用户点出来的一次大跳,平滑更好读。
    // 中间那串 scroll 事件方向都是**向下**,按 `stick-to-bottom.ts` 的判据
    // 不会被误当成挣脱,所以不需要额外的「这是程序滚的」标记。
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    syncFollowState();
  }

  useEffect(() => {
    if (typeof document === 'undefined') return;
    setComposerPortalTarget(document.body);
  }, []);

  useLayoutEffect(() => {
    if (tab !== 'chat') {
      setComposerPortalRect(null);
      return;
    }
    const slot = composerSlotRef.current;
    if (!slot || typeof window === 'undefined') return;

    let frame: number | null = null;
    const updateRect = () => {
      frame = null;
      const rect = slot.getBoundingClientRect();
      setComposerPortalRect((prev) => {
        const next = {
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          bottom: Math.max(0, Math.round(window.innerHeight - rect.bottom)),
        };
        if (
          prev
          && prev.left === next.left
          && prev.width === next.width
          && prev.bottom === next.bottom
        ) {
          return prev;
        }
        return next;
      });
    };
    const scheduleUpdate = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(updateRect);
    };

    updateRect();
    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(scheduleUpdate)
        : null;
    resizeObserver?.observe(slot);
    const pane = slot.closest('.pane');
    if (pane) resizeObserver?.observe(pane);
    window.addEventListener('resize', scheduleUpdate);
    window.visualViewport?.addEventListener('resize', scheduleUpdate);

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', scheduleUpdate);
      window.visualViewport?.removeEventListener('resize', scheduleUpdate);
    };
  }, [tab]);

  useLayoutEffect(() => {
    if (tab !== 'chat' || !composerPortalTarget || !composerPortalRect) return;
    const layer = composerLayerRef.current;
    if (!layer || typeof window === 'undefined') return;

    let frame: number | null = null;
    const updateHeight = () => {
      frame = null;
      const nextHeight = Math.ceil(layer.getBoundingClientRect().height);
      setComposerSlotHeight((prev) => (prev === nextHeight ? prev : nextHeight));
    };
    const scheduleUpdate = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(updateHeight);
    };

    updateHeight();
    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(scheduleUpdate)
        : null;
    resizeObserver?.observe(layer);

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
    };
  }, [composerPortalRect, composerPortalTarget, tab]);

  const composerNode = (
    <>
      {/* 插件 / 设计百宝箱 live inside the composer's "+" menu (below 工作目录,
          hover to expand); they no longer sit as quick pills above the input. */}
    <ChatComposer
      ref={composerRef}
      quotes={quotes}
      onClearQuotes={clearQuotes}
      onRestoreQuotes={setQuotes}
      designSystemPicker={designSystemPicker}
      projectId={projectId}
      projectFiles={projectFiles}
      activeProjectFileName={activeProjectFileName}
      sessionMode={sessionMode}
      skills={skills}
      streaming={streaming}
      sendDisabled={sendDisabled}
      inputDisabled={viewerOnly}
      initialDraft={initialDraft}
      composerPlaceholder={composerPlaceholder}
      placeholderScenarios={composerPlaceholderScenarios}
      draftStorageKey={composerDraftStorageKey}
      onEnsureProject={onEnsureProject}
      commentAttachments={commentsToAttachments(attachedComments)}
      onRemoveCommentAttachment={onDetachComment}
      onSend={(prompt, attachments, commentAttachments, meta) => {
        armFollow();
        scrolledToFormRef.current = new Set();
        if (editingQueuedSendId && onUpdateQueuedSend) {
          const original = queuedItems.find((item) => item.id === editingQueuedSendId);
          const update: QueuedSendUpdate = {
            prompt,
            attachments,
            commentAttachments,
          };
          const nextMeta = meta ?? original?.meta;
          if (nextMeta !== undefined) update.meta = nextMeta;
          onUpdateQueuedSend(editingQueuedSendId, update);
          setEditingQueuedSendId(null);
          return;
        }
        // Arm "anchor to top": the messages effect promotes this once
        // the new user turn renders, pinning it to the top of the view.
        // Clear any stale reserve from the previous turn first so a resend
        // doesn't strand the new turn below a leftover gap (release #3653).
        anchorActiveRef.current = false;
        resetTailSpacer();
        anchorPendingRef.current = true;
        const outcome = onSend(prompt, attachments, commentAttachments, meta);
        if (outcome instanceof Promise) {
          return outcome.then((result) => {
            if (result === 'restore-draft') anchorPendingRef.current = false;
            return result;
          });
        }
        if (outcome === 'restore-draft') anchorPendingRef.current = false;
        return outcome;
      }}
      onStop={onStop}
      onOpenSettings={onOpenSettings}
      onOpenMcpSettings={onOpenMcpSettings}
      onBrowsePlugins={onBrowsePlugins}
      onOpenConnectors={onOpenConnectors}
      petConfig={petConfig}
      onAdoptPet={onAdoptPet}
      onTogglePet={onTogglePet}
      onOpenPetSettings={onOpenPetSettings}
      researchAvailable={researchAvailable}
      projectMetadata={projectMetadata}
      onProjectMetadataChange={onProjectMetadataChange}
      activeWorkspaceContext={activeWorkspaceContext}
      initialWorkspaceContexts={initialWorkspaceContexts}
      workspaceContexts={workspaceContexts}
      byokApiProtocol={byokApiProtocol}
      byokImageModel={byokImageModel}
      onChangeByokImageModel={onChangeByokImageModel}
      byokVideoModel={byokVideoModel}
      onChangeByokVideoModel={onChangeByokVideoModel}
      byokSpeechModel={byokSpeechModel}
      onChangeByokSpeechModel={onChangeByokSpeechModel}
      byokSpeechVoice={byokSpeechVoice}
      onChangeByokSpeechVoice={onChangeByokSpeechVoice}
      currentSkillId={currentSkillId}
      onProjectSkillChange={onProjectSkillChange}
      pinnedPluginId={activePluginSnapshot?.pluginId ?? null}
      footerAccessory={composerFooterAccessory}
      leadingAccessory={composerLeadingAccessory}
      currentDesignSystemId={currentDesignSystemId}
      onActiveDesignSystemChange={onActiveDesignSystemChange}
      onShowToast={onShowToast}
    />
    </>
  );
  const shouldPortalComposer =
    tab === 'chat'
    && composerPortalTarget !== null
    && composerPortalRect !== null
    && composerPortalRect.width > 0;
  const composerSlotStyle: CSSProperties | undefined = shouldPortalComposer
    ? { minHeight: composerSlotHeight > 0 ? composerSlotHeight : undefined }
    : undefined;

  return (
    /* `chatSeam` 是 --chat-* 的唯一定义处。少了它,聊天树里所有 var(--chat-…) 静默落空 ——
       比如壳头「进行中」那句用 background-clip: text 上色,渐变一失效字就成透明的,
       页面上像是没渲染,而单测一条都不会红。
       抹在 .pane 自己身上、**不另外包一层**:包一层会打断 `.split-chat-slot > .pane`
       这类子选择器(全仓 11 条),聊天卡的圆角 / 白底 / backdrop-filter 会集体失效。 */
    <div {...chatSeam('pane')}>
        <div className="chat-project-header">
          {collapseControlLifted ? null : onCollapse ? (
            <button
              type="button"
              className="chat-project-back od-tooltip"
              onClick={onCollapse}
              title={t('chat.collapsePane')}
              aria-label={t('chat.collapsePane')}
              data-tooltip={t('chat.collapsePane')}
              data-tooltip-placement="bottom"
              data-testid="chat-collapse-toggle"
            >
              <Icon name="panel-left" size={16} />
            </button>
          ) : onBack ? (
            <button
              type="button"
              className="chat-project-back"
              onClick={onBack}
              title={backLabel}
              aria-label={backLabel}
            >
              <Icon name="arrow-left" size={16} />
            </button>
          ) : null}
          {projectHeader ? (
            <span className="chat-project-header-title">{projectHeader}</span>
          ) : null}
          <div
            className={`chat-history-wrap chat-session-switcher${showConvList ? ' open' : ''}`}
            ref={historyWrapRef}
          >
            <button
              type="button"
              className="chat-session-trigger icon-only"
              data-testid="conversation-history-trigger"
              title={
                activeConversation?.title
                  ? `${t('chat.conversationsTitle')} · ${activeConversation.title}`
                  : t('chat.conversationsTitle')
              }
              aria-label={t('chat.conversationsAria')}
              aria-haspopup="menu"
              aria-expanded={showConvList}
              onClick={() => {
                setShowConvList((v) => {
                  const next = !v;
                  if (next) {
                    trackChatPanelClick(analytics.track, {
                      page_name: 'chat_panel',
                      area: 'chat_panel',
                      element: 'history',
                    });
                  }
                  return next;
                });
              }}
            >
              <Icon name="comment" size={16} />
            </button>
            {showConvList ? (
              <div className="chat-history-menu" role="menu" data-testid="conversation-history-menu">
                <div className="chat-history-menu-head">
                  <span className="chat-history-menu-title">
                    {t('chat.conversationsHeading')}
                    <span className="chat-history-menu-count">
                      <span data-testid="conversation-history-count">
                      {filteredConversations.length === conversations.length
                        ? compactCount(conversations.length)
                        : `${compactCount(filteredConversations.length)} / ${compactCount(conversations.length)}`}
                      </span>
                    </span>
                  </span>
                  {onNewConversation ? (
                    <button
                      type="button"
                      className="chat-history-new"
                      data-testid="conversation-history-new"
                      disabled={newConversationDisabled}
                      onClick={() => {
                        if (newConversationDisabled) return;
                        trackChatPanelClick(analytics.track, {
                          page_name: 'chat_panel',
                          area: 'chat_panel',
                          element: 'new_chat',
                        });
                        onNewConversation();
                        setShowConvList(false);
                      }}
                    >
                      <Icon name="plus" size={11} />
                      <span>{t('chat.new')}</span>
                    </button>
                  ) : null}
                </div>
                <label className="chat-history-search">
                  <Icon name="search" size={12} />
                  <input
                    type="search"
                    value={conversationSearch}
                    onChange={(event) => setConversationSearch(event.currentTarget.value)}
                    placeholder={t('chat.conversationsSearchPlaceholder')}
                    data-testid="conversation-history-search"
                  />
                  {conversationSearch ? (
                    <button
                      type="button"
                      className="chat-history-search-clear"
                      onClick={() => setConversationSearch('')}
                      aria-label={t('chat.comments.clear')}
                    >
                      <Icon name="close" size={10} />
                    </button>
                  ) : null}
                </label>
                <div className="chat-history-list" data-testid="conversation-list">
                  {conversations.length === 0 ? (
                    <div className="chat-history-empty">
                      {t('chat.emptyConversations')}
                    </div>
                  ) : filteredConversations.length === 0 ? (
                    <div className="chat-history-empty">
                      {t('chat.conversationsNoMatches')}
                    </div>
                  ) : (
                    filteredConversations.map((c) => (
                      <ConversationRow
                        key={c.id}
                        conversation={c}
                        active={c.id === activeConversationId}
                        messageCount={conversationMessageCount(c, activeConversationId, messagesConversationId, messages.length)}
                        onSelect={() => {
                          onSelectConversation(c.id);
                          setShowConvList(false);
                        }}
                        onDelete={() => onDeleteConversation(c.id)}
                        t={t}
                      />
                    ))
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </div>
        {tab === 'chat' ? (
          <>
            <div className={`chat-log-wrap${chatLogTray ? ' has-chat-log-tray' : ''}`}>
              <div className="chat-log-viewport">
                <ChatMessageRail
                  messages={displayMessages}
                  loading={loading}
                  logRef={logRef}
                  activeConversationKey={activeConversationId ?? 'no-conversation'}
                  onNavigate={handleChatRailNavigate}
                  t={t}
                />
                <div
                className={[
                  'chat-log',
                  loading ? 'is-loading' : '',
                  chatLogScrollable ? 'is-scrollable' : '',
                  chatLogScrolling ? 'is-scrolling' : '',
                  shouldBalanceFinishedTranscript ? 'is-balanced-transcript' : '',
                  planPillVisible ? 'has-plan-pill-reserve' : '',
                ].filter(Boolean).join(' ')}
                ref={logRef}
                data-testid="chat-log"
                /* 配平态原本只体现在类名上。类名是样式的私事(迁 CSS Module 就变哈希),
                   状态得有自己的出口 —— 测试断言这个属性,不去嗅类名。 */
                data-balanced={shouldBalanceFinishedTranscript ? 'true' : 'false'}
                aria-busy={loading}
                onClickCapture={(e) => {
                  const target = e.target as HTMLElement;
                  const log = logRef.current;
                  const scrollAnchor = log
                    ? captureElementScrollAnchor(log, target)
                    : null;
                  if (scrollAnchor && log) {
                    // QuestionForm swaps the active step / custom-answer row
                    // after this capture phase. Stop tail following before
                    // that layout change, then put the same visible control
                    // back at its previous viewport coordinate after commit.
                    releaseFollow();
                    anchorActiveRef.current = false;
                    requestAnimationFrame(() => {
                      const currentLog = logRef.current;
                      if (!currentLog) return;
                      const nextTop = scrollTopForElementScrollAnchor(currentLog, scrollAnchor);
                      if (nextTop !== null && Math.abs(nextTop - currentLog.scrollTop) >= 0.5) {
                        writeLogScrollTop(currentLog, nextTop);
                      } else {
                        rememberScrollSample(currentLog);
                      }
                      syncFollowState();
                    });
                  }
                  // Expanding an accordion (tool card / thinking block) should
                  // grow downward with the clicked header staying put. While a
                  // run is glued to the bottom, the ResizeObserver would re-pin
                  // to the bottom on the height change and push the header up,
                  // so unpin the moment the user toggles one open.
                  // `summary` covers the execution record and everything folded
                  // inside it — those disclosures are <details>, not buttons.
                  const toggle = target.closest(
                    'summary, .thinking-toggle, .action-card-toggle, button.op-card-head, [aria-expanded]',
                  );
                  if (toggle && log?.contains(toggle) && !scrollAnchor) {
                    releaseFollow();
                    anchorActiveRef.current = false;
                    // 浮标交给几何判 —— 老写法在这里无条件点亮它,于是在一屏装得下、
                    // 根本滚不动的对话里展开一个折叠块,也会冒出一颗「回到最新」。
                    syncFollowState();
                  }
                }}
              >
                {loading ? <ChatConversationLoading t={t} /> : null}
                {displayMessages.length === 0 && !loading ? (
                  <div className="chat-empty-wrap">
                    {showImportedFolderArtifacts ? (
                      <ImportedFolderArtifacts
                        projectId={projectId}
                        files={importedFolderArtifacts}
                        onOpenFile={onRequestOpenFile}
                        t={t}
                      />
                    ) : (
                      <>
                        {/* #5517 leaves the empty conversation pane clean — no
                            "start a conversation" title or starter template
                            cards; only the connect-repo note below survives. */}
                        {connectRepoNeeded ? (
                          <div className="chat-connect-repo" role="note">
                            <span className="chat-connect-repo-icon" aria-hidden>
                              <Icon name="github" size={18} />
                            </span>
                            <span className="chat-connect-repo-body">
                              <span className="chat-connect-repo-title">
                                {repoConnectCopy(t, githubConnected).cardTitle}
                              </span>
                              <span className="chat-connect-repo-text">
                                {repoConnectCopy(t, githubConnected).cardBody}
                              </span>
                            </span>
                            <button
                              type="button"
                              className="primary-ghost"
                              disabled={githubConnected === undefined}
                              onClick={() => onConnectRepo?.()}
                            >
                              <Icon name="github" size={13} />
                              {repoConnectCopy(t, githubConnected).buttonLabel}
                            </button>
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
                ) : null}
                <ChatRows
                  messages={displayMessages}
                  streaming={streaming}
                  onRetryImage={handleRetryImage}
                  projectId={projectId}
                  projectKindForTracking={projectKindForTracking}
                  activeConversationId={activeConversationId}
                  activeConversationKey={activeConversationId ?? 'no-conversation'}
                  projectFiles={projectFiles}
                  projectMetadata={projectMetadata}
                  projectFileNames={projectFileNames}
                  projectResolvedDir={projectResolvedDir}
                  mediaTasksByRunId={mediaTasksByRunId}
                  onRequestOpenFile={onRequestOpenFile}
                  onRequestPluginDetails={onRequestPluginDetails}
                  onRequestDesignSystemDetails={onRequestDesignSystemDetails}
                  onRequestPluginFolderAgentAction={onRequestPluginFolderAgentAction}
                  activePluginActionPaths={activePluginActionPaths}
                  hiddenPluginActionPaths={hiddenPluginActionPaths}
                  onShareToOpenDesign={onShareToOpenDesign}
                  shareToOpenDesignBusyMessageId={shareToOpenDesignBusyMessageId}
                  forceStreamingMessageIds={forceStreamingMessageIds}
                  lastAssistantId={lastAssistantId}
                  activePluginSnapshot={activePluginSnapshot}
                  activeDesignSystem={activeDesignSystem}
                  hasActiveDesignSystem={hasActiveDesignSystem}
                  errorCardOwnerId={errorCardOwnerId}
                  nextUserContentByAssistantId={nextUserContentByAssistantId}
                  assistantCallbacksRef={assistantCallbacksRef}
                  onBrandBrowserAssistConfirm={onBrandBrowserAssistConfirm}
                  onArtifactShare={onArtifactShare}
                  onToolboxAction={handleToolboxAction}
                  onNextStepPromptAction={handleNextStepPromptAction}
                  onNextStepAiOptimize={onContinueBrandEnrichment}
                  nextStepAiOptimizeBusy={brandEnrichmentBusy}
                  onNextStepContinueExtraction={onContinueBrandExtraction}
                  nextStepContinueExtractionBusy={continueBrandExtractionBusy}
                  onNextStepContinueAiExtraction={onContinueBrandAgentExtraction}
                  nextStepContinueAiExtractionBusy={continueBrandAgentExtractionBusy}
                  onNextStepCreateDesign={onCreateDesignFromActiveDesignSystem}
                  nextStepCreateDesignBusy={createDesignFromActiveDesignSystemBusy}
                  onNextStepCreateDesignSystem={onCreateDesignSystemFromProject}
                  nextStepCreateDesignSystemBusy={createDesignSystemFromProjectBusy}
                  onPickSkill={handlePickSkill}
                  onNextStepSuggestion={handleNextStepSuggestion}
                  onArtifactDownload={onArtifactDownload}
                  nextStepSkills={skills}
                  nextStepVariant={nextStepVariant}
                  onForkFromMessage={viewerOnly ? undefined : onForkFromMessage}
                  // 只读访客发不出这一轮,自然也接不了上一轮的活 —— 和 Fork 同一条门
                  onContinueRemainingTasks={viewerOnly ? undefined : onContinueRemainingTasks}
                  onAssistantFeedback={onAssistantFeedback}
                  forkingMessageId={forkingMessageId}
                  t={t}
                  onSubmitQuestionForm={onSubmitQuestionForm}
                  questionFormSubmitDisabled={questionFormSubmitDisabled}
                  scrollContainerRef={logRef}
                  onVirtualScrollTopWrite={(element, top) => {
                    writeLogScrollTop(element, top);
                    syncFollowState();
                  }}
                  highlightedUserMessageId={chatRailHighlightedMessageId}
                />
                {displayError ? (
                  /*
                   * 报错卡(稿子组件 19)。终于接回产品 —— 之前 `RunErrorCard` 抽出来了
                   * 却只有验收陈列页在用,产品这一格仍是 `UserActionCard`:
                   * 说明被藏在折叠里,而稿子的 `errb` 是**一句话直接可见**。
                   *
                   * 卡上再没有第二层:标题 + 一句人话 + 一排动作,到此为止。
                   * 曾经挂在这里的「错误详情」折叠(诊断原文)已经整块下线
                   * (用户 2026-08-27);要原始日志走那一排里的〔导出日志〕。
                   */
                  <RunErrorCard
                    dataKind="run-recovery"
                    title={
                      runFailureUi
                        ? t(runFailureUi.titleKey)
                        : t('chat.runError.title.generic')
                    }
                    description={displayError}
                    actions={(
                      <>
                        {/*
                          * 稿子第 78 格那一排是〔联系支持〕〔导出日志〕〔从失败处重试〕——
                          * 前两颗次级、第三颗主。前两颗**不挑失败类型**(产品原话
                          * 「好多都应该得有导出日志这个按钮」),所以它们排在
                          * `showErrorActions` 之外:一张一颗按钮都没有的卡
                          * (CPU 不支持、运行时定义非法)照样有这两条出路。
                          */}
                        {/*
                          * 第 4 档(§6.Z):重试无效、我们也没别的出路时,这颗
                          * **从次级提为主** —— 不是新增一颗按钮,是同一颗换个分量。
                          * 位置不动:那一排在 274px 窄面板里的排布是量过的,
                          * 重排会把 e2e 的溢出判据一起动掉。
                          */}
                        <RunErrorCardAction
                          type="button"
                          variant={contactSupportIsPrimary ? 'primary' : 'secondary'}
                          data-testid="chat-error-contact-support"
                          {...(contactSupportIsPrimary ? { 'data-primary': 'true' } : {})}
                          onClick={() => setSupportDialogOpen(true)}
                        >
                          <Icon name="headset" size={11} />
                          {t('chat.runError.contactSupportCta')}
                        </RunErrorCardAction>
                        <ExportLogsAction />
                        {showByokRecoveryCta ? (
                          <RunErrorCardAction
                            type="button"
                            variant="primary"
                            onClick={onSwitchToLocalCli}
                          >
                            {t('avatar.useLocal')}
                          </RunErrorCardAction>
                        ) : null}
                        {retryAssistant && onRetry && runFailureUi ? (
                          <RunErrorCardActionGroup>
                            {runFailureUi.primaryAction === 'authorize' ? (
                              // Sign in to AMR inline — the pill drives vela login,
                              // surfaces the activation URL/code when the browser
                              // doesn't auto-open, and on success we retry the run
                              // without bouncing the user out to Settings.
                              <AmrLoginPill
                                className="chat-error-amr-login"
                                signInLabel={t('chat.amrError.authorizeCta')}
                                amrEntrySourceDetail="chat_error_authorize_retry"
                                initialStatus={inlineAmrLoginStatus}
                                skipInitialRefresh
                                metricsConsent={config?.telemetry?.metrics === true}
                                installationId={config?.installationId}
                                showActivationDetails
                                hideSignedOutStatus
                                revealPendingCancelAction
                                onSignInStarted={() => {
                                  trackRecoveryClick(
                                    retryAssistant,
                                    'authorize_and_retry',
                                  );
                                  if (
                                    projectId
                                    && activeConversationId
                                    && amrAuthRetryMountId
                                    && amrAuthRetryWorkspaceIdentityKey
                                    && onArmAmrAuthRetryContinuation
                                  ) {
                                    onArmAmrAuthRetryContinuation({
                                      projectId,
                                      conversationId: activeConversationId,
                                      assistantId: retryAssistant.id,
                                      workspaceIdentityKey: amrAuthRetryWorkspaceIdentityKey,
                                      originMountId: amrAuthRetryMountId,
                                    });
                                  }
                                }}
                                onStatusChange={(loginStatus) => {
                                  consumeAmrAuthRetryIfAuthorized(loginStatus);
                                }}
                              />
                            ) : runFailureUi.primaryAction === 'launch-terminal-auth' ? (
                              <RunErrorCardAction
                                type="button"
                                variant="primary"
                                onClick={() => {
                                  onLaunchAntigravityOauth?.();
                                }}
                              >
                                {t('chat.antigravityError.launchTerminalCta')}
                              </RunErrorCardAction>
                            ) : runFailureUi.primaryAction === 'launch-terminal-switch-model' ? (
                              <RunErrorCardAction
                                type="button"
                                variant="primary"
                                onClick={() => {
                                  onLaunchAntigravityOauth?.();
                                }}
                              >
                                {t('chat.antigravityError.launchSwitchModelCta')}
                              </RunErrorCardAction>
                            ) : runFailureUi.primaryAction === 'switch-model' ? (
                              /*
                               * 模型下线 / 不在套餐里 —— 重试必然同样结果,所以这一档
                               * 不给重试(设计原则四)。
                               *
                               * 落点按交付稿:「更换模型**直接打开模型选择器**,选完自动
                               * 重跑」(`error-ux-design.md:130`)。宿主接了 `onSwitchModel`
                               * 就开 composer 那颗触发器背后的内联列表;没接的回落设置面板。
                               */
                              <RunErrorCardAction
                                type="button"
                                variant="primary"
                                data-testid="chat-error-switch-model"
                                onClick={() => {
                                  trackRecoveryClick(retryAssistant, 'switch_model_retry');
                                  if (onSwitchModel && retryAssistant) onSwitchModel(retryAssistant);
                                  else onOpenSettings?.('execution');
                                }}
                              >
                                {t('chat.runError.switchModelCta')}
                              </RunErrorCardAction>
                            ) : runFailureUi.primaryAction === 'recharge' ? (
                              <RunErrorCardAction
                                type="button"
                                variant="primary"
                                onClick={() => {
                                  const attribution = recordAmrEntry(
                                    analytics.track,
                                    'chat_error_recharge',
                                    new Date(),
                                    {
                                      metricsConsent:
                                        config?.telemetry?.metrics === true,
                                    },
                                  );
                                  // Forward the canonical telemetry device id to
                                  // AMR only on metrics opt-in (see
                                  // amrHandoffDeviceId). Sourced from the current
                                  // config.installationId / resolved device id,
                                  // not the mount-time bootstrap UUID, so the join
                                  // key matches the telemetry identity even across
                                  // a Delete-my-data rotation.
                                  const deviceId = amrHandoffDeviceId({
                                    metricsConsent:
                                      config?.telemetry?.metrics === true,
                                    resolvedDeviceId: getResolvedDeviceId(),
                                    installationId: config?.installationId,
                                  });
                                  window.open(
                                    attributedAmrUrl(
                                      amrRechargeUrlForProfile(amrProfile),
                                      attribution,
                                      deviceId,
                                    ),
                                    '_blank',
                                    'noopener,noreferrer',
                                  );
                                }}
                              >
                                {t('chat.amrError.rechargeCta')}
                              </RunErrorCardAction>
                            ) : runFailureUi.primaryAction === 'upgrade' ? (
                              <RunErrorCardAction
                                type="button"
                                variant="primary"
                                onClick={() => {
                                  const attribution = recordAmrEntry(
                                    analytics.track,
                                    'chat_error_upgrade',
                                    new Date(),
                                    {
                                      metricsConsent:
                                        config?.telemetry?.metrics === true,
                                    },
                                  );
                                  const deviceId = amrHandoffDeviceId({
                                    metricsConsent:
                                      config?.telemetry?.metrics === true,
                                    resolvedDeviceId: getResolvedDeviceId(),
                                    installationId: config?.installationId,
                                  });
                                  window.open(
                                    attributedAmrUrl(
                                      amrPlansUrlForProfile(amrProfile),
                                      attribution,
                                      deviceId,
                                    ),
                                    '_blank',
                                    'noopener,noreferrer',
                                  );
                                }}
                              >
                                {t('chat.amrBalanceGate.plansCta')}
                              </RunErrorCardAction>
                            ) : null}
                            {canResumeFailedRun ? (
                              // Resumable failure: continue the agent's existing
                              // CLI session instead of restarting from scratch, so
                              // partial work is kept. Replaces the from-scratch
                              // Retry as the single primary recovery action. Use
                              // the wired resume handler when present, otherwise a
                              // plain send of the continue prompt — never the
                              // re-sending Retry path, which would resume + repeat.
                              <RunErrorCardAction
                                type="button"
                                variant="primary"
                                onClick={() =>
                                  {
                                    trackRecoveryClick(retryAssistant, 'resume_run');
                                    if (onResumeRun) onResumeRun(retryAssistant);
                                    else onSend(RESUME_CONTINUE_PROMPT, [], []);
                                  }
                                }
                              >
                                {t('chat.resumeRunCta')}
                              </RunErrorCardAction>
                            ) : runFailureUi.primaryAction === 'retry' ||
                              runFailureUi.secondaryRetry ? (
                              /*
                               * 和旁边两颗**同一副壳**:稿子 3360-3377 那一排三颗都是
                               * `.btn`,差别只在 primary / secondary。原来这颗是裸
                               * `<button class="chat-error-action">`,自带 4px 圆角和
                               * 6px 14px 内距,而旁边两颗走共享 Button 的 sm(999px /
                               * 4px 11px)—— 排在一起圆角明显对不上(用户 2026-08-27)。
                               * 图标也照稿子补上:那一排三颗都带图标。
                               */
                              <RunErrorCardAction
                                type="button"
                                variant="primary"
                                data-testid="chat-error-retry"
                                onClick={() => {
                                  trackRecoveryClick(retryAssistant, 'manual_retry');
                                  onRetry(retryAssistant, 'manual_retry');
                                }}
                              >
                                <Icon name="refresh" size={11} />
                                {t('promptTemplates.retry')}
                              </RunErrorCardAction>
                            ) : null}
                          </RunErrorCardActionGroup>
                        ) : null}
                      </>
                    )}
                  />
                ) : null}
                {showAmrGuidance && amrSwitchPayload ? (
                  <AmrGuidance
                    {...amrSwitchPayload}
                    sourceDetail="chat_error_switch_retry_card"
                    metricsConsent={config?.telemetry?.metrics === true}
                    onActivate={() => {
                      if (retryAssistant && onSwitchToAmrAndRetry) {
                        trackRecoveryClick(retryAssistant, 'switch_runtime_retry', {
                          agentProviderId: 'amr',
                          modelId: config?.agentModels?.amr?.model?.trim() || 'default',
                        });
                        onSwitchToAmrAndRetry(retryAssistant);
                      } else {
                        onOpenAmrSettings?.();
                      }
                    }}
                  />
                ) : null}
                {/*
                  * 升级卡(交付稿第 75 / 76 格)。**流水里的一张卡,不是弹窗** ——
                  * 产品 2026-08-26 裁决「告警可继续的不弹窗,只有卡片;余额不足再弹窗」。
                  * 它落在最后一轮之后、输入框之前,不挡发送(D4)。
                  * 和 `PlanPill` 不同:那枚是钉在 composer 上方的,这张在流水里随内容滚。
                  */}
                {amrBalanceCardUsd != null ? (
                  <UpgradeCard
                    balanceUsd={amrBalanceCardUsd}
                    onUpgrade={
                      onAmrBalanceUpgrade ?? (() => openAmrPlans('chat_upgrade_card'))
                    }
                  />
                ) : null}
                {/*
                 * 组件 22(重连,第 82–84 格 · S29):产品裁决用设计稿现有的设计,
                 * 位置在**会话中最后一行**。`reconnect` 为空就整行不在 ——
                 * 「恢复后自动消失」是这样成立的,不是靠再画一句「已恢复」。
                 *
                 * run 被用户手动终止时不在这里再画一条暂停状态。它已经由对应
                 * AssistantMessage 的回合 footer 显示「已手动停止」;live 消息与
                 * 历史回放都走同一份 `displayMessages` 渲染路径,尾部重复一行会让
                 * 同一个 terminal status 出现两次。真正的暂停任务形态仍由组件 20
                 * 自己保留,不能拿 run 的 `canceled/user_stop` 冒充。
                 */}
                {reconnect ? (
                  <Reconnect
                    attempt={reconnect.attempt}
                    max={reconnect.max}
                    exhausted={reconnect.exhausted}
                    reason={reconnect.reason}
                    /* 〔重新连接〕只属于传输层那一行:线断了才有东西可重连。
                       daemon 重跑一轮时连接是通的,给一颗「重新连接」既没有对应的
                       动作,也会让用户以为是自己网络的问题。 */
                    onReconnect={reconnect.reason === 'transport' ? onManualReconnect : undefined}
                  />
                ) : null}
                {/* Dynamic spacer: when a turn is anchored to the top, this
                    grows just enough to let the user message reach the top of
                    the viewport, then shrinks as the reply streams in below. */}
                <div className="chat-log-tail-spacer" ref={tailSpacerRef} aria-hidden />
                {/* 正文取词的浮条:只认 chat-log 里的选区(输入框、侧栏的选中不该弹它) */}
                <QuoteBar scopeRef={logRef} onQuote={handleQuote} />
                </div>
                {/* Always mounted so the CSS transition can play in both
                  directions; the `chat-jump-btn-active` class flips the
                  slide + opacity, and `aria-hidden` + `tabIndex={-1}`
                  keep it out of the a11y tree when it's not visible.

                  Keep the affordance available while conversation history is
                  open. A history pick can leave a long transcript at an older
                  reading position, and this is the deterministic way back to
                  the latest turn (OPEND-2420). The history header now owns the
                  higher stacking layer, so its menu occludes the pill only
                  where the two physically overlap instead of deleting the
                  pill's state from the rest of the pane. */}
                <button
                type="button"
                ref={jumpBtnGlassRef}
                className={`chat-jump-btn od-glass-refract${showJumpToLatest ? ' chat-jump-btn-active' : ''}`}
                data-testid="chat-jump-btn"
                onClick={jumpToBottom}
                title={t('chat.scrollToLatest')}
                aria-hidden={!showJumpToLatest}
                tabIndex={showJumpToLatest ? 0 : -1}
                >
                  <Icon name="arrow-up" size={14} style={{ transform: 'rotate(180deg)' }} />
                  <span>{t('chat.jumpToLatest')}</span>
                </button>
                {/* Plan 药丸是滚动区上的浮层,不是输入框前的一行布局。
                  放在 chat-log-wrap 里绝对定位,才不会撑出一条白带；对应的
                  chat-log 底部预留让末尾文案能完整滚到它上方。它与“回到最新”
                  共用唯一浮层位,运行期间由 Plan 优先。 */}
                <PlanPill
                  todos={planPillTodos}
                  running={planPillRunning}
                />
              </div>
              {chatLogTray}
            </div>
            <QueuedSendStrip
              containerRef={queuedSendStripRef}
              items={queuedItems}
              editingId={editingQueuedSendId}
              onEdit={(item) => {
                trackMessageQueueClick(analytics.track, {
                  page_name: 'chat_panel',
                  area: 'message_queue',
                  element: 'edit',
                  project_id: projectId ?? '',
                  queue_length: queuedItems.length,
                });
                restoreQueuedSendToComposer(item);
              }}
              onRemove={onRemoveQueuedSend
                ? (id) => {
                    trackMessageQueueClick(analytics.track, {
                      page_name: 'chat_panel',
                      area: 'message_queue',
                      element: 'delete',
                      project_id: projectId ?? '',
                      queue_length: queuedItems.length,
                    });
                    onRemoveQueuedSend(id);
                  }
                : undefined}
              onReorder={onReorderQueuedSends}
              onSendNow={onSendQueuedNow
                ? (id) => {
                    trackMessageQueueClick(analytics.track, {
                      page_name: 'chat_panel',
                      area: 'message_queue',
                      element: 'send_now',
                      project_id: projectId ?? '',
                      queue_length: queuedItems.length,
                    });
                    onSendQueuedNow(id);
                  }
                : undefined}
              onSteer={onSteerQueuedSend
                ? (item) => {
                    trackMessageQueueClick(analytics.track, {
                      page_name: 'chat_panel',
                      area: 'message_queue',
                      element: 'steer',
                      project_id: projectId ?? '',
                      queue_length: queuedItems.length,
                    });
                    onSteerQueuedSend(item.id);
                  }
                : undefined}
              steerBlockedReason={steerBlockedReason ?? null}
            />
            <div
              className="chat-composer-slot"
              ref={composerSlotRef}
              style={composerSlotStyle}
              aria-hidden={shouldPortalComposer ? true : undefined}
            >
              {shouldPortalComposer ? null : composerNode}
            </div>
            {shouldPortalComposer && composerPortalTarget && composerPortalRect
              ? createPortal(
                  /*
                   * portal 出去的那一层要**自带 `--chat-*` 接缝**。
                   *
                   * 自定义属性按 DOM 树继承,而这一层挂在 `<body>` 下 —— 落在页面
                   * 那个接缝之外,输入框里每一个消费 `--chat-*` 的组件同时失效,
                   * 而且**不报错**:真机上注释芯片的边框、底色、关闭键的圆圈全没了,
                   * 只有 `border-radius: 50%` 活着(它是字面量,不走变量)。
                   * `ChatRoot.tsx` 的注释预言过这条;今天这是第三次
                   * (联系支持弹窗、产物卡浮层、输入框)。
                   */
                  <div
                    {...chatSeam('chat-composer-fixed-layer')}
                    ref={composerLayerRef}
                    style={{
                      left: composerPortalRect.left,
                      bottom: composerPortalRect.bottom,
                      width: composerPortalRect.width,
                    }}
                  >
                    {composerNode}
                  </div>,
                  composerPortalTarget,
                )
              : null}
          </>
        ) : null}
      {/*
        * 联系支持弹窗(交付稿第 80 格)。**压在整个应用上**,不是报错卡里的一块 ——
        * 组件自己走 portal 到 body,所以挂在这里不受聊天区滚动 / 层叠上下文影响。
        * 渠道由调用方给,单一出处在 `chat/support-channels.tsx`。
        */}
      {supportDialogOpen ? (
        <SupportDialog
          channels={supportChannels(t)}
          onClose={() => setSupportDialogOpen(false)}
        />
      ) : null}
    </div>
  );
}

interface AssistantCallbacks {
  onSubmitQuestionForm: QuestionFormSubmitHandler | undefined;
  onContinueRemainingTasks:
    | ((assistantMessage: ChatMessage, todos: TodoItem[]) => void)
    | undefined;
  onAssistantFeedback:
    | ((message: ChatMessage, change: ChatMessageFeedbackChange) => void)
    | undefined;
  onBrandBrowserAssistConfirm: BrandBrowserAssistConfirm | undefined;
  onArtifactShare: ((fileName: string, anchorId?: string) => void) | undefined;
  onForkFromMessage: ((message: ChatMessage) => void) | undefined;
  onShareToOpenDesign: ((assistantMessageId: string) => void) | undefined;
  onNextStepAiOptimize: (() => void) | undefined;
  onNextStepContinueExtraction: (() => void) | undefined;
  onNextStepContinueAiExtraction: (() => void) | undefined;
  onNextStepCreateDesign: (() => void) | undefined;
  onNextStepCreateDesignSystem: (() => void) | undefined;
}

type ChatRailMessage = {
  message: ChatMessage;
  messageIndex: number;
  userIndex: number;
};

function ChatMessageRail({
  messages,
  loading,
  logRef,
  activeConversationKey,
  onNavigate,
  t,
}: {
  messages: ChatMessage[];
  loading: boolean;
  logRef: MutableRefObject<HTMLDivElement | null>;
  activeConversationKey: string;
  onNavigate: (message: ChatMessage, messageIndex: number) => void;
  t: TranslateFn;
}) {
  const railMessages = useMemo<ChatRailMessage[]>(
    () =>
      messages.reduce<ChatRailMessage[]>((items, message, messageIndex) => {
        if (message.role !== 'user') return items;
        items.push({
          message,
          messageIndex,
          userIndex: items.length,
        });
        return items;
      }, []),
    [messages],
  );
  /**
   * 导轨的输入认**内容**,不认数组引用。
   *
   * **不变量:用户消息没有变化时,`userMessages` 必须保持同一个引用。**
   *
   * `messages` 在流式期间每帧都是新数组 —— `updateMessageById` 的
   * `setMessages((curr) => curr.map(...))` 无条件返回新数组,而缓冲文本按
   * `requestAnimationFrame` 提交(见 `ProjectView.tsx` 的 `createBufferedTextUpdates`)。
   * 长在助手那条消息上的正文,和导轨没有半点关系。
   *
   * 直接 `useMemo(..., [messages])` 会把那份每帧换引用的数组喂给下面三条 effect:
   * 「会话复位」那条每帧把活动点写回**第一条**,滚动侦听那条每帧重挂、rAF 里又写成
   * **离滚动位置最近**的那条 —— 两个值不同,`Object.is` 短路不了,活动点每帧来回跳两次。
   * 每一次 passive flush 都排一次新更新,React 的 `nestedPassiveUpdateCount` 因此
   * 永不归零,约 51 帧后报 `Maximum update depth exceeded`(真机 2026-08-28)。
   * 「滚轮」那条还会每帧重发一次 `scrollTo({behavior:'smooth'})`,平滑滚动永远到不了终点。
   *
   * 签名带上 id、正文和它在整条消息流里的下标 —— 导轨读的就是这三样
   * (`onNavigate` 只用 `message.id` 与 `messageIndex`),所以按签名复用旧对象
   * 不会读到过期的东西。
   */
  const railSignature = railMessages
    .map((item) => [item.messageIndex, item.message.id, item.message.content].join('\u0001'))
    .join('\u0002');
  const userMessages = useMemo<ChatRailMessage[]>(
    () => railMessages,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上:刻意只认签名
    [railSignature],
  );
  const [preview, setPreview] = useState<{ id: string; y: number } | null>(null);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  // Picking a message retracts the module until the pointer leaves it, so the
  // jump lands without the rail lingering over the destination.
  const [retracted, setRetracted] = useState(false);
  const navRef = useRef<HTMLElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);

  /*
   * 换会话就把上一段的选择忘掉 —— 判据只有会话本身。
   *
   * `userMessages` 曾经也在依赖里,那是这条 effect 和下面滚动侦听那条抢同一个
   * `activeMessageId` 的原因:新会话的第一条 vs 当前滚动位置最近的一条,
   * 两个值不同,于是每次消息列表换引用就来回改一次。会话没换的时候,
   * 这条 effect 本来就没有事可做。
   */
  useEffect(() => {
    setPreview(null);
    setRetracted(false);
    setActiveMessageId(null);
  }, [activeConversationKey]);

  // Roll the wheel: keep the active dot at the vertical middle of the track
  // viewport, so the dot column scrolls under the top/bottom fade masks as
  // the chat scrolls. The browser clamps the target at both extremes.
  useEffect(() => {
    const track = trackRef.current;
    if (!track || !activeMessageId) return;
    // While the pointer is on the rail the user may be wheel-scrolling it
    // manually; auto-follow would yank their position, so it yields until
    // the pointer leaves.
    if (navRef.current?.matches(':hover')) return;
    const index = userMessages.findIndex(
      (item) => item.message.id === activeMessageId,
    );
    if (index < 0) return;
    // Marker pitch is 11px (8px marker + 3px gap); +4 targets the dot center.
    const top = index * 11 + 4 - track.clientHeight / 2;
    if (typeof track.scrollTo === 'function') {
      track.scrollTo({ top, behavior: 'smooth' });
    } else {
      track.scrollTop = top;
    }
  }, [activeMessageId, userMessages]);

  // The track scrolls, so the preview anchor is measured from the marker's
  // on-screen position at hover time instead of derived from its index.
  const showPreview = (id: string, marker: HTMLElement) => {
    if (retracted) return;
    const nav = navRef.current;
    const y = nav
      ? marker.getBoundingClientRect().top - nav.getBoundingClientRect().top + 4
      : 0;
    setPreview({ id, y });
  };

  useEffect(() => {
    const log = logRef.current;
    if (!log || userMessages.length < CHAT_RAIL_MIN_USER_MESSAGES) return;
    let frame = 0;
    const updateActiveMessage = () => {
      frame = 0;
      const visible = userMessages
        .map((item) => {
          const node = findChatMessageElement(log, item.message.id);
          if (!node) return null;
          return {
            id: item.message.id,
            distance: Math.abs(node.offsetTop - log.scrollTop),
          };
        })
        .filter((item): item is { id: string; distance: number } => item != null)
        .sort((a, b) => a.distance - b.distance)[0];

      if (visible) {
        // 值没变就原地返回:同一个滚动位置在流式期间会被反复重新测量,
        // 每次都排一次重渲会把 React 的嵌套更新计数顶到上限。同 `syncFollowState`。
        setActiveMessageId((prev) => (prev === visible.id ? prev : visible.id));
        return;
      }

      const maxScrollTop = Math.max(1, log.scrollHeight - log.clientHeight);
      const index = Math.round(
        (log.scrollTop / maxScrollTop) * (userMessages.length - 1),
      );
      const boundedIndex = Math.min(
        userMessages.length - 1,
        Math.max(0, index),
      );
      const fallbackId = userMessages[boundedIndex]?.message.id ?? null;
      setActiveMessageId((prev) => (prev === fallbackId ? prev : fallbackId));
    };
    const scheduleUpdate = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(updateActiveMessage);
    };
    scheduleUpdate();
    log.addEventListener('scroll', scheduleUpdate, { passive: true });
    return () => {
      log.removeEventListener('scroll', scheduleUpdate);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [logRef, userMessages]);

  if (loading || userMessages.length < CHAT_RAIL_MIN_USER_MESSAGES) {
    return null;
  }

  const previewItem =
    userMessages.find((item) => item.message.id === preview?.id) ?? null;
  const hoverIndex =
    !retracted && preview
      ? userMessages.findIndex((item) => item.message.id === preview.id)
      : -1;

  return (
    <nav
      ref={navRef}
      className={`chat-message-rail${retracted ? ' is-retracted' : ''}`}
      aria-label={t('chat.messageRail.aria')}
      onMouseLeave={() => {
        setPreview(null);
        setRetracted(false);
      }}
      onWheel={(ev) => {
        // The nav is a full-height hit zone; wheeling over its empty parts
        // (outside the track, which scrolls natively) still rolls the wheel.
        const track = trackRef.current;
        if (!track || track.contains(ev.target as Node)) return;
        track.scrollTop += ev.deltaY;
      }}
      data-wheel={userMessages.length > CHAT_RAIL_WHEEL_MIN_USER_MESSAGES ? 'true' : 'false'}
      data-testid="chat-message-rail"
    >
      <div className="chat-message-rail__track" ref={trackRef}>
        {userMessages.map((item) => {
          const active = item.message.id === activeMessageId;
          const previewing = item.message.id === preview?.id;
          return (
            <button
              key={item.message.id}
              type="button"
              className={[
                'chat-message-rail__marker',
                active ? 'is-active' : '',
                previewing ? 'is-previewing' : '',
              ].filter(Boolean).join(' ')}
              aria-label={t('chat.messageRail.jumpAria', {
                index: item.userIndex + 1,
              })}
              style={{
                '--chat-rail-dash': `${
                  hoverIndex < 0
                    ? CHAT_RAIL_DASH_BASE_PX
                    : chatRailDashWidth(Math.abs(item.userIndex - hoverIndex))
                }px`,
              } as CSSProperties}
              onMouseEnter={(ev) => showPreview(item.message.id, ev.currentTarget)}
              onFocus={(ev) => showPreview(item.message.id, ev.currentTarget)}
              onBlur={() => setPreview(null)}
              onClick={() => {
                setPreview(null);
                setRetracted(true);
                onNavigate(item.message, item.messageIndex);
              }}
            >
              <span aria-hidden />
            </button>
          );
        })}
      </div>
      {/* Sibling of the track, not a child: the track fades its extremes with
          a mask, which must not wash out the hover preview card. */}
      {previewItem && preview ? (
        <div
          className="chat-message-rail__preview"
          style={{
            '--chat-message-rail-y': `${preview.y}px`,
          } as CSSProperties}
          role="tooltip"
        >
          <p>
            {previewItem.message.content.trim() || t('chat.messageRail.empty')}
          </p>
        </div>
      ) : null}
    </nav>
  );
}

function findChatMessageElement(
  log: HTMLElement,
  messageId: string,
): HTMLElement | null {
  const nodes = log.querySelectorAll<HTMLElement>('[data-chat-message-id]');
  for (const node of nodes) {
    if (node.dataset.chatMessageId === messageId) return node;
  }
  return null;
}

function scrollChatLogToMessage(
  log: HTMLElement,
  messages: ChatMessage[],
  messageId: string,
  messageIndex: number,
) {
  const target = findChatMessageElement(log, messageId);
  if (target) {
    target.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    return;
  }

  const maxScrollTop = Math.max(0, log.scrollHeight - log.clientHeight);
  const ratio =
    messages.length <= 1
      ? 0
      : Math.min(1, Math.max(0, messageIndex / (messages.length - 1)));
  log.scrollTo({ top: maxScrollTop * ratio, behavior: 'smooth' });
  window.requestAnimationFrame(() => {
    findChatMessageElement(log, messageId)?.scrollIntoView?.({
      block: 'center',
      behavior: 'smooth',
    });
  });
}

type ChatRenderItem = {
  kind: 'message';
  key: string;
  message: ChatMessage;
};

function ChatConversationLoading({ t }: { t: TranslateFn }) {
  return (
    <div className="chat-loading-state" role="status" aria-live="polite">
      <span className="chat-loading-mark" aria-hidden>
        <span />
        <span />
        <span />
      </span>
      <span className="chat-loading-copy">{t('common.loading')}</span>
      <span className="chat-loading-lines" aria-hidden>
        <span />
        <span />
        <span />
      </span>
    </div>
  );
}

function ChatRows({
  messages,
  streaming,
  onRetryImage,
  projectId,
  projectKindForTracking,
  activeConversationId,
  activeConversationKey,
  projectFiles,
  projectMetadata,
  projectFileNames,
  projectResolvedDir,
  mediaTasksByRunId,
  onRequestOpenFile,
  onRequestPluginDetails,
  onRequestDesignSystemDetails,
  onRequestPluginFolderAgentAction,
  activePluginActionPaths,
  hiddenPluginActionPaths,
  onShareToOpenDesign,
  shareToOpenDesignBusyMessageId,
  forceStreamingMessageIds,
  lastAssistantId,
  activePluginSnapshot,
  activeDesignSystem,
  hasActiveDesignSystem,
  errorCardOwnerId,
  nextUserContentByAssistantId,
  assistantCallbacksRef,
  onBrandBrowserAssistConfirm,
  onArtifactShare,
  onToolboxAction,
  onNextStepPromptAction,
  onNextStepAiOptimize,
  nextStepAiOptimizeBusy,
  onNextStepContinueExtraction,
  nextStepContinueExtractionBusy,
  onNextStepContinueAiExtraction,
  nextStepContinueAiExtractionBusy,
  onNextStepCreateDesign,
  nextStepCreateDesignBusy,
  onNextStepCreateDesignSystem,
  nextStepCreateDesignSystemBusy,
  onPickSkill,
  onNextStepSuggestion,
  onArtifactDownload,
  nextStepSkills,
  nextStepVariant,
  onForkFromMessage,
  onContinueRemainingTasks,
  onAssistantFeedback,
  forkingMessageId,
  t,
  onSubmitQuestionForm,
  questionFormSubmitDisabled,
  scrollContainerRef,
  onVirtualScrollTopWrite,
  highlightedUserMessageId,
}: {
  messages: ChatMessage[];
  /** 生图失败格的「重试」—— 见 ChatPane 的 handleRetryImage(D59) */
  onRetryImage?: (row: { total: number; done: number; failed: number }, index: number) => void;
  streaming: boolean;
  projectId: string | null;
  projectKindForTracking: TrackingProjectKind | null;
  activeConversationId: string | null;
  activeConversationKey: string;
  projectFiles: ProjectFile[];
  projectMetadata?: ProjectMetadata;
  projectFileNames?: Set<string>;
  // Daemon-resolved on-disk working directory of the current project —
  // positive-proof anchor for chat file-link routing (see AssistantMessage).
  projectResolvedDir?: string | null;
  mediaTasksByRunId: Map<string, ProjectMediaTask[]>;
  onRequestOpenFile?: (name: string) => void;
  onRequestPluginDetails?: (pluginId: string) => void;
  onRequestDesignSystemDetails?: (system: DesignSystemSummary) => void;
  onRequestPluginFolderAgentAction?: (relativePath: string, action: PluginFolderAgentAction) => void;
  activePluginActionPaths?: Set<string>;
  hiddenPluginActionPaths?: Set<string>;
  onShareToOpenDesign?: (assistantMessageId: string) => void;
  shareToOpenDesignBusyMessageId?: string | null;
  forceStreamingMessageIds?: Set<string>;
  lastAssistantId: string | undefined;
  activePluginSnapshot?: AppliedPluginSnapshot | null;
  activeDesignSystem?: DesignSystemSummary | null;
  hasActiveDesignSystem: boolean;
  errorCardOwnerId: string | null;
  nextUserContentByAssistantId: Map<string, string>;
  assistantCallbacksRef: MutableRefObject<AssistantCallbacks>;
  onBrandBrowserAssistConfirm?: BrandBrowserAssistConfirm;
  /** `anchorId` 由产物卡那枚胶囊带上:菜单开在它旁边,而不是预览区右上角。 */
  onArtifactShare?: (fileName: string, anchorId?: string) => void;
  onToolboxAction?: (id: DesignToolboxActionId) => void;
  onNextStepPromptAction?: (
    prompt: string,
    options?: { sessionMode?: ChatSessionMode },
  ) => void;
  onNextStepAiOptimize?: () => void;
  nextStepAiOptimizeBusy?: boolean;
  onNextStepContinueExtraction?: () => void;
  nextStepContinueExtractionBusy?: boolean;
  onNextStepContinueAiExtraction?: () => void;
  nextStepContinueAiExtractionBusy?: boolean;
  onNextStepCreateDesign?: () => void;
  nextStepCreateDesignBusy?: boolean;
  onNextStepCreateDesignSystem?: () => void;
  nextStepCreateDesignSystemBusy?: boolean;
  onPickSkill?: (skillId: string) => void;
  /** 把一条「下一步引导」填入 Composer,等用户确认后发送 */
  onNextStepSuggestion?: (text: string) => void;
  /** `anchorId` 同上。 */
  onArtifactDownload?: (fileName: string, anchorId?: string) => void;
  nextStepSkills?: SkillSummary[];
  nextStepVariant?: NextStepActionsVariant;
  onForkFromMessage?: (message: ChatMessage) => void;
  onContinueRemainingTasks?: (
    assistantMessage: ChatMessage,
    todos: TodoItem[],
  ) => boolean | void | Promise<boolean | void>;
  onAssistantFeedback?: (message: ChatMessage, change: ChatMessageFeedbackChange) => void;
  forkingMessageId?: string | null;
  t: TranslateFn;
  onSubmitQuestionForm?: QuestionFormSubmitHandler;
  questionFormSubmitDisabled: boolean;
  scrollContainerRef: MutableRefObject<HTMLDivElement | null>;
  onVirtualScrollTopWrite: (element: HTMLDivElement, top: number) => void;
  highlightedUserMessageId?: string | null;
}) {
  const items = useMemo(
    () => buildChatRenderItems(messages),
    [messages],
  );
  /**
   * 每条助手消息「在它之前这场对话已经宣布过的那份清单」。
   *
   * 只有这一层拿得到别的轮次 —— `AssistantMessage` 只认识自己那一条消息,所以
   * 跨轮召回的判定材料必须在这里算好递下去。它**不控制显示**:本轮清单里没有同名条目
   * 时它一次都不会被查到(`build-turn-blocks` 的 `previous.has`),agent 不重发
   * 就天然什么都不出。
   */
  const previousTodosByMessageId = useMemo(
    () => previousTodosByAssistantMessageId(messages),
    [messages],
  );
  const assistantRoleByMessageId = useMemo(() => {
    const byMessageId = new Map<string, boolean>();
    let previousAssistantIdentity: string | null = null;

    for (const message of messages) {
      if (message.role !== 'assistant') {
        previousAssistantIdentity = null;
        continue;
      }
      const identity = message.agentId ?? message.agentName ?? 'assistant';
      byMessageId.set(message.id, identity !== previousAssistantIdentity);
      previousAssistantIdentity = identity;
    }
    return byMessageId;
  }, [messages]);
  const virtualized = items.length > CHAT_MESSAGE_VIRTUALIZE_THRESHOLD;
  const virtualWindow = useMeasuredVirtualWindow(items, {
    enabled: virtualized,
    containerRef: scrollContainerRef,
    estimateSize: estimateChatRenderItemHeight,
    overscanPx: CHAT_MESSAGE_OVERSCAN_PX,
    resetKey: activeConversationKey,
    initialTailRows: CHAT_VIRTUAL_INITIAL_TAIL_ROWS,
    onScrollTopWrite: onVirtualScrollTopWrite,
  });

  const renderItem = (item: ChatRenderItem) => {
    const m = item.message;
    const messageStreaming = isAssistantMessageStreaming(
      m,
      streaming,
      lastAssistantId,
      forceStreamingMessageIds,
    );
    if (m.role === 'user') {
      return (
        <UserMessage
          message={m}
          projectId={projectId}
          projectFileNames={projectFileNames}
          onRequestOpenFile={onRequestOpenFile}
          t={t}
          highlighted={highlightedUserMessageId === m.id}
        />
      );
    }
    return (
      <AssistantMessage
        message={m}
        streaming={messageStreaming}
        projectId={projectId}
        projectKind={projectKindForTracking}
        conversationId={activeConversationId}
        projectFiles={projectFiles}
        projectMetadata={projectMetadata}
        projectFileNames={projectFileNames}
        projectResolvedDir={projectResolvedDir}
        mediaTasks={m.runId ? mediaTasksByRunId.get(m.runId) : undefined}
        onRequestOpenFile={onRequestOpenFile}
        onRetryImage={onRetryImage}
        onRequestPluginFolderAgentAction={onRequestPluginFolderAgentAction}
        activePluginActionPaths={activePluginActionPaths}
        hiddenPluginActionPaths={hiddenPluginActionPaths}
        onShareToOpenDesign={
          onShareToOpenDesign
            ? () => assistantCallbacksRef.current.onShareToOpenDesign?.(m.id)
            : undefined
        }
        shareToOpenDesignBusy={shareToOpenDesignBusyMessageId === m.id}
        showRole={assistantRoleByMessageId.get(m.id) ?? true}
        isLast={m.id === lastAssistantId}
        errorCardOwnerId={errorCardOwnerId}
        nextUserContent={nextUserContentByAssistantId.get(m.id)}
        previousTodos={previousTodosByMessageId.get(m.id)}
        onContinueRemainingTasks={
          onContinueRemainingTasks
            ? (todos) => assistantCallbacksRef.current.onContinueRemainingTasks?.(m, todos)
            : undefined
        }
        suppressDirectionForms={hasActiveDesignSystem}
        hasDesignSystemContext={hasActiveDesignSystem || !!activeDesignSystem}
        onSubmitQuestionForm={
          onSubmitQuestionForm
            ? (text, attachments, context, _sourceAssistantMessageId, formId) =>
                assistantCallbacksRef.current.onSubmitQuestionForm?.(
                  text,
                  attachments,
                  context,
                  m.id,
                  formId,
                )
            : undefined
        }
        questionFormSubmitDisabled={questionFormSubmitDisabled}
        onBrandBrowserAssistConfirm={
          onBrandBrowserAssistConfirm
            ? (card) => assistantCallbacksRef.current.onBrandBrowserAssistConfirm?.(card)
            : undefined
        }
        onForkFromMessage={
          onForkFromMessage
            ? () => assistantCallbacksRef.current.onForkFromMessage?.(m)
            : undefined
        }
        forking={forkingMessageId === m.id}
        onFeedback={
          onAssistantFeedback
            ? (rating) => assistantCallbacksRef.current.onAssistantFeedback?.(m, rating)
            : undefined
        }
        onArtifactShare={
          onArtifactShare
            ? (fileName, anchorId) => assistantCallbacksRef.current.onArtifactShare?.(fileName, anchorId)
            : undefined
        }
        onToolboxAction={onToolboxAction}
        onNextStepPromptAction={onNextStepPromptAction}
        onNextStepAiOptimize={
          onNextStepAiOptimize
            ? () => assistantCallbacksRef.current.onNextStepAiOptimize?.()
            : undefined
        }
        nextStepAiOptimizeBusy={nextStepAiOptimizeBusy}
        onNextStepContinueExtraction={
          onNextStepContinueExtraction
            ? () => assistantCallbacksRef.current.onNextStepContinueExtraction?.()
            : undefined
        }
        nextStepContinueExtractionBusy={nextStepContinueExtractionBusy}
        onNextStepContinueAiExtraction={
          onNextStepContinueAiExtraction
            ? () => assistantCallbacksRef.current.onNextStepContinueAiExtraction?.()
            : undefined
        }
        nextStepContinueAiExtractionBusy={nextStepContinueAiExtractionBusy}
        onNextStepCreateDesign={
          onNextStepCreateDesign
            ? () => assistantCallbacksRef.current.onNextStepCreateDesign?.()
            : undefined
        }
        nextStepCreateDesignBusy={nextStepCreateDesignBusy}
        onNextStepCreateDesignSystem={
          onNextStepCreateDesignSystem
            ? () => assistantCallbacksRef.current.onNextStepCreateDesignSystem?.()
            : undefined
        }
        nextStepCreateDesignSystemBusy={nextStepCreateDesignSystemBusy}
        onPickSkill={onPickSkill}
        onNextStepSuggestion={onNextStepSuggestion}
        onArtifactDownload={onArtifactDownload}
        nextStepSkills={nextStepSkills}
        nextStepVariant={nextStepVariant}
      />
    );
  };

  if (items.length === 0) return null;

  if (!virtualized) {
    return (
      <>
        {items.map((item) => (
          <Fragment key={item.key}>{renderItem(item)}</Fragment>
        ))}
      </>
    );
  }

  return (
    <div
      className="chat-virtual-spacer"
      data-testid="chat-virtual-spacer"
      style={{ height: virtualWindow.totalHeight }}
    >
      {virtualWindow.rows.map((row) => (
        <VirtualChatRow
          key={row.item.key}
          itemKey={row.item.key}
          top={row.top}
          onMeasure={virtualWindow.onMeasure}
        >
          {renderItem(row.item)}
        </VirtualChatRow>
      ))}
    </div>
  );
}

function VirtualChatRow({
  itemKey,
  top,
  onMeasure,
  children,
}: {
  itemKey: string;
  top: number;
  onMeasure: (key: string, height: number) => void;
  children: ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = rowRef.current;
    if (!node) return;
    const measure = () => {
      const height = node.getBoundingClientRect().height;
      onMeasure(itemKey, height);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [itemKey, onMeasure]);

  return (
    <div
      ref={rowRef}
      className="chat-virtual-row"
      style={{ transform: `translateY(${top}px)` }}
    >
      {children}
    </div>
  );
}

function buildChatRenderItems(messages: ChatMessage[]): ChatRenderItem[] {
  const items: ChatRenderItem[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    // Structured form answers are rendered as a compact summary on the
    // preceding assistant message. Keeping the raw machine payload in a
    // separate user bubble duplicates the same decision and exposes stable IDs.
    if (message.role === 'user' && /^\[form answers\b/i.test(message.content.trim())) {
      continue;
    }
    items.push({
      kind: 'message',
      key: `message:${message.id}`,
      message,
    });
  }
  return items;
}

function estimateChatRenderItemHeight(item: ChatRenderItem): number {
  const message = item.message;
  const contentLength = message.content?.length ?? 0;
  const attachmentCount = (message.attachments?.length ?? 0) + (message.commentAttachments?.length ?? 0);
  const eventCount = message.events?.length ?? 0;
  const fileCount = message.producedFiles?.length ?? 0;
  const base = message.role === 'user' ? 82 : 118;
  const contentRows = Math.min(18, Math.ceil(contentLength / 120));
  return (
    base
    + contentRows * 18
    + attachmentCount * 34
    + eventCount * 28
    + fileCount * 32
    + CHAT_VIRTUAL_ROW_GAP_PX
  );
}

function useMeasuredVirtualWindow<T extends { key: string }>(
  items: T[],
  {
    enabled,
    containerRef,
    estimateSize,
    overscanPx,
    resetKey,
    initialTailRows,
    alwaysIncludeKey,
    onScrollTopWrite,
  }: {
    enabled: boolean;
    containerRef: MutableRefObject<HTMLDivElement | null>;
    estimateSize: (item: T) => number;
    overscanPx: number;
    resetKey: string;
    initialTailRows: number;
    alwaysIncludeKey?: string;
    onScrollTopWrite?: (element: HTMLDivElement, top: number) => void;
  },
) {
  const measuredHeightsRef = useRef<Map<string, number>>(new Map());
  const pendingAnchorRef = useRef<{ anchor: VirtualScrollAnchor; resetKey: string } | null>(null);
  const resetKeyRef = useRef(resetKey);
  const scrollTopWriterRef = useRef(onScrollTopWrite);
  resetKeyRef.current = resetKey;
  scrollTopWriterRef.current = onScrollTopWrite;
  const [measureVersion, setMeasureVersion] = useState(0);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });

  useEffect(() => {
    pendingAnchorRef.current = null;
    measuredHeightsRef.current.clear();
    setMeasureVersion((version) => version + 1);
    setViewport({ scrollTop: 0, height: 0 });
  }, [resetKey]);

  useEffect(() => {
    if (!enabled) return undefined;
    const el = containerRef.current;
    if (!el) return undefined;
    let frame: number | null = null;
    const readViewport = () => {
      frame = null;
      setViewport((current) => {
        const next = {
          scrollTop: el.scrollTop,
          height: el.clientHeight || CHAT_VIRTUAL_DEFAULT_VIEWPORT_PX,
        };
        return current.scrollTop === next.scrollTop && current.height === next.height
          ? current
          : next;
      });
    };
    const scheduleRead = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(readViewport);
    };
    scheduleRead();
    el.addEventListener('scroll', scheduleRead, { passive: true });
    const observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(scheduleRead)
        : null;
    observer?.observe(el);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      el.removeEventListener('scroll', scheduleRead);
      observer?.disconnect();
    };
  }, [containerRef, enabled]);

  const layout = useMemo(() => {
    const offsets: number[] = [];
    const sizes: number[] = [];
    let cursor = 0;
    for (const item of items) {
      offsets.push(cursor);
      const measured = measuredHeightsRef.current.get(item.key);
      const size = Math.max(
        CHAT_VIRTUAL_MIN_ROW_HEIGHT,
        measured ?? estimateSize(item),
      );
      sizes.push(size);
      cursor += size;
    }
    return { offsets, sizes, totalHeight: cursor };
  }, [estimateSize, items, measureVersion]);

  const virtualLayoutRef = useRef({ items, offsets: layout.offsets, sizes: layout.sizes });
  virtualLayoutRef.current = { items, offsets: layout.offsets, sizes: layout.sizes };

  useLayoutEffect(() => {
    const pending = pendingAnchorRef.current;
    if (!pending) return;
    pendingAnchorRef.current = null;
    if (!enabled || pending.resetKey !== resetKey) return;
    const element = containerRef.current;
    if (!element) return;
    const nextTop = scrollTopForVirtualScrollAnchor(
      pending.anchor,
      items,
      layout.offsets,
      Math.max(0, element.scrollHeight - element.clientHeight),
    );
    if (nextTop === null || Math.abs(nextTop - element.scrollTop) < 0.5) return;
    const writer = scrollTopWriterRef.current;
    if (writer) writer(element, nextTop);
    else element.scrollTop = nextTop;
    const actualScrollTop = element.scrollTop;
    setViewport((current) => current.scrollTop === actualScrollTop
      ? current
      : { ...current, scrollTop: actualScrollTop });
  }, [containerRef, enabled, items, layout.offsets, resetKey]);

  const rows = useMemo(() => {
    if (!enabled || items.length === 0) return [];
    const height = viewport.height || CHAT_VIRTUAL_DEFAULT_VIEWPORT_PX;
    if (viewport.scrollTop === 0 && viewport.height === 0) {
      const start = Math.max(0, items.length - initialTailRows);
      const rows = items.slice(start).map((item, offset) => {
        const index = start + offset;
        return { item, index, top: layout.offsets[index] ?? 0 };
      });
      return includeVirtualRowByKey(rows, items, layout.offsets, alwaysIncludeKey);
    }
    const startTarget = Math.max(0, viewport.scrollTop - overscanPx);
    const endTarget = viewport.scrollTop + height + overscanPx;
    let start = 0;
    while (
      start < items.length - 1
      && (layout.offsets[start] ?? 0) + (layout.sizes[start] ?? 0) < startTarget
    ) {
      start += 1;
    }
    let end = start;
    while (end < items.length && (layout.offsets[end] ?? 0) <= endTarget) {
      end += 1;
    }
    const rows = items.slice(start, end).map((item, offset) => {
      const index = start + offset;
      return { item, index, top: layout.offsets[index] ?? 0 };
    });
    return includeVirtualRowByKey(rows, items, layout.offsets, alwaysIncludeKey);
  }, [
    alwaysIncludeKey,
    enabled,
    initialTailRows,
    items,
    layout.offsets,
    layout.sizes,
    overscanPx,
    viewport.height,
    viewport.scrollTop,
  ]);

  const onMeasure = useCallback((key: string, height: number) => {
    if (!Number.isFinite(height) || height <= 0) return;
    const next = Math.max(CHAT_VIRTUAL_MIN_ROW_HEIGHT, Math.ceil(height));
    const previous = measuredHeightsRef.current.get(key);
    if (previous !== undefined && Math.abs(previous - next) < 2) return;
    const element = containerRef.current;
    if (element && !pendingAnchorRef.current) {
      const currentLayout = virtualLayoutRef.current;
      const anchor = captureVirtualScrollAnchor(
        currentLayout.items,
        currentLayout.offsets,
        currentLayout.sizes,
        element.scrollTop,
      );
      if (anchor) pendingAnchorRef.current = { anchor, resetKey: resetKeyRef.current };
    }
    measuredHeightsRef.current.set(key, next);
    setMeasureVersion((version) => version + 1);
  }, [containerRef]);

  return {
    rows,
    totalHeight: layout.totalHeight,
    onMeasure,
  };
}

function includeVirtualRowByKey<T extends { key: string }>(
  rows: Array<{ item: T; index: number; top: number }>,
  items: T[],
  offsets: number[],
  key: string | undefined,
): Array<{ item: T; index: number; top: number }> {
  if (!key || rows.some((row) => row.item.key === key)) return rows;
  const index = items.findIndex((item) => item.key === key);
  if (index === -1) return rows;
  return [
    ...rows,
    {
      item: items[index]!,
      index,
      top: offsets[index] ?? 0,
    },
  ].sort((a, b) => a.index - b.index);
}

// NOTE(sync/main): origin/main's `PinnedTodoSlot` is deliberately NOT carried over.
// This branch retired the pinned-todo slot; the conversation-level plan pill
// (`planPillTodos` above, rendered by `chat/PlanPill`) took its place, and it
// reads the same TodoWrite snapshot through `latestTodoWriteInputFromMessages`.
// main's fix inside that component (`continuableUnfinishedTodos`, so a settled
// strategy verdict outranks a stale snapshot) still lands via AssistantMessage.tsx.
  function readContinuedTodoSnapshotKey(storageKey: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

function writeContinuedTodoSnapshotKey(storageKey: string, snapshotKey: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(storageKey, snapshotKey);
  } catch {
    // sessionStorage may be unavailable in sandboxed or privacy-restricted contexts.
  }
}

  /** 导出只为验收:镜像陈列页(`tests/components/chat/mirror-gallery.test.tsx`)要单挂
   *  这一条队列去对第 72–74 格。产品里仍旧只有 `ChatPane` 一个消费方。 */
  export function QueuedSendStrip({
  containerRef,
  editingId,
  items,
  onEdit,
  onRemove,
  onReorder,
  onSendNow,
  onSteer,
  steerBlockedReason,
}: {
  containerRef?: MutableRefObject<HTMLDivElement | null>;
  editingId?: string | null;
  items: QueuedSendItem[];
  onEdit?: (item: QueuedSendItem) => void;
  onRemove?: (id: string) => void;
  onReorder?: (orderedIds: string[]) => void;
  onSendNow?: (id: string) => void;
  /**
   * B11 「引导对话」. Present ONLY when steering can actually happen right now:
   * a live run on this conversation whose agent keeps reading stdin mid-turn.
   * The parent owns that judgement — the strip must never infer it, or the
   * button ends up promising something the runtime cannot do.
   */
  onSteer?: (item: QueuedSendItem) => void;
  /** Human-readable reason steering is unavailable, shown on the fallback button. */
  steerBlockedReason?: string | null;
}) {
  const t = useT();
  const [dragState, setDragState] = useState<QueuedSendDragState | null>(null);
  if (items.length === 0) return null;
  const canReorder = Boolean(onReorder && items.length > 1);

  const handleDragStart = (
    event: ReactDragEvent<HTMLButtonElement>,
    item: QueuedSendItem,
  ) => {
    if (!canReorder) return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(QUEUED_SEND_DRAG_MIME, item.id);
    event.dataTransfer.setData('text/plain', item.id);
    setDragState({ draggingId: item.id, overId: item.id, edge: null });
  };

  const handleDragOver = (
    event: ReactDragEvent<HTMLDivElement>,
    targetId: string,
  ) => {
    if (!canReorder) return;
    const draggingId = dragState?.draggingId || event.dataTransfer.getData(QUEUED_SEND_DRAG_MIME);
    if (!draggingId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (draggingId === targetId) {
      if (dragState?.overId !== targetId || dragState.edge !== null) {
        setDragState({ draggingId, overId: targetId, edge: null });
      }
      return;
    }
    const edge = queuedDropEdgeForEvent(event);
    if (
      dragState?.draggingId !== draggingId
      || dragState.overId !== targetId
      || dragState.edge !== edge
    ) {
      setDragState({ draggingId, overId: targetId, edge });
    }
  };

  const handleDrop = (
    event: ReactDragEvent<HTMLDivElement>,
    targetId: string,
  ) => {
    if (!canReorder) return;
    event.preventDefault();
    const draggingId =
      dragState?.draggingId
      || event.dataTransfer.getData(QUEUED_SEND_DRAG_MIME)
      || event.dataTransfer.getData('text/plain');
    if (!draggingId || draggingId === targetId) {
      setDragState(null);
      return;
    }
    const edge = dragState?.overId === targetId && dragState.edge
      ? dragState.edge
      : queuedDropEdgeForEvent(event);
    const nextIds = reorderQueuedSendIds(items, draggingId, targetId, edge);
    if (nextIds.join('\0') !== items.map((item) => item.id).join('\0')) {
      onReorder?.(nextIds);
    }
    setDragState(null);
  };

  return (
    <div
      ref={containerRef}
      className="chat-queued-send-strip"
      data-testid="chat-queued-send-strip"
      onDragLeave={(event) => {
        const related = event.relatedTarget;
        if (related instanceof Node && event.currentTarget.contains(related)) return;
        setDragState(null);
      }}
    >
      {/* 稿子没有卡头:队列就贴在输入框底下,是什么一目了然,不用再单起一行说「排队中 · N 条」 */}
      <div className="chat-queued-send-list">
        {items.map((item, index) => {
          const isDragging = dragState?.draggingId === item.id;
          const dropClass = dragState?.overId === item.id
            && dragState.draggingId !== item.id
            && dragState.edge
            ? ` chat-queued-send-row-drop-${dragState.edge}`
            : '';
          return (
            <div
              className={`chat-queued-send-row${index === 0 ? ' chat-queued-send-row-active' : ''}${
                editingId === item.id ? ' chat-queued-send-row-editing' : ''
              }${isDragging ? ' chat-queued-send-row-dragging' : ''}${dropClass}`}
              data-testid="chat-queued-send-row"
              key={item.id}
              onDragOver={(event) => handleDragOver(event, item.id)}
              onDrop={(event) => handleDrop(event, item.id)}
            >
              {/* 稿子这一行是 `grip → ix → tx → qops`:**拖动手柄在最左**,序号跟在它右边。
                  原来这两个是反的(序号在最左),整行的起手就和稿子对不上。 */}
              <button
                type="button"
                className="chat-queued-send-drag-handle chat-queued-send-tooltip od-tooltip"
                title={t('chat.queuedReorder')}
                data-tooltip={t('chat.queuedReorder')}
                data-tooltip-placement="right"
                aria-label={t('chat.queuedReorder')}
                draggable={canReorder}
                disabled={!canReorder}
                onDragStart={(event) => handleDragStart(event, item)}
                onDragEnd={() => setDragState(null)}
              >
                <Icon name="grip-vertical" size={14} />
              </button>
              {/* 序号:出队后重排是数组下标的自然结果,不用另外维护 */}
              <span className="chat-queued-send-index" data-testid="chat-queued-send-index" aria-hidden>{index + 1}</span>
              <div className="chat-queued-send-main">
                <span className="chat-queued-send-title">{summarizeQueuedPrompt(item, t)}</span>
              </div>
              {/* 稿子这一组是 `编辑 → 移除 → 第三颗`,而且「编辑」用的是**魔杖**不是铅笔。
                  原来我们排的是 编辑 → 立即发送 → 移除,三枚图形和顺序全和稿子对不上。 */}
              <div className="chat-queued-send-actions">
                {onEdit ? (
                  <button
                    type="button"
                    className="chat-queued-send-action chat-queued-send-tooltip od-tooltip"
                    title={t('chat.queuedEdit')}
                    data-tooltip={t('chat.queuedEdit')}
                    data-tooltip-placement="top"
                    aria-label={t('chat.queuedEdit')}
                    onClick={() => onEdit(item)}
                  >
                    <Icon name="magic" size={13} />
                  </button>
                ) : null}
                {onRemove ? (
                  <button
                    type="button"
                    className="chat-queued-send-action chat-queued-send-tooltip od-tooltip"
                    onClick={() => onRemove(item.id)}
                    title={t('chat.comments.remove')}
                    data-tooltip={t('chat.comments.remove')}
                    data-tooltip-placement="top"
                    aria-label={t('chat.comments.remove')}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                ) : null}
                {/* 第三颗 —— 稿子标的是「引导对话」:把这条塞进**正在跑**的那一轮
                    (B11)。它和「立即发送」是两件事:引导不打断,当前这一轮的活儿
                    全留着;立即发送要先停掉再发。

                    所以这颗按谁真的能干活来决定,不靠名字撑场面:
                      · `onSteer` 有值 = 此刻真能引导(有在跑的一轮,且这个 agent 的
                        CLI 中途还在读 stdin) → 就是「引导对话」。
                      · 没有 → 退回今天的「立即发送」,**连名字一起退回去**,并把
                        `steerBlockedReason`(比如「当前 agent 不支持中途插话」)
                        挂进 tooltip,让人知道为什么这颗不是引导。 */}
                {steerableRow(item, Boolean(onSteer)) ? (
                  <button
                    type="button"
                    className="chat-queued-send-action chat-queued-send-tooltip od-tooltip"
                    title={t('chat.queuedSteer')}
                    data-tooltip={t('chat.queuedSteer')}
                    data-tooltip-placement="top"
                    aria-label={t('chat.queuedSteer')}
                    data-testid="chat-queued-send-steer"
                    onClick={() => onSteer?.(item)}
                  >
                    <Icon name="arrow-up" size={13} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="chat-queued-send-action chat-queued-send-tooltip od-tooltip"
                    title={rowSteerBlockedReason(item, Boolean(onSteer), steerBlockedReason, t)}
                    data-tooltip={rowSteerBlockedReason(item, Boolean(onSteer), steerBlockedReason, t)}
                    data-tooltip-placement="top"
                    aria-label={t('chat.send')}
                    data-testid="chat-queued-send-now"
                    onClick={() => onSendNow?.(item.id)}
                    disabled={!onSendNow}
                  >
                    <Icon name="arrow-up" size={13} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * B11 「引导对话」 per row.
 *
 * A steering message travels as one text frame on the agent's stdin — there is
 * no channel for attachments or annotation context in it. A row that carries
 * either would arrive at the model stripped of exactly the part that made it
 * meaningful, so that row keeps the honest fallback (「立即发送」) instead of a
 * button promising something the transport cannot deliver.
 */
function steerableRow(item: QueuedSendItem, stripCanSteer: boolean): boolean {
  if (!stripCanSteer) return false;
  return (item.attachments?.length ?? 0) === 0
    && (item.commentAttachments?.length ?? 0) === 0;
}

/** Tooltip for the fallback button: say WHY this row is not 引导对话. */
function rowSteerBlockedReason(
  item: QueuedSendItem,
  stripCanSteer: boolean,
  stripReason: string | null | undefined,
  t: TranslateFn,
): string {
  if (stripCanSteer) return t('chat.queuedSteerTextOnly');
  return stripReason ?? t('chat.send');
}

  const QUEUED_SEND_DRAG_MIME = 'application/x-open-design-queued-send';

type QueuedSendDropEdge = 'before' | 'after';

interface QueuedSendDragState {
  draggingId: string;
  overId: string | null;
  edge: QueuedSendDropEdge | null;
}

function queuedDropEdgeForEvent(event: ReactDragEvent<HTMLElement>): QueuedSendDropEdge {
  const rect = event.currentTarget.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}

function reorderQueuedSendIds(
  items: QueuedSendItem[],
  draggingId: string,
  targetId: string,
  edge: QueuedSendDropEdge,
): string[] {
  const ids = items.map((item) => item.id);
  const from = ids.indexOf(draggingId);
  if (from < 0) return ids;
  const [draggedId] = ids.splice(from, 1);
  const targetIndex = ids.indexOf(targetId);
  if (targetIndex < 0 || !draggedId) return items.map((item) => item.id);
  ids.splice(edge === 'after' ? targetIndex + 1 : targetIndex, 0, draggedId);
  return ids;
}

  /**
   * 队列里每条显示的文字。**不在这里截断** —— 截成一行会把话切在半截,
   * 人就认不出要取消 / 调序的是哪一条(稿子给了两行,用 CSS 的 line-clamp 收)。
   */
  function summarizeQueuedPrompt(item: QueuedSendItem, t: TranslateFn): string {
  return item.prompt.replace(/\s+/g, ' ').trim() || t('chat.queuedFollowUpFallback');
  }

function CommentsPanel({
  comments,
  attachedComments,
  onAttach,
  onDetach,
  onDelete,
  t,
}: {
  comments: PreviewComment[];
  attachedComments: PreviewComment[];
  onAttach?: (comment: PreviewComment) => void;
  onDetach?: (commentId: string) => void;
  onDelete?: (commentId: string) => void;
  t: TranslateFn;
}) {
  const attachedIds = new Set(attachedComments.map((comment) => comment.id));
  const saved = comments.filter((comment) => !attachedIds.has(comment.id));
  return (
    <div className="comments-panel" data-testid="comments-panel">
      <CommentSection
        title={t('chat.comments.attached')}
        empty={t('chat.comments.emptyAttached')}
        comments={attachedComments}
        actionLabel={t('chat.comments.remove')}
        onAction={(comment) => onDetach?.(comment.id)}
        attached
      />
      <CommentSection
        title={t('chat.comments.saved')}
        empty={t('chat.comments.emptySaved')}
        comments={saved}
        actionLabel={t('chat.comments.add')}
        onAction={(comment) => onAttach?.(comment)}
        secondaryActionLabel={t('chat.comments.remove')}
        onSecondaryAction={(comment) => onDelete?.(comment.id)}
      />
      {saved.length > 0 ? (
        <div className="comments-footer">
          <button
            type="button"
            className="primary"
            onClick={() => saved.forEach((comment) => onAttach?.(comment))}
          >
            {t('chat.comments.addAll')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function CommentSection({
  title,
  empty,
  comments,
  actionLabel,
  onAction,
  secondaryActionLabel,
  onSecondaryAction,
  attached,
}: {
  title: string;
  empty: string;
  comments: PreviewComment[];
  actionLabel: string;
  onAction: (comment: PreviewComment) => void;
  secondaryActionLabel?: string;
  onSecondaryAction?: (comment: PreviewComment) => void;
  attached?: boolean;
}) {
  return (
    <section className="comments-section">
      <h3>{title}</h3>
      {comments.length === 0 ? (
        <p className="comments-empty">{empty}</p>
      ) : (
        comments.map((comment) => (
          <article
            key={comment.id}
            className={`comment-card${attached ? ' attached' : ''}`}
            data-testid={`comment-card-${comment.elementId}`}
          >
            <div className="comment-card-top">
              <strong>{commentTargetDisplayName(comment)}</strong>
              <div className="comment-card-actions">
                {secondaryActionLabel && onSecondaryAction ? (
                  <button
                    type="button"
                    className="comment-card-action danger"
                    onClick={() => onSecondaryAction(comment)}
                  >
                    {secondaryActionLabel}
                  </button>
                ) : null}
                <button type="button" className="comment-card-action" onClick={() => onAction(comment)}>
                  {actionLabel}
                </button>
              </div>
            </div>
            <p>{comment.note}</p>
            <div className="comment-card-meta">
              <span>{comment.id}</span>
              <span>{comment.filePath}</span>
              <span>{commentTargetDisplayName(comment)}</span>
              <span>{simplePositionLabel(comment.position)}</span>
            </div>
          </article>
        ))
      )}
    </section>
  );
}

function isActiveRunStatus(status: ChatMessage['runStatus']): boolean {
  return status === 'queued' || status === 'running';
}

function isTerminalRunStatus(status: ChatMessage['runStatus']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled';
}

export function retryableAssistantMessage(
  messages: ChatMessage[],
  lastAssistantId: string | null | undefined,
  paneStreaming: boolean,
): ChatMessage | null {
  if (paneStreaming) return null;
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return null;
  if (last.id !== lastAssistantId) return null;
  return isRetryableAssistantTerminalFailure(last) ? last : null;
}

function isRecoveredAssistantRunError(
  messages: ChatMessage[],
  error: string | null,
  sourceAssistantId: string | null | undefined,
): boolean {
  const target = error?.trim();
  if (!target || !sourceAssistantId) return false;
  const sourceIndex = messages.findIndex(
    (message) =>
      message.role === 'assistant' && message.id === sourceAssistantId,
  );
  if (sourceIndex < 0) return false;
  const source = messages[sourceIndex]!;
  const ownsPersistedError = (source.events ?? []).some(
    (event) =>
      event.kind === 'status' &&
      event.label === 'error' &&
      event.detail?.trim() === target,
  );
  if (!ownsPersistedError) return false;
  // 这一轮**自己**跑通了 —— 那么它中途报的那句就不是终态,是被自愈掉的一次尝试。
  //
  // daemon 对可自愈的失败会**在同一个 runId 里**重开一次子进程
  // (`run-retry-policy.ts` 的 `same_run_transient`:AMR 建会话超时就在这个集合里)。
  // 第一次尝试的 error 帧照样发出来,SSE 也可能就断在那一帧上;客户端那时还不知道
  // 后面会重试成功,于是把原文落到了面板级的 `error`。等重试跑完,消息被改回
  // `succeeded`,可那条 `error` 从来没人撤 —— 一张「任务失败」的卡就挂在一次
  // 成功的运行下面,卡面上还摊着本机端口和项目路径。
  //
  // `runStatus === 'succeeded'` 是 daemon 对这一个 run 的终态裁定(SSE `end` 或
  // `/api/runs/:id` 显式声明的那个),所以它一票否决同一轮里更早的那句报错。
  if (source.runStatus === 'succeeded') return true;
  return messages.slice(sourceIndex + 1).some(
    (message) => message.role === 'assistant' && message.runStatus === 'succeeded',
  );
}

export function isAssistantMessageStreaming(
  message: ChatMessage,
  paneStreaming: boolean,
  lastAssistantId: string | null | undefined,
  forceStreamingMessageIds?: Set<string>,
): boolean {
  if (message.role !== 'assistant') return false;
  if (isTerminalRunStatus(message.runStatus)) return false;
  if (forceStreamingMessageIds?.has(message.id)) return true;
  if (isActiveRunStatus(message.runStatus)) return true;
  if (message.id !== lastAssistantId) return false;
  if (!paneStreaming) return false;
  if (message.endedAt !== undefined) return false;
  return true;
}

export function buildRunErrorDiagnosticText(input: RunErrorDiagnosticInput): string {
  const lines: string[] = [];
  const sourceText = input.rawMessage?.trim() || input.message.trim();
  if (sourceText) {
    lines.push(sourceText, '');
  }

  // The captured agent output goes above the id block: it is the answer to
  // "why did this fail", the ids are only what a support thread needs to look
  // the run up. Omitted entirely when the run wrote nothing — an empty
  // labelled section reads as "there is no more information here", which is a
  // different (and wrong) claim than saying nothing at all.
  const stderrTail = input.stderrTail?.trim();
  if (stderrTail) {
    lines.push('agent_stderr_tail:', stderrTail, '');
  }

  lines.push(
    'OpenDesign run error diagnostics',
    `trace_id: ${input.traceId ?? 'n/a'}`,
    `run_id: ${input.traceId ?? 'n/a'}`,
    `error_code: ${input.errorCode ?? 'n/a'}`,
    `project_id: ${input.projectId ?? 'n/a'}`,
    `conversation_id: ${input.conversationId ?? 'n/a'}`,
    `assistant_message_id: ${input.assistantMessageId ?? 'n/a'}`,
    `agent_id: ${input.agentId ?? 'n/a'}`,
  );

  return lines.join('\n');
}

function filterConversations(
  conversations: Conversation[],
  query: string,
  t: TranslateFn,
): Conversation[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return conversations;
  return conversations.filter((conversation) => {
    const title = conversation.title || t('chat.untitledConversation');
    const meta = conversationMetaLabel(conversation, t);
    return `${title} ${conversation.id} ${meta}`.toLocaleLowerCase().includes(normalized);
  });
}

function conversationMessageCount(
  conversation: Conversation,
  activeConversationId: string | null,
  messagesConversationId: string | null,
  activeMessageCount: number,
): number | null {
  // The live `messages` array is authoritative for the active conversation —
  // it stays fresh as a run streams new turns in — but ONLY once it has
  // actually loaded for that conversation. While a switch is mid-flight (or a
  // load failed) `messages` is reset to [] and `messagesConversationId` no
  // longer matches the active id; trusting `messages.length` there renders a
  // phantom "0 msg". Fall back to the persisted server count until the live
  // array catches up.
  if (
    conversation.id === activeConversationId &&
    messagesConversationId === activeConversationId
  ) {
    return activeMessageCount;
  }
  return typeof conversation.messageCount === 'number' ? conversation.messageCount : null;
}

function compactCount(value: number): string {
  if (value < 1000) return String(value);
  const compact = Math.floor(value / 100) / 10;
  return `${compact}k`;
}

function ConversationRow({
  conversation,
  active,
  messageCount,
  onSelect,
  onDelete,
  t,
}: {
  conversation: Conversation;
  active: boolean;
  messageCount: number | null;
  onSelect: () => void;
  onDelete: () => void;
  t: TranslateFn;
}) {
  const displayTitle =
    conversation.title || t('chat.untitledConversation');

  return (
    <div
      className={`chat-conv-item${active ? ' active' : ''}`}
      data-testid={`conversation-item-${conversation.id}`}
      onClick={onSelect}
    >
      <button
        type="button"
        className="chat-conv-item-name"
        data-testid={`conversation-select-${conversation.id}`}
        style={{ background: 'transparent', border: 'none', padding: 0, textAlign: 'left' }}
      >
        {displayTitle}
      </button>
      <span
        className="chat-conv-item-meta"
        data-testid={`conversation-meta-${conversation.id}`}
      >
        {messageCount !== null ? `${compactCount(messageCount)} msg · ` : ''}
        {conversationMetaLabel(conversation, t)}
      </span>
      <button
        type="button"
        className="chat-conv-item-del"
        data-testid={`conversation-delete-${conversation.id}`}
        title={t('chat.deleteConversation')}
        onClick={(e) => {
          e.stopPropagation();
          if (
            confirm(t('chat.deleteConversationConfirm', { title: displayTitle }))
          ) {
            onDelete();
          }
        }}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

// Memoized (hoisted impl referenced below): a static user message has stable
// props, so it skips re-render while a later turn streams.
const UserMessage = memo(UserMessageImpl);

  /**
   * 导出只为**验收**:镜像陈列页要能单独挂它,和设计稿逐格并排比
   * (`apps/web/tests/components/chat/mirror-gallery.test.tsx`)。
   * 产品侧仍然只由本文件内部使用,不要在别处引它。
   */
  export function UserMessageImpl({
  message,
  projectId,
  projectFileNames,
  onRequestOpenFile,
  t,
  highlighted,
  onResend,
}: {
  message: ChatMessage;
  projectId: string | null;
  projectFileNames?: Set<string>;
  onRequestOpenFile?: (name: string) => void;
  /** 发送失败时那颗常驻的「重试」(稿子第 49 / 50 格) */
  onResend?: (message: ChatMessage) => void;
  /** Legacy mirror-fixture inputs are accepted but intentionally not rendered. */
  onRequestPluginDetails?: (pluginId: string) => void;
  onRequestDesignSystemDetails?: (system: DesignSystemSummary) => void;
  appliedContextItems?: ReadonlyArray<unknown>;
  t: TranslateFn;
  highlighted?: boolean;
}) {
  const { workspaceContext } = useProjectCollabContext();
  const attachments = sortChatAttachmentsForDisplay(message.attachments ?? []);
  const commentAttachments = message.commentAttachments ?? [];
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const isDesignSystemWorkspaceRequest = isDesignSystemWorkspacePrompt(message.content);
  // The design-system handoff stores a long implementation prompt so the
  // agent can build the workspace. In chat, represent the user's actual menu
  // action instead: localized, concise, and rendered by the canonical user
  // bubble from the chat-panel design.
  const displayContent = isDesignSystemWorkspaceRequest
    ? t('designFiles.createDesignSystemFromProject')
    : message.content;

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  async function handleCopy() {
    if (!displayContent) return;
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    const ok = await copyToClipboard(displayContent);
    if (!ok) return;
    setCopied(true);
    copyTimerRef.current = setTimeout(() => {
      setCopied(false);
      copyTimerRef.current = undefined;
    }, 2000);
  }

  // 发送时间一直都在(`ChatMessage.createdAt`),只是从来没渲染过 —— hover 才浮出。
  const clock = formatMessageClock(message.createdAt);

  return (
    <div
      className={`msg user${highlighted ? ' is-chat-rail-highlighted' : ''}`}
      data-testid="user-message"
      data-chat-message-id={message.id}
    >
      <span className="sr-only">{t('chat.you')}</span>
      {/* CURRENT workspace targets and applied plugin/scenario snapshots still
          travel with the message and `/api/runs`; product currently suppresses
          their historical chips in the transcript UI only. */}
      {/* 附件在上、文字在下,右边界对齐:附件行锁 412、气泡锁 380,两条上限
          各管各的(#53)。壳子刻意不设 width:100% —— 那样两个孩子会各自按
          自己的百分比算宽度,右边界反而对不上。 */}
      <div className="msg-stack">
        {attachments.length > 0 ? (
          <UserAttachmentRow
            attachments={attachments}
            projectId={projectId}
            projectFileNames={projectFileNames}
            onRequestOpenFile={onRequestOpenFile}
            workspaceContext={workspaceContext}
            t={t}
          />
        ) : null}
        {commentAttachments.some((attachment) => attachment.selectionKind !== 'visual') ? (
          <div className="user-attachments comment-history-attachments">
            {commentAttachments.filter((attachment) => attachment.selectionKind !== 'visual').map((a) => (
              <span key={a.id} className="user-attachment staged-comment">
                <span className="staged-name" title={a.comment ? `${commentTargetDisplayName(a)}: ${a.comment}` : commentTargetDisplayName(a)}>
                  <strong>{commentTargetDisplayName(a)}</strong>
                  {a.comment ? <span>{a.comment}</span> : null}
                </span>
              </span>
            ))}
          </div>
        ) : null}
        {message.content ? (
          <div className="user-text-wrap">
            <UserBubble content={displayContent} t={t} />
            <div className="user-actions">
              {/* 稿子**渲染出来**是「时间 → 复制 → 重试」(它的说明文字写的是「时间在最右」,
                  和自己的 DOM 打架;用户 2026-08-26 指认以渲染为准)。
                  时间不是动作,所以不给按钮那套 30px 命中框。 */}
              {clock ? <span className="user-actions-time">{clock}</span> : null}
              <button
                type="button"
                className="ghost user-copy-btn"
                onClick={handleCopy}
                aria-label={copied ? t('chat.copyDone') : t('chat.copyPrompt')}
                title={copied ? t('chat.copyDone') : t('chat.copyPrompt')}
              >
                <Icon name={copied ? 'check' : 'copy'} size={16} />
              </button>
              {/* 发送失败那颗「重试」(稿子第 49 / 50 格的 `.msg-act .keep`):
                  和时间 / 复制**同一行**,但不跟着 hover 出没 —— 第 50 格的状态名
                  写的就是「时间与复制浮出,重试常驻」。 */}
              {message.sendFailed ? (
                <button
                  type="button"
                  className="user-keep-btn"
                  data-testid="user-send-failed"
                  aria-label={t('chat.sendFailedRetryAria')}
                  onClick={() => onResend?.(message)}
                >
                  {/* 稿子这一枚是**循环箭头**(`refresh`),不是感叹号 ——
                      感叹号说的是「出事了」,这颗按钮说的是「再来一次」。 */}
                  <Icon name="refresh" size={13} />
                  <span>{t('chat.record.retry')}</span>
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
  }

  /* ── 气泡正文:超长折到 6 行(#46 / #47)──────────────────────────────
   *
   * 折的是【里面那层 .user-text-txt】,不是气泡本身:`-webkit-line-clamp` 的裁切
   * 边界是 padding box,直接折在气泡上的话第 7 行会从那 9px 下内边距里露半条字。
   *
   * 展开入口按 DOM / CSS / 规格 W7 走「气泡内的『查看全部』一行」,不是 hover
   * 浮出箭头 —— 稿子的说明文字那一句已经过时(盘点 §5 第 2 条)。
   * #47 相对 #46 在样式表里没有任何匹配规则,所以两格当同一态做。
   */
  function UserBubble({ content, t }: { content: string; t: TranslateFn }) {
  const txtRef = useRef<HTMLSpanElement>(null);
  const [expanded, setExpanded] = useState(false);
  const cut = useIsTextClamped(txtRef, content, expanded);

  return (
    <div className={`user-text user-bubble${expanded ? ' is-expanded' : ''}${cut ? ' is-cut' : ''}`}>
      <span className="user-text-clip">
        <span className="user-text-txt" ref={txtRef}>{content}</span>
        {cut && !expanded ? (
          <button
            type="button"
            className="user-text-more"
            data-testid="user-text-more"
            aria-label={t('chat.input.expandFull')}
            onClick={() => setExpanded(true)}
          >
            …
          </button>
        ) : null}
      </span>
      {cut ? (
        <div className="msg-more">
          <button
            type="button"
            data-testid="user-text-view-all"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? t('chat.input.collapse') : t('chat.input.viewAll')}
            <Icon name="chevron-down" size={12} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

  /**
   * 「这段话真的被截断了吗」。
   *
   * 只在【真的被截断】时才出那枚「…」:同一段话在宽一点的面板里可能六行就说完了,
   * 那时候还挂一枚「…」是在说一句不存在的下文。CSS 判断不了,只能量 ——
   * `scrollHeight` 比 `clientHeight` 高就是有东西被压住了。
   *
   * 面板宽度会变(拖动分栏、窗口缩放),字体加载完行高也会变,所以 `resize`、
   * `ResizeObserver`、`document.fonts.ready` 三路都要重量。
   * 展开之后不再重量:那时候 clamp 已经摘掉,量出来必然是「没截断」,
   * 会把「收起」的入口一起弄没。
   */
  function useIsTextClamped(
  ref: MutableRefObject<HTMLSpanElement | null>,
  content: string,
  expanded: boolean,
  ): boolean {
  const [cut, setCut] = useState(false);
  useEffect(() => {
    if (expanded) return;
    const el = ref.current;
    if (!el) return;
    let alive = true;
    const measure = () => {
      const node = ref.current;
      if (!alive || !node) return;
      setCut(node.scrollHeight - node.clientHeight > 1);
    };
    measure();
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure);
      observer.observe(el);
    }
    window.addEventListener('resize', measure);
    const fonts = (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts;
    fonts?.ready?.then(measure).catch(() => {});
    return () => {
      alive = false;
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [ref, content, expanded]);
  return cut;
  }

  /* ── 附件行(#52 / #53 / #56 / #57 / #58 / #59)────────────────────────
   *
   * 永远单行,超出横向滚动:多少个附件都只占一行,消息在流水里的高度因此是常量。
   * 图卡 57px 见方、不挂文件名(缩略图本身就是它的名字);文档卡 180px 宽,
   * 它没有画面,名字是它唯一的身份,所以反过来【必须】挂名字。
   *
   * 点击语义仍是产品现有的「在编辑器里打开这个文件」,不是稿子说的「弹层看大图」——
   * 换语义要产品拍板(盘点 §5 第 8 条)。
   */
  function UserAttachmentRow({
  attachments,
  projectId,
  projectFileNames,
  onRequestOpenFile,
  workspaceContext,
  t,
  }: {
  attachments: ChatAttachment[];
  projectId: string | null;
  projectFileNames?: Set<string>;
  onRequestOpenFile?: (name: string) => void;
  workspaceContext: ReturnType<typeof useProjectCollabContext>['workspaceContext'];
  t: TranslateFn;
  }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const { prev, next, page } = useAttachmentRowNav(rowRef, attachments.length);
  return (
    /* 壳子只为箭头存在:箭头要绝对定位压在这一行的两端,而滚动容器自己
       不能 `position: relative` —— 那样绝对定位的孩子会跟着内容一起滚走。 */
    <div className={`msg-att-wrap${prev ? ' is-prev' : ''}${next ? ' is-next' : ''}`}>
      <div className="user-attachments msg-att" data-testid="user-attachment-row" ref={rowRef}>
        {attachments.map((a) => {
          const baseName = a.path.split('/').pop() || a.path;
          const openName = projectFileNames
            ? [a.path, a.name, baseName].find(
                (candidate): candidate is string =>
                  typeof candidate === 'string' && projectFileNames.has(candidate),
              ) ?? baseName
            : baseName;
          // User-message attachments are uploaded into the project before the
          // message is persisted. The project file list can still be one
          // refresh behind, especially during the Home -> Project handoff, so
          // it is not a valid reason to disable the user's explicit open.
          const openable = !!onRequestOpenFile;
          const handleOpen = openable ? () => onRequestOpenFile?.(openName) : undefined;
          const label = openable ? t('chat.openFile', { name: baseName }) : a.path;
          return a.kind === 'image' && projectId ? (
            <button
              type="button"
              key={a.path}
              className="msg-att-img"
              onClick={handleOpen}
              disabled={!openable}
              aria-label={label}
              title={label}
            >
              <span className="msg-att-ph">
                <img
                  className="msg-att-mini"
                  src={projectRawUrl(projectId, a.path, workspaceContext)}
                  alt=""
                />
              </span>
              {/* 稿子第 55 格:hover 时卡右上角浮出一枚眼睛角标(`.att-ov .act`)。
                  它是**这张卡的悬停提示**,不是第二颗按钮 —— 卡本身的点击语义
                  仍然是「在编辑器里打开」,换成「弹层看大图」要产品拍板(已记)。 */}
              <span className="msg-att-eye" aria-hidden>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </span>
            </button>
          ) : (
            <UserAttachmentDocCard
              key={a.path}
              attachment={a}
              label={label}
              openable={openable}
              onOpen={handleOpen}
            />
          );
        })}
      </div>
      {/* 一枚朝下的箭头转 ±90 度当左右用 —— 稿子里只此一支箭头,不另画两枚。
          出不出由 JS 量,**两颗常驻**、靠壳上的 `is-prev` / `is-next` 开关 `display`,
          和稿子 `.att-wrap.is-prev > .att-nav.mod-prev` 一致。
          (原来这里是条件不渲染。改成常驻还顺带合上了本仓的约定:
           条件显示的元素保持挂载,React 卸载会把退场过渡整个跳过。) */}
      <button
        type="button"
        className="msg-att-nav mod-prev"
        data-testid="msg-att-nav-prev"
        aria-label={t('chat.attachments.scrollPrev')}
        onClick={() => page('prev')}
      >
        <i>
          <Icon name="chevron-down" size={14} />
        </i>
      </button>
      <button
        type="button"
        className="msg-att-nav mod-next"
        data-testid="msg-att-nav-next"
        aria-label={t('chat.attachments.scrollNext')}
        onClick={() => page('next')}
      >
        <i>
          <Icon name="chevron-down" size={14} />
        </i>
      </button>
    </div>
  );
  }

  /**
   * 附件行的翻页箭头(#58)。
   *
   * 滚动条按稿子藏起来了,所以「还能往哪边走」必须由别的东西说。原来指望
   * 【卡被切在腰上】这一个信号 —— 它说得了「后面还有」,说不了「往回也还有」,
   * 更给不了鼠标一个能点的地方(触控板能横扫,鼠标只有按住 shift 滚轮)。
   *
   * 【只在真的被遮住时才出】。是否遮住由这里量,判据是纯函数
   * (`runtime/chat/attachment-nav.ts`)。四路重算,少一路就会看见错的箭头:
   *   · `scroll` —— 滚动过程中两端的结论一直在翻;
   *   · `ResizeObserver` —— 面板宽度变了(拖分栏),放得下 / 放不下会翻过来;
   *   · `resize` —— 窗口缩放不一定触发容器自身的 resize(容器是定宽 412 时);
   *   · `document.fonts.ready` —— 文档卡里的文字宽度要等字体到位才定下来。
   */
  function useAttachmentRowNav(
  ref: MutableRefObject<HTMLDivElement | null>,
  count: number,
  ): AttachmentNavState & { page: (direction: 'prev' | 'next') => void } {
  const [state, setState] = useState<AttachmentNavState>({ prev: false, next: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let alive = true;
    const sync = () => {
      const node = ref.current;
      if (!alive || !node) return;
      const measured = attachmentNavState(node);
      // 同一个结论就别 setState —— `scroll` 每帧都在响,原样回写会把整条消息
      // 重渲染一遍(附件行住在 memo 过的 UserMessage 里,白跑得很显眼)。
      setState((current) =>
        current.prev === measured.prev && current.next === measured.next ? current : measured,
      );
    };
    sync();
    el.addEventListener('scroll', sync, { passive: true });
    window.addEventListener('resize', sync);
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(sync);
      observer.observe(el);
    }
    const fonts = (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts;
    fonts?.ready?.then(sync).catch(() => {});
    return () => {
      alive = false;
      el.removeEventListener('scroll', sync);
      window.removeEventListener('resize', sync);
      observer?.disconnect();
    };
  }, [ref, count]);

  const page = useCallback(
    (direction: 'prev' | 'next') => {
      const node = ref.current;
      if (!node) return;
      const rtl =
        typeof window !== 'undefined' &&
        window.getComputedStyle(node).direction === 'rtl';
      const left = attachmentNavDelta(direction, node.clientWidth, rtl);
      if (typeof node.scrollBy === 'function') node.scrollBy({ left, behavior: 'smooth' });
      else node.scrollLeft += left;
    },
    [ref],
  );

  return { ...state, page };
  }

  function UserAttachmentDocCard({
  attachment,
  label,
  openable,
  onOpen,
  }: {
  attachment: ChatAttachment;
  label: string;
  openable: boolean;
  onOpen?: () => void;
  }) {
  const { base, ext } = splitFileName(attachment.name);
  const nameRef = useRef<HTMLSpanElement>(null);
  const displayBase = useMiddleTruncatedName(nameRef, base, ext);
  const size = formatAttachmentSize(attachment.size);
  return (
    <button
      type="button"
      className="msg-att-doc"
      onClick={onOpen}
      disabled={!openable}
      aria-label={label}
      title={label}
    >
      <Icon name="file" size={15} className="msg-att-fi" />
      <span className="msg-att-tx">
        <span className="msg-att-nm" ref={nameRef}>
          <span className="msg-att-base">{displayBase}</span>
          {ext ? <span className="msg-att-ext">{ext}</span> : null}
        </span>
        {/* 拿不到体积就空着这一行,不写 `0 B` —— 但位置留着,
            否则同一行里有体积和没体积的卡会差一行高(AGENTS §3)。 */}
        <span className="msg-att-meta">{size ?? ''}</span>
      </span>
    </button>
  );
  }

  /** 量文字宽度用的离屏 canvas。一份就够,反复建会在长会话里堆出几百个。 */
  let nameMeasureCtx: CanvasRenderingContext2D | null | undefined;

  function textMeasurerFor(el: HTMLElement | null): ((text: string) => number) | null {
  if (!el || typeof document === 'undefined') return null;
  if (nameMeasureCtx === undefined) {
    try {
      nameMeasureCtx = document.createElement('canvas').getContext('2d');
    } catch {
      // jsdom / 没有 canvas 的运行环境:量不到就不截,由 CSS overflow 兜底。
      nameMeasureCtx = null;
    }
  }
  const ctx = nameMeasureCtx;
  if (!ctx) return null;
  const cs = window.getComputedStyle(el);
  if (!cs.fontSize) return null;
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  return (text: string) => ctx.measureText(text).width;
  }

  /**
   * 文件名中间省略(#59)。
   *
   * 量的是 `.msg-att-nm` 自己的可用宽度,而它在一张【定宽 180px】的卡里、且被
   * `.msg-att-tx { flex: 1 }` 钉住 —— 所以这个宽度是常量,不随名字长短变。
   * 这是绕开稿子里那个「越截越短」棘轮的关键:**不能拿截过的名字再去量**。
   *
   * 量不到(SSR / jsdom / 没有 canvas)就原样返回,由 CSS 的 `overflow:hidden`
   * 兜底 —— 宁可不截,不要截错。
   */
  function useMiddleTruncatedName(
  ref: MutableRefObject<HTMLSpanElement | null>,
  base: string,
  ext: string,
  ): string {
  const [avail, setAvail] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let alive = true;
    const measure = () => {
      const node = ref.current;
      if (!alive || !node) return;
      // 还没布局(SSR 之后的第一帧 / jsdom)就别去碰 canvas —— 量不到就不截。
      if (!node.clientWidth) {
        setAvail(0);
        return;
      }
      const measurer = textMeasurerFor(node);
      const extWidth = measurer && ext ? measurer(ext) : 0;
      setAvail(node.clientWidth - extWidth);
    };
    measure();
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure);
      observer.observe(el);
    }
    const fonts = (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts;
    fonts?.ready?.then(measure).catch(() => {});
    return () => {
      alive = false;
      observer?.disconnect();
    };
  }, [ref, ext]);
  return useMemo(
    () => (avail > 0 ? middleTruncateFileName(base, avail, textMeasurerFor(ref.current)) : base),
    [ref, base, avail],
  );
  }

function sortChatAttachmentsForDisplay(attachments: ChatAttachment[]): ChatAttachment[] {
  return attachments
    .map((attachment, index) => ({ attachment, index }))
    .sort((a, b) => {
      const aOrder = typeof a.attachment.order === 'number' && Number.isFinite(a.attachment.order)
        ? a.attachment.order
        : a.index;
      const bOrder = typeof b.attachment.order === 'number' && Number.isFinite(b.attachment.order)
        ? b.attachment.order
        : b.index;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.index - b.index;
    })
    .map((entry) => entry.attachment);
}

function isDesignSystemNextStepProject(metadata: ProjectMetadata | undefined): boolean {
  if (!metadata) return false;
  return (
    metadata.kind === 'brand' ||
    metadata.importedFrom === 'design-system' ||
    metadata.importedFrom === 'brand-extraction' ||
    Boolean(metadata.brandDesignSystemId)
  );
}

function isBrandExtractionNextStepProject(metadata: ProjectMetadata | undefined): boolean {
  if (!metadata) return false;
  return (
    metadata.kind === 'brand' ||
    metadata.importedFrom === 'brand-extraction' ||
    Boolean(metadata.brandId) ||
    Boolean(metadata.brandDesignSystemId)
  );
}

function isProgrammaticBrandAssistantMessage(message: ChatMessage | null | undefined): boolean {
  if (!message || message.role !== 'assistant') return false;
  const content = message.content || '';
  return (
    content.includes('<od-card type="brand-browser-assist"') ||
    /programmatic (design-system )?extraction|automatic pass needs a hand|extraction stopped/i.test(content) ||
    /程序化.*抽取|程式化.*抽取|抽取已停止/.test(content)
  );
}

function relTime(ts: number, t: TranslateFn): string {
  const diff = Date.now() - ts;
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (diff < min) return t('common.now');
  if (diff < hr) return t('common.minutesShort', { n: Math.floor(diff / min) });
  if (diff < day) return t('common.hoursShort', { n: Math.floor(diff / hr) });
  if (diff < 7 * day) return t('common.daysShort', { n: Math.floor(diff / day) });
  return new Date(ts).toLocaleDateString();
}

export function conversationMetaLabel(
  conversation: Conversation,
  t: TranslateFn,
): string {
  const latestRun = conversation.latestRun;
  if (
    latestRun &&
    (latestRun.status === 'succeeded' ||
      latestRun.status === 'failed' ||
      latestRun.status === 'canceled') &&
    typeof conversation.totalDurationMs === 'number' &&
    Number.isFinite(conversation.totalDurationMs)
  ) {
    return formatDurationShort(conversation.totalDurationMs);
  }
  if (
    latestRun &&
    (latestRun.status === 'succeeded' ||
      latestRun.status === 'failed' ||
      latestRun.status === 'canceled') &&
    typeof latestRun.durationMs === 'number' &&
    Number.isFinite(latestRun.durationMs)
  ) {
    return formatDurationShort(latestRun.durationMs);
  }
  return relTime(conversation.updatedAt, t);
}

function formatDurationShort(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.floor(s - m * 60);
  return `${m}m ${rem.toString().padStart(2, '0')}s`;
}
