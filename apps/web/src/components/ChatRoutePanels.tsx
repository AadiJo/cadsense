import {
  scopeProjectRef,
  scopeThreadRef,
  scopedProjectKey,
  scopedThreadKey,
} from "@cadsense/client-runtime";
import type { EnvironmentId, ThreadId } from "@cadsense/contracts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useMatch, useNavigate } from "@tanstack/react-router";

import { threadHasStarted } from "./ChatView.logic";
import { ChatDiffSheetPanels, DiffPanelInlineSidebar } from "./ChatDiffRoutePanels";
import {
  finalizePromotedDraftThreadByRef,
  DraftId,
  useComposerDraftStore,
} from "../composerDraftStore";
import { parseDiffRouteSearch, stripDiffSearchParams } from "../diffRouteSearch";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import { selectEnvironmentState, selectThreadExistsByRef, useStore } from "../store";
import {
  createProjectSelectorByRef,
  createThreadSelectorAcrossEnvironments,
  createThreadSelectorByRef,
} from "../storeSelectors";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "../threadRoutes";

const THREAD_ROUTE_ID = "/_chat/$environmentId/$threadId" as const;
const DRAFT_ROUTE_ID = "/_chat/draft/$draftId" as const;

interface ChatRoutePanelsContextValue {
  readonly markDiffOpened: () => void;
}

const ChatRoutePanelsContext = createContext<ChatRoutePanelsContextValue | null>(null);

export function useChatRoutePanelsMarkOpened(): (() => void) | undefined {
  return useContext(ChatRoutePanelsContext)?.markDiffOpened;
}

function searchRecordFromLocationSearch(search: string): Record<string, unknown> {
  const params = new URLSearchParams(search);
  return Object.fromEntries(params.entries());
}

function coerceSearchRecordForDiffRoute(search: unknown): Record<string, unknown> {
  if (typeof search === "string") {
    return searchRecordFromLocationSearch(search);
  }
  if (search && typeof search === "object") {
    return search as Record<string, unknown>;
  }
  return {};
}

export function ChatRoutePanelsProvider({ children }: { readonly children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const threadMatch = useMatch({
    from: THREAD_ROUTE_ID,
    shouldThrow: false,
  });
  const draftMatch = useMatch({
    from: DRAFT_ROUTE_ID,
    shouldThrow: false,
  });

  const diffSearch = useMemo(
    () => parseDiffRouteSearch(coerceSearchRecordForDiffRoute(location.search)),
    [location.search],
  );
  const diffOpen = diffSearch.diff === "1";

  const threadRef = useMemo(() => {
    if (!threadMatch) {
      return null;
    }
    return scopeThreadRef(
      threadMatch.params.environmentId as EnvironmentId,
      threadMatch.params.threadId as ThreadId,
    );
  }, [threadMatch]);

  const draftId = useMemo(
    () => (draftMatch ? DraftId.make(draftMatch.params.draftId) : null),
    [draftMatch],
  );

  const bootstrapComplete = useStore(
    (store) => selectEnvironmentState(store, threadRef?.environmentId ?? null).bootstrapComplete,
  );
  const serverThread = useStore(useMemo(() => createThreadSelectorByRef(threadRef), [threadRef]));
  const threadExists = useStore((store) => selectThreadExistsByRef(store, threadRef));
  const environmentHasServerThreads = useStore(
    (store) => selectEnvironmentState(store, threadRef?.environmentId ?? null).threadIds.length > 0,
  );
  const draftThreadExists = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) !== null : false,
  );
  const draftThread = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) : null,
  );
  const environmentHasDraftThreads = useComposerDraftStore((store) => {
    if (!threadRef) {
      return false;
    }
    return store.hasDraftThreadsInEnvironment(threadRef.environmentId);
  });
  const routeThreadExists = threadExists || draftThreadExists;
  const serverThreadStarted = threadHasStarted(serverThread);

  const draftSession = useComposerDraftStore((store) =>
    draftId ? store.getDraftSession(draftId) : null,
  );
  const serverThreadForDraft = useStore(
    useMemo(
      () => createThreadSelectorAcrossEnvironments(draftSession?.threadId ?? null),
      [draftSession?.threadId],
    ),
  );
  const serverThreadStartedForDraft = threadHasStarted(serverThreadForDraft);
  const canonicalThreadRef = useMemo(
    () =>
      draftSession?.promotedTo
        ? serverThreadStartedForDraft
          ? draftSession.promotedTo
          : null
        : serverThreadForDraft
          ? {
              environmentId: serverThreadForDraft.environmentId,
              threadId: serverThreadForDraft.id,
            }
          : null,
    [draftSession?.promotedTo, serverThreadForDraft, serverThreadStartedForDraft],
  );

  const effectiveProjectRefForThread = useMemo(() => {
    if (serverThread) {
      return scopeProjectRef(serverThread.environmentId, serverThread.projectId);
    }
    if (draftThread) {
      return scopeProjectRef(draftThread.environmentId, draftThread.projectId);
    }
    return null;
  }, [draftThread, serverThread]);

  const resolvedProjectForThread = useStore(
    useMemo(
      () => createProjectSelectorByRef(effectiveProjectRefForThread),
      [effectiveProjectRefForThread],
    ),
  );

  const renderCadPanelForThread =
    serverThread?.externalContext?.provider === "onshape" ||
    resolvedProjectForThread?.externalContext?.provider === "onshape";

  const draftProjectRef = draftSession
    ? scopeProjectRef(draftSession.environmentId, draftSession.projectId)
    : null;
  const draftProject = useStore(
    useMemo(() => createProjectSelectorByRef(draftProjectRef), [draftProjectRef]),
  );
  const renderCadPanelForDraft = draftProject?.externalContext?.provider === "onshape";

  const environmentHasAnyThreads = environmentHasServerThreads || environmentHasDraftThreads;

  const isThreadRoute = Boolean(threadMatch && threadRef && bootstrapComplete && routeThreadExists);
  const isDraftRouteWithPanels = Boolean(draftMatch && draftId && draftSession);

  const renderCadPanel = isThreadRoute
    ? renderCadPanelForThread
    : isDraftRouteWithPanels
      ? renderCadPanelForDraft
      : false;

  const diffPanelMountScopeKey = useMemo(() => {
    if (isThreadRoute && renderCadPanel && effectiveProjectRefForThread) {
      return `cad:${scopedProjectKey(effectiveProjectRefForThread)}`;
    }
    if (isThreadRoute && threadRef) {
      return `thread:${scopedThreadKey(threadRef)}`;
    }
    if (isDraftRouteWithPanels && renderCadPanel && draftSession) {
      return `cad:${scopedProjectKey(scopeProjectRef(draftSession.environmentId, draftSession.projectId))}`;
    }
    if (isDraftRouteWithPanels && draftId) {
      return `draft:${draftId}`;
    }
    return null;
  }, [
    draftId,
    draftSession,
    effectiveProjectRefForThread,
    isDraftRouteWithPanels,
    isThreadRoute,
    renderCadPanel,
    threadRef,
  ]);

  const [diffPanelMountState, setDiffPanelMountState] = useState(() => ({
    scopeKey: diffPanelMountScopeKey,
    hasOpenedDiff: diffOpen,
  }));

  const hasOpenedDiff =
    diffPanelMountState.scopeKey === diffPanelMountScopeKey
      ? diffPanelMountState.hasOpenedDiff
      : diffOpen;

  const markDiffOpened = useCallback(() => {
    setDiffPanelMountState((previous) => {
      if (previous.scopeKey === diffPanelMountScopeKey && previous.hasOpenedDiff) {
        return previous;
      }
      return {
        scopeKey: diffPanelMountScopeKey,
        hasOpenedDiff: true,
      };
    });
  }, [diffPanelMountScopeKey]);

  const panelsContextValue = useMemo(() => ({ markDiffOpened }), [markDiffOpened]);

  const closeDiff = useCallback(() => {
    if (isThreadRoute && threadRef) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
        search: (previous) => stripDiffSearchParams(previous),
      });
      return;
    }
    if (isDraftRouteWithPanels && draftId) {
      void navigate({
        to: "/draft/$draftId",
        params: buildDraftThreadRouteParams(draftId),
        search: (previous) => stripDiffSearchParams(previous),
      });
    }
  }, [draftId, isDraftRouteWithPanels, isThreadRoute, navigate, threadRef]);

  const openDiff = useCallback(() => {
    markDiffOpened();
    if (isThreadRoute && threadRef) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
        search: (previous) => {
          const rest = stripDiffSearchParams(previous);
          return { ...rest, diff: "1" };
        },
      });
      return;
    }
    if (isDraftRouteWithPanels && draftId) {
      void navigate({
        to: "/draft/$draftId",
        params: buildDraftThreadRouteParams(draftId),
        search: (previous) => {
          const rest = stripDiffSearchParams(previous);
          return { ...rest, diff: "1" };
        },
      });
    }
  }, [draftId, isDraftRouteWithPanels, isThreadRoute, markDiffOpened, navigate, threadRef]);

  useEffect(() => {
    if (!threadRef || !bootstrapComplete) {
      return;
    }

    if (!routeThreadExists && environmentHasAnyThreads) {
      void navigate({ to: "/", replace: true });
    }
  }, [bootstrapComplete, environmentHasAnyThreads, navigate, routeThreadExists, threadRef]);

  useEffect(() => {
    if (!threadRef || !serverThreadStarted || !draftThread?.promotedTo) {
      return;
    }
    finalizePromotedDraftThreadByRef(threadRef);
  }, [draftThread?.promotedTo, serverThreadStarted, threadRef]);

  useEffect(() => {
    if (!canonicalThreadRef) {
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(canonicalThreadRef),
      replace: true,
    });
  }, [canonicalThreadRef, navigate]);

  useEffect(() => {
    if (draftSession || canonicalThreadRef || !draftMatch) {
      return;
    }
    void navigate({ to: "/", replace: true });
  }, [canonicalThreadRef, draftMatch, draftSession, navigate]);

  const shouldUseDiffSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const shouldRenderDiffContent = diffOpen || hasOpenedDiff;
  const showRightPanels = isThreadRoute || isDraftRouteWithPanels;

  if (!showRightPanels) {
    return (
      <ChatRoutePanelsContext.Provider value={panelsContextValue}>
        {children}
      </ChatRoutePanelsContext.Provider>
    );
  }

  if (!shouldUseDiffSheet) {
    return (
      <ChatRoutePanelsContext.Provider value={panelsContextValue}>
        {children}
        <DiffPanelInlineSidebar
          diffOpen={diffOpen}
          onCloseDiff={closeDiff}
          onOpenDiff={openDiff}
          renderDiffContent={shouldRenderDiffContent}
          renderCadPanel={renderCadPanel}
        />
      </ChatRoutePanelsContext.Provider>
    );
  }

  return (
    <ChatRoutePanelsContext.Provider value={panelsContextValue}>
      {children}
      <ChatDiffSheetPanels
        diffOpen={diffOpen}
        onCloseDiff={closeDiff}
        shouldRenderDiffContent={shouldRenderDiffContent}
        renderCadPanel={renderCadPanel}
      />
    </ChatRoutePanelsContext.Provider>
  );
}
