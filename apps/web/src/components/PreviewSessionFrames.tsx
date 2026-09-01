import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
} from 'react';
import type {
  PreviewRuntimeCapability,
  PreviewRuntimeDocumentIdentity,
} from '@open-design/contracts/runtime/preview-runtime';
import { OPEN_DESIGN_PREVIEW_NAVIGATION_ATTEMPT_PARAM } from '@open-design/host';
import {
  PreviewSession,
  type PreviewSessionDocument,
} from '../runtime/preview-session';
import {
  previewSessionFramePolicy,
  type PreviewSessionNavigation,
} from '../runtime/preview-session-navigation';
export type { PreviewSessionNavigation } from '../runtime/preview-session-navigation';
import type { PreviewRuntimeMessageTarget } from '../runtime/preview-runtime-controller';
import {
  PooledIframe,
  previewIframeKeepAliveKey,
  useIframeKeepAlivePool,
} from './IframeKeepAlivePool';

export interface PreviewSessionFramesProps extends Omit<
  ComponentPropsWithoutRef<'iframe'>,
  'src' | 'srcDoc' | 'onLoad' | 'ref' | 'sandbox' | 'allow'
> {
  projectId: string;
  fileName: string;
  navigation: PreviewSessionNavigation;
  enabledCapabilities?: readonly PreviewRuntimeCapability[];
  /** Receives interaction and host bridge traffic. */
  active: boolean;
  /** Remains painted during a cross-viewer handoff even when inactive. */
  presented?: boolean;
  /** Bump to replace an unpromoted standby browsing context at the same URL. */
  navigationRetryToken?: number;
  onCurrentFrameChange?: (frame: HTMLIFrameElement | null) => void;
  onStandbyFrameChange?: (frame: HTMLIFrameElement | null) => void;
  onStandbyReady?: (frame: HTMLIFrameElement) => void;
  onCapabilitiesApplied?: (
    frame: HTMLIFrameElement,
    capabilities: readonly PreviewRuntimeCapability[],
  ) => void;
  onPromoted?: (
    current: PreviewSessionNavigation,
    previous: PreviewSessionNavigation | null,
  ) => void;
  onStandbyTimedOut?: (
    failed: PreviewSessionNavigation,
    current: PreviewSessionNavigation | null,
  ) => void;
  onStandbyVersionChanged?: (
    failed: PreviewSessionNavigation,
    current: PreviewSessionNavigation | null,
    navigationAttempt: number,
  ) => void;
  standbyTimeoutMs?: number;
}

interface RenderedPreviewDocument extends Omit<PreviewSessionNavigation, 'runtimeProtocol'> {
  runtimeProtocol: 'universal';
  frame: HTMLIFrameElement;
  target: PreviewRuntimeMessageTarget;
  navigationAttempt: number;
}

const EMPTY_CAPABILITIES: readonly PreviewRuntimeCapability[] = [];
// This bounds a broken Runtime handshake. It is not a visual-content timeout:
// authored blank/error output remains a valid current version once the exact
// Runtime and presentation-state protocol has settled.
export const PREVIEW_SESSION_STANDBY_TIMEOUT_MS = 5_000;

function identityKey(identity: PreviewRuntimeDocumentIdentity): string {
  return `${identity.sessionId}\0${identity.documentVersion}`;
}

function sameIdentity(
  left: PreviewRuntimeDocumentIdentity | null,
  right: PreviewRuntimeDocumentIdentity,
): boolean {
  return left !== null && identityKey(left) === identityKey(right);
}

function documentKeepAliveKey(
  projectId: string,
  fileName: string,
  identity: PreviewRuntimeDocumentIdentity,
  navigationAttempt: number,
): string {
  return `${previewIframeKeepAliveKey(projectId, fileName)}\0${identityKey(identity)}\0attempt:${navigationAttempt}`;
}

export function previewSessionNavigationAttemptUrl(
  navigation: PreviewSessionNavigation,
  navigationAttempt: number,
): string {
  if (navigation.runtimeProtocol !== 'universal') return navigation.url;
  const url = new URL(navigation.url);
  url.searchParams.set(
    OPEN_DESIGN_PREVIEW_NAVIGATION_ATTEMPT_PARAM,
    `${navigation.sessionId}.${navigationAttempt}`,
  );
  return url.href;
}

/**
 * Retain one same-file real-URL iframe while an exact new document version
 * settles in a transparent, inert standby iframe. The component never assigns
 * about:blank and never mutates the URL of an existing browsing context.
 *
 * FileViewer uses this as its only settled-file document transport. Version
 * replacement may briefly stage one transparent candidate beside last-good,
 * but there is never a parallel srcdoc/Blob runtime.
 */
export function PreviewSessionFrames({
  projectId,
  fileName,
  ...props
}: PreviewSessionFramesProps) {
  if (props.navigation.runtimeProtocol === 'legacy-url') {
    return (
      <LegacyPreviewSessionFramesForFile
        key={`${projectId}\0${fileName}`}
        projectId={projectId}
        fileName={fileName}
        {...props}
      />
    );
  }
  return (
    <PreviewSessionFramesForFile
      key={`${projectId}\0${fileName}`}
      projectId={projectId}
      fileName={fileName}
      {...props}
    />
  );
}

interface LegacyRenderedPreviewDocument {
  navigation: PreviewSessionNavigation;
  navigationAttempt: number;
  frame: HTMLIFrameElement;
}

/**
 * Rolling-upgrade adapter for daemons that predate the universal Preview
 * Runtime. It still renders exactly one real-URL document transport. Because
 * the old document has no runtime handshake, browser load is the strongest
 * available promotion signal; interactive capabilities remain unavailable
 * instead of falling back to srcdoc/Blob.
 */
function LegacyPreviewSessionFramesForFile({
  projectId,
  fileName,
  navigation,
  enabledCapabilities = EMPTY_CAPABILITIES,
  active,
  presented = active,
  navigationRetryToken = 0,
  onCurrentFrameChange,
  onStandbyFrameChange,
  onPromoted,
  title = fileName,
  ...iframeProps
}: PreviewSessionFramesProps) {
  const pool = useIframeKeepAlivePool();
  const [current, setCurrent] = useState<LegacyRenderedPreviewDocument | null>(null);
  const requestedIsCurrent = current !== null
    && sameIdentity(current.navigation, navigation)
    && current.navigation.url === navigation.url
    && current.navigationAttempt === navigationRetryToken;
  const standby = requestedIsCurrent ? null : navigation;

  useEffect(() => {
    onCurrentFrameChange?.(active ? current?.frame ?? null : null);
  }, [active, current, onCurrentFrameChange]);

  useEffect(() => () => {
    onCurrentFrameChange?.(null);
    onStandbyFrameChange?.(null);
  }, [onCurrentFrameChange, onStandbyFrameChange]);

  const promote = useCallback((frame: HTMLIFrameElement) => {
    if (!standby) return;
    const previous = current;
    setCurrent({
      navigation: standby,
      navigationAttempt: navigationRetryToken,
      frame,
    });
    onPromoted?.(standby, previous?.navigation ?? null);
    if (previous) {
      pool.evict(documentKeepAliveKey(
        projectId,
        fileName,
        previous.navigation,
        previous.navigationAttempt,
      ));
    }
  }, [current, fileName, navigationRetryToken, onPromoted, pool, projectId, standby]);

  const commonProps = {
    ...iframeProps,
    title,
    'data-od-render-mode': 'runtime-url',
    'data-od-runtime-protocol': 'legacy-url',
    'data-od-capabilities': enabledCapabilities.length > 0 ? 'unavailable' : 'none-requested',
  };

  return (
    <>
      {current ? (
        <PooledIframe
          key={documentKeepAliveKey(
            projectId,
            fileName,
            current.navigation,
            current.navigationAttempt,
          )}
          {...commonProps}
          cacheKey={documentKeepAliveKey(
            projectId,
            fileName,
            current.navigation,
            current.navigationAttempt,
          )}
          src={current.navigation.url}
          sandbox={previewSessionFramePolicy(current.navigation.sandboxProfile).sandbox}
          allow={previewSessionFramePolicy(current.navigation.sandboxProfile).allow}
          data-testid="preview-runtime-frame-current"
          data-od-active={presented ? 'true' : 'false'}
          aria-hidden={presented ? undefined : 'true'}
          tabIndex={active && presented ? 0 : -1}
        />
      ) : null}
      {standby ? (
        <PooledIframe
          key={documentKeepAliveKey(projectId, fileName, standby, navigationRetryToken)}
          {...commonProps}
          ref={onStandbyFrameChange}
          cacheKey={documentKeepAliveKey(projectId, fileName, standby, navigationRetryToken)}
          src={standby.url}
          sandbox={previewSessionFramePolicy(standby.sandboxProfile).sandbox}
          allow={previewSessionFramePolicy(standby.sandboxProfile).allow}
          data-testid="preview-runtime-frame-standby"
          data-od-active="false"
          data-od-standby="true"
          aria-hidden="true"
          tabIndex={-1}
          onLoad={(event) => promote(event.currentTarget)}
        />
      ) : null}
    </>
  );
}

function PreviewSessionFramesForFile({
  projectId,
  fileName,
  navigation,
  enabledCapabilities = EMPTY_CAPABILITIES,
  active,
  presented = active,
  navigationRetryToken = 0,
  onCurrentFrameChange,
  onStandbyFrameChange,
  onStandbyReady,
  onCapabilitiesApplied,
  onPromoted,
  onStandbyTimedOut,
  onStandbyVersionChanged,
  standbyTimeoutMs = PREVIEW_SESSION_STANDBY_TIMEOUT_MS,
  title = fileName,
  ...iframeProps
}: PreviewSessionFramesProps) {
  const pool = useIframeKeepAlivePool();
  const callbacksRef = useRef({
    onCurrentFrameChange,
    onStandbyFrameChange,
    onStandbyReady,
    onCapabilitiesApplied,
    onPromoted,
    onStandbyTimedOut,
    onStandbyVersionChanged,
  });
  const frameByTargetRef = useRef(new Map<PreviewRuntimeMessageTarget, HTMLIFrameElement>());
  const attemptByTargetRef = useRef(new Map<PreviewRuntimeMessageTarget, number>());
  const standbyTargetRef = useRef<PreviewRuntimeMessageTarget | null>(null);
  callbacksRef.current = {
    onCurrentFrameChange,
    onStandbyFrameChange,
    onStandbyReady,
    onCapabilitiesApplied,
    onPromoted,
    onStandbyTimedOut,
    onStandbyVersionChanged,
  };
  const [current, setCurrent] = useState<RenderedPreviewDocument | null>(null);
  const [standbyFrame, setStandbyFrame] = useState<HTMLIFrameElement | null>(null);
  const [failedAttemptKey, setFailedAttemptKey] = useState<string | null>(null);
  const currentRef = useRef<RenderedPreviewDocument | null>(current);
  const failedAttemptKeyRef = useRef<string | null>(failedAttemptKey);
  currentRef.current = current;
  failedAttemptKeyRef.current = failedAttemptKey;
  const stalePoolKeysRef = useRef<string[]>([]);

  const session = useMemo(() => new PreviewSession({
    callbacks: {
      onStandbyReady(document) {
        const frame = frameByTargetRef.current.get(document.target);
        if (frame) callbacksRef.current.onStandbyReady?.(frame);
      },
      onCapabilitiesApplied(document, capabilities) {
        const frame = frameByTargetRef.current.get(document.target);
        if (frame) callbacksRef.current.onCapabilitiesApplied?.(frame, capabilities);
      },
      onPromoted(document, previous) {
        const frame = frameByTargetRef.current.get(document.target);
        const navigationAttempt = attemptByTargetRef.current.get(document.target);
        if (!frame || navigationAttempt === undefined) return;
        const next = { ...document, frame, navigationAttempt };
        setCurrent(next);
        callbacksRef.current.onPromoted?.(
          navigationOf(document),
          previous ? navigationOf(previous) : null,
        );
        if (previous) {
          const previousAttempt = attemptByTargetRef.current.get(previous.target);
          if (previousAttempt !== undefined) {
            stalePoolKeysRef.current.push(
              documentKeepAliveKey(projectId, fileName, previous, previousAttempt),
            );
          }
        }
      },
      onStandbyNavigationFailed(document, failure) {
        if (failure.reason !== 'version_changed') return;
        const frame = frameByTargetRef.current.get(document.target);
        const expectedAttempt = attemptByTargetRef.current.get(document.target);
        if (!frame || expectedAttempt === undefined) return;
        if (failure.navigationAttempt !== expectedAttempt) return;
        const failureKey = `${identityKey(document)}\0retry:${expectedAttempt}`;
        if (failedAttemptKeyRef.current === failureKey) return;
        failedAttemptKeyRef.current = failureKey;
        session.discardStandby(document);
        setFailedAttemptKey(failureKey);
        callbacksRef.current.onStandbyVersionChanged?.(
          navigationOf(document),
          currentRef.current ? navigationOf(currentRef.current) : null,
          expectedAttempt,
        );
        pool.evictFrame(frame);
      },
    },
  }), [fileName, pool, projectId]);

  useEffect(() => {
    session.setEnabledCapabilities(enabledCapabilities);
  }, [enabledCapabilities, session]);

  useEffect(() => {
    session.setSuspended(!active);
    callbacksRef.current.onCurrentFrameChange?.(active ? current?.frame ?? null : null);
  }, [active, current, session]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => session.handleMessage(event);
    window.addEventListener('message', handleMessage);
    // A cached scoped URL can execute the bootstrap during the child iframe's
    // layout effects, before this passive host listener exists. The bootstrap
    // answers probes idempotently, so repeat it only after the receive path is
    // live instead of relying on navigation timing.
    session.probe();
    return () => window.removeEventListener('message', handleMessage);
  }, [session]);

  useEffect(() => {
    for (const key of stalePoolKeysRef.current.splice(0)) pool.evict(key);
  });

  useEffect(() => () => {
    callbacksRef.current.onCurrentFrameChange?.(null);
  }, []);

  const requestedIsCurrent =
    sameIdentity(current, navigation)
    && current?.navigationAttempt === navigationRetryToken;
  const requestedStandby = requestedIsCurrent ? null : navigation;
  const standbyAttemptKey = requestedStandby
    ? `${identityKey(requestedStandby)}\0retry:${navigationRetryToken}`
    : null;
  const standby = standbyAttemptKey !== null && failedAttemptKey === standbyAttemptKey
    ? null
    : requestedStandby;
  useEffect(() => {
    if (
      !active
      || !standby
      || !standbyFrame
      || standbyTimeoutMs <= 0
      || standbyAttemptKey === null
    ) return undefined;
    const timeout = window.setTimeout(() => {
      session.discardStandby(standby);
      setFailedAttemptKey(standbyAttemptKey);
      callbacksRef.current.onStandbyTimedOut?.(
        standby,
        current ? navigationOf(current) : null,
      );
      pool.evictFrame(standbyFrame);
    }, standbyTimeoutMs);
    return () => window.clearTimeout(timeout);
  }, [
    active,
    current,
    pool,
    session,
    standby,
    standbyAttemptKey,
    standbyFrame,
    standbyTimeoutMs,
  ]);

  const stageFrame = useCallback((frame: HTMLIFrameElement | null) => {
    setStandbyFrame(frame);
    if (!frame) {
      const previousTarget = standbyTargetRef.current;
      if (previousTarget) {
        frameByTargetRef.current.delete(previousTarget);
        attemptByTargetRef.current.delete(previousTarget);
      }
      standbyTargetRef.current = null;
      if (standby) session.discardStandby(standby);
      callbacksRef.current.onStandbyFrameChange?.(null);
      return;
    }
    if (!standby) return;
    const target = frame.contentWindow;
    if (!target) return;
    standbyTargetRef.current = target;
    frameByTargetRef.current.set(target, frame);
    attemptByTargetRef.current.set(target, navigationRetryToken);
    session.stageDocument({ ...standby, runtimeProtocol: 'universal', target });
    callbacksRef.current.onStandbyFrameChange?.(frame);
  }, [navigationRetryToken, session, standby]);

  const retainCurrentFrame = useCallback((frame: HTMLIFrameElement | null) => {
    if (!current) return;
    if (!frame) {
      frameByTargetRef.current.delete(current.target);
      attemptByTargetRef.current.delete(current.target);
      return;
    }
    frameByTargetRef.current.set(current.target, frame);
    // Promotion reuses the same pooled iframe component but swaps its ref
    // from stageFrame to retainCurrentFrame. stageFrame(null) deliberately
    // clears the standby bookkeeping during that handoff, so restore the
    // attempt associated with the now-current message target here.
    attemptByTargetRef.current.set(current.target, current.navigationAttempt);
  }, [current]);

  const commonProps = {
    ...iframeProps,
    title,
    'data-od-render-mode': 'runtime-url',
    'data-od-runtime-protocol': 'universal',
    'data-od-session-id': navigation.sessionId,
    'data-od-document-version': navigation.documentVersion,
  };

  return (
    <>
      {current ? (
        <PooledIframe
          key={documentKeepAliveKey(
            projectId,
            fileName,
            current,
            current.navigationAttempt,
          )}
          {...commonProps}
          ref={retainCurrentFrame}
          cacheKey={documentKeepAliveKey(
            projectId,
            fileName,
            current,
            current.navigationAttempt,
          )}
          src={previewSessionNavigationAttemptUrl(current, current.navigationAttempt)}
          sandbox={previewSessionFramePolicy(current.sandboxProfile).sandbox}
          allow={previewSessionFramePolicy(current.sandboxProfile).allow}
          data-od-powered={
            previewSessionFramePolicy(current.sandboxProfile).powered ? 'true' : undefined
          }
          data-testid="preview-runtime-frame-current"
          data-od-active={presented ? 'true' : 'false'}
          aria-hidden={presented ? undefined : 'true'}
          tabIndex={active && presented ? 0 : -1}
        />
      ) : null}
      {standby ? (
        <PooledIframe
          key={documentKeepAliveKey(projectId, fileName, standby, navigationRetryToken)}
          {...commonProps}
          ref={stageFrame}
          cacheKey={documentKeepAliveKey(projectId, fileName, standby, navigationRetryToken)}
          src={previewSessionNavigationAttemptUrl(standby, navigationRetryToken)}
          sandbox={previewSessionFramePolicy(standby.sandboxProfile).sandbox}
          allow={previewSessionFramePolicy(standby.sandboxProfile).allow}
          data-od-powered={
            previewSessionFramePolicy(standby.sandboxProfile).powered ? 'true' : undefined
          }
          data-testid="preview-runtime-frame-standby"
          data-od-active="false"
          data-od-standby="true"
          aria-hidden="true"
          tabIndex={-1}
        />
      ) : null}
    </>
  );
}

function navigationOf(document: PreviewSessionDocument): PreviewSessionNavigation {
  return {
    sessionId: document.sessionId,
    documentVersion: document.documentVersion,
    url: document.url,
    runtimeProtocol: document.runtimeProtocol,
    sandboxProfile: document.sandboxProfile,
    deck: document.deck,
  };
}
