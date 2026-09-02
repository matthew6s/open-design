import type { LiveArtifactRefreshStatus } from '../api/live-artifacts.js';
import type { RunFailureAction, RunFailureCategory, RunFailureDetail } from '../api/chat.js';
import type { StrategyTaskProjectionV2 } from '../plugins/strategy-v2.js';
import type { SseErrorPayload } from '../errors.js';
import type { SseTransportEvent } from './common.js';

export type LiveArtifactSseAction = 'created' | 'updated' | 'deleted';
export type LiveArtifactRefreshSsePhase = 'started' | 'succeeded' | 'failed';

export interface LiveArtifactSsePayload {
  type: 'live_artifact';
  action: LiveArtifactSseAction;
  projectId: string;
  artifactId: string;
  title: string;
  /**
   * Refresh lifecycle state of the artifact at emit time. Typed against the
   * canonical `LiveArtifactRefreshStatus` enum used by the REST API so that
   * SSE consumers (web, CLI) can switch on the same union members without
   * widening to `string`. Optional because the daemon may omit the field on
   * legacy events; consumers must still null-check before narrowing.
   */
  refreshStatus?: LiveArtifactRefreshStatus;
}

export interface LiveArtifactRefreshSsePayload {
  type: 'live_artifact_refresh';
  phase: LiveArtifactRefreshSsePhase;
  projectId: string;
  artifactId: string;
  refreshId?: string;
  title?: string;
  refreshedSourceCount?: number;
  error?: string;
}

export interface PlainStreamArtifactSsePayload {
  type: 'artifact';
  source: 'plain-stream';
  name: string;
  path?: string;
  identifier?: string;
  artifactType?: string;
}

/**
 * Emitted by the daemon on `/api/projects/:id/events` when a new
 * conversation is inserted into a project from a path the open
 * project view can't observe through its own state — currently
 * Routines "Run now" in reuse-an-existing-project mode (#1361).
 *
 * Lives in `packages/contracts` so the daemon producer and the web
 * consumer share one type and can't drift as the stream grows.
 */
export interface ProjectConversationCreatedSsePayload {
  type: 'conversation-created';
  projectId: string;
  conversationId: string;
  title: string | null;
  createdAt: number;
}

export const CHAT_SSE_PROTOCOL_VERSION = 1;

export interface ChatSseStartPayload {
  runId?: string;
  agentId?: string;
  bin: string;
  protocolVersion?: typeof CHAT_SSE_PROTOCOL_VERSION;
  /** Legacy daemon-internal absolute cwd. Kept for compatibility during W2 adoption. */
  cwd?: string | null;
  projectId?: string | null;
  model?: string | null;
  reasoning?: string | null;
  serviceTier?: string | null;
}

export interface ChatSseChunkPayload {
  chunk: string;
}

export interface ChatSseEndPayload {
  code: number | null;
  signal?: string | null;
  status?: 'succeeded' | 'failed' | 'canceled';
  /** The immutable instant the Run entered its terminal status. */
  terminalAt?: number;
  /** Authoritative count of artifact files created or modified by this run.
   *  Present when the daemon resolved the run's filesystem/tool-stream diff
   *  before publishing the terminal frame. */
  artifactCount?: number;
  /** Project-relative artifact paths created or modified by this run. */
  artifactPaths?: string[];
  /** True when a `failed` run can be recovered by resuming the agent's CLI
   *  session (transient upstream drop / inactivity on a session-resuming
   *  runtime). Lets the chat offer a Continue affordance without a separate
   *  run-status fetch. Mirrors ChatRunStatusResponse.resumable. */
  resumable?: boolean;
  /** True when this terminal run ended with unfinished declared work (a
   *  non-`completed` TodoWrite task, or a max_tokens truncation). The browser
   *  reads it straight off the terminal frame and carries it onto the persisted
   *  assistant message so every status surface avoids showing "Completed" for an
   *  incomplete run. Mirrors ChatRunStatusResponse.endedWithUnfinishedWork. */
  endedWithUnfinishedWork?: boolean;
  /** Daemon failure classification for a `failed` run, so the chat can render
   *  specific guidance straight off the terminal frame without a status refetch.
   *  Mirror ChatRunStatusResponse.failureCategory / failureDetail. */
  failureCategory?: RunFailureCategory | null;
  failureDetail?: RunFailureDetail | null;
  /** The daemon's verdict on the same failure: what the user should do, and
   *  whether re-running can help at all. Carried on the terminal frame for the
   *  same reason as the classification above — the chat decides which button
   *  the error card leads with, and re-deriving retryability from the detail
   *  name on the client is exactly the drift these fields exist to end.
   *  Mirror ChatRunStatusResponse.failureAction / retryable; both absent from
   *  older daemons, and absence means "no verdict", not `retryable: false`. */
  failureAction?: RunFailureAction | null;
  retryable?: boolean | null;
  strategyTask?: StrategyTaskProjectionV2;
}

export type DaemonAgentPayload =
  | { type: 'status'; label: string; model?: string; ttftMs?: number; detail?: string }
  | { type: 'text_delta'; delta: string }
  /**
   * This turn's one-time done key, emitted once before any model output. See
   * the `done_key` member of `PersistedAgentEvent` for the protocol rationale.
   */
  | { type: 'done_key'; key: string }
  /**
   * This turn's follow-up suggestions, already parsed and validated out of the
   * agent's `<od-next key="…" value="…"/>` markers. Emitted once after the
   * marker set is complete or the stream ends.
   *
   * The raw marker never reaches the client: the daemon strips it from the
   * visible text stream and checks its key against the turn's nonce, so a
   * suggestion the client receives is one the model was authorised to make.
   * A turn with no marker simply emits no event — which is also what every
   * conversation recorded before this event existed looks like, and is why the
   * client must render nothing at all rather than falling back to a default
   * list.
   */
  | { type: 'next_steps'; suggestions: string[] }
  /**
   * This turn's display intent, already parsed, key-checked, and path-resolved
   * out of the agent's `<od-focus …/>` marker. See
   * `api/artifact-focus-marker.ts` for the marker itself.
   *
   * `open` is a project-relative path the preview should show; the daemon has
   * already proven it resolves inside the project root and that the file is
   * non-empty, so the client never opens a blank tab and never asks for a path
   * the agent invented. `show` is the subset of this turn's produced files that
   * deserves a card — a filter, never an addition.
   *
   * May arrive more than once per turn: `open` fires as soon as the file has
   * content (mid-turn, deliberately), while `show` is only knowable at the end.
   * Consumers fold last-wins PER FIELD (`foldArtifactFocusSelections`), so a
   * late `show`-only event cannot retract an early `open`.
   *
   * A turn with no marker emits no event, and the client must keep its existing
   * inference exactly as-is — "no event" never means "show nothing".
   */
  | { type: 'artifact_focus'; open?: string; show?: string[] }
  | { type: 'conversation_title'; title: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'thinking_start' }
  | LiveArtifactSsePayload
  | LiveArtifactRefreshSsePayload
  | PlainStreamArtifactSsePayload
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: unknown;
      /** Optional wall-clock ms when the tool first started (e.g. ACP first frame). */
      startedAt?: number;
    }
  /**
   * Live-only incremental tool-input fragment, emitted while the model is still
   * streaming a tool call's JSON arguments (Claude `input_json_delta`). `delta`
   * is a raw, possibly mid-token JSON fragment — not parseable on its own.
   * NOT persisted — see `daemonAgentPayloadToPersistedAgentEvent`.
   *
   * **This event exists for its arrival time, not its payload.** The web client
   * counts it as upstream-liveness evidence for the S12 silence probe
   * (`markUpstreamActivity` in `apps/web/src/providers/daemon.ts`) and then
   * drops it: it never becomes an `AgentEvent` and is never rendered. It is the
   * probe's main heartbeat — in the recorded run `7ed15c2f` it is 699 of 1346
   * agent frames, and 124 of the 126 frames in one 161.6s window. Stop emitting
   * it and the probe starts falsely reporting silence while the model streams.
   *
   * **Do not render it.** It marks the model *composing the next* tool call,
   * not a tool executing — by the time it flows the previous tool has already
   * returned. The chat design forbids an in-flight tool row outright (D3 / B8 in
   * `specs/current/chat-panel-next.md`); in-flight feedback is the execution
   * shell's orb plus its ticking elapsed timer, and the design is explicit that
   * one such affordance is enough. `id` (the content-block id, equal to the
   * eventual `tool_use.id`) and `name` are carried for correlation only.
   */
  | { type: 'tool_input_delta'; id: string; name: string; delta: string }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean; completedAt?: number }
  | { type: 'usage'; usage?: { input_tokens?: number; output_tokens?: number }; costUsd?: number; durationMs?: number; stopReason?: string | null }
  | { type: 'fabricated_role_marker'; marker: string; messageId?: string }
  // The agent is stuck repeating failing tool calls (see tool-loop-guard.ts).
  // `action: 'warn'` is an early heads-up the run may be looping; `'halt'` means
  // the daemon terminated the run at the hard ceiling. `signature` is a
  // truncated, human-readable form of the repeated action; `count` is how many
  // times it failed (consecutive run, or repeats of this exact action).
  | {
      type: 'tool_loop';
      reason: 'consecutive-errors' | 'repeated-failure';
      action: 'warn' | 'halt';
      toolName: string;
      signature: string;
      count: number;
    }
  | { type: 'raw'; line: string };

/**
 * The run-level automatic retry the daemon just started, as the browser sees it.
 *
 * The daemon writes this as an ANALYTICS record, but `runs.ts`'s `emit` is also
 * the SSE fan-out (`for (const sse of run.clients) sse.send(event, data, id)`),
 * so every analytics record reaches a subscribed client on the same stream as
 * `start` / `agent` / `end`. Declaring it here makes that delivery intentional
 * rather than incidental: the chat needs it to say "still trying" while the
 * second attempt spins up, and nothing else can tell it that the first attempt
 * died — the `error` frame for a retried attempt is deliberately cached and not
 * surfaced.
 *
 * Only the fields the UI reads are declared. The daemon sends the full
 * `RunRetryAttemptedProps` analytics shape (project/conversation ids, failure
 * classification, delays); consumers of this event must not grow a dependency
 * on those — they belong to the analytics contract, which is free to change.
 */
export interface ChatSseRunRetryAttemptedPayload {
  /** Which automatic attempt this is, 1-based. */
  retry_attempt_index: number;
  /** How many automatic attempts this run is allowed. 1 today. */
  retry_max_attempts: number;
}

/**
 * Out-of-band run diagnostics. The payload is discriminated by `type` and is
 * additive: a client ignores the types it does not know.
 */
export interface ChatSseDiagnosticPayload {
  type: string;
  [key: string]: unknown;
}

/**
 * The daemon is continuing the SAME logical task in a new physical Run. A Full
 * Plan turn spans several Runs (request -> production) that the user asked for
 * once, and the continuation carries no user prompt of its own.
 *
 * Observability only — it marks the hand-off in the source Run's event log so a
 * multi-Run turn can be reconstructed when diagnosing one. Rendering does NOT
 * read it: the client keeps the turn whole from each message's
 * `strategyTaskRunIndex`, folding the task's messages at render time. A client
 * that instead re-pointed the originating message at `nextRunId` would end up
 * showing the continuation's answer twice, next to the row the daemon persists
 * for that Run.
 */
export interface StrategyTaskContinuationDiagnostic extends ChatSseDiagnosticPayload {
  type: 'strategy_task_continuation';
  taskExecutionId: string | null;
  sourceRunId: string;
  nextRunId: string;
  inputStage: string | null;
  taskRunIndex: number | null;
}

export type ChatSseEvent =
  | SseTransportEvent<'start', ChatSseStartPayload>
  | SseTransportEvent<'run_retry_attempted', ChatSseRunRetryAttemptedPayload>
  | SseTransportEvent<'agent', DaemonAgentPayload>
  | SseTransportEvent<'stdout', ChatSseChunkPayload>
  | SseTransportEvent<'stderr', ChatSseChunkPayload>
  | SseTransportEvent<'diagnostic', ChatSseDiagnosticPayload>
  | SseTransportEvent<'error', SseErrorPayload>
  | SseTransportEvent<'end', ChatSseEndPayload>;
