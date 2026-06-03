import { scopeProjectRef, scopeThreadRef } from "@cadsense/client-runtime";
import type { EnvironmentId, ThreadId } from "@cadsense/contracts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useMatch, useNavigate } from "@tanstack/react-router";

import { CadPanelInlineSidebar, ChatCadSheetPanel } from "./ChatCadRoutePanels";
import {
  finalizePromotedDraftThreadByRef,
  DraftId,
  useComposerDraftStore,
} from "../composerDraftStore";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import {
  selectEnvironmentState,
  selectProjectByRef,
  selectThreadExistsByRef,
  useStore,
} from "../store";
import {
  createThreadSelectorAcrossEnvironments,
  createThreadSelectorByRef,
} from "../storeSelectors";
import { threadHasProviderWorkStarted, threadHasStarted } from "../threadLifecycle";
import { buildThreadRouteParams } from "../threadRoutes";
import { isProjectlessChatProject } from "../projectlessChat";
import { readEnvironmentApi } from "../environmentApi";

const THREAD_ROUTE_ID = "/_chat/$environmentId/$threadId" as const;
const DRAFT_ROUTE_ID = "/_chat/draft/$draftId" as const;
const EMPTY_ROUTE_THREAD_IDS: readonly ThreadId[] = [];

interface ChatRoutePanelsContextValue {
  readonly cadPanelOpen: boolean;
  readonly setCadPanelOpen: (open: boolean) => void;
}

const ChatRoutePanelsContext = createContext<ChatRoutePanelsContextValue | null>(null);

export function useChatRoutePanelsState():
  | { readonly cadPanelOpen: boolean; readonly setCadPanelOpen: (open: boolean) => void }
  | undefined {
  return useContext(ChatRoutePanelsContext) ?? undefined;
}

export function ChatRoutePanelsProvider({ children }: { readonly children: ReactNode }) {
  const navigate = useNavigate();
  const threadMatch = useMatch({
    from: THREAD_ROUTE_ID,
    shouldThrow: false,
  });
  const draftMatch = useMatch({
    from: DRAFT_ROUTE_ID,
    shouldThrow: false,
  });

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
  const serverThreadProject = useStore(
    useMemo(
      () => (store: import("../store").AppState) =>
        serverThread
          ? selectProjectByRef(
              store,
              scopeProjectRef(serverThread.environmentId, serverThread.projectId),
            )
          : undefined,
      [serverThread],
    ),
  );
  const sameProjectThreadIds = useStore(
    useMemo(
      () => (store: import("../store").AppState) =>
        serverThread
          ? (store.environmentStateById[serverThread.environmentId]?.threadIdsByProjectId?.[
              serverThread.projectId
            ] ?? EMPTY_ROUTE_THREAD_IDS)
          : EMPTY_ROUTE_THREAD_IDS,
      [serverThread],
    ),
  );
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
  const draftProject = useStore(
    useMemo(
      () => (store: import("../store").AppState) =>
        draftSession
          ? selectProjectByRef(
              store,
              scopeProjectRef(draftSession.environmentId, draftSession.projectId),
            )
          : undefined,
      [draftSession],
    ),
  );
  const serverThreadForDraft = useStore(
    useMemo(
      () => createThreadSelectorAcrossEnvironments(draftSession?.threadId ?? null),
      [draftSession?.threadId],
    ),
  );
  const serverThreadStartedForDraft = threadHasProviderWorkStarted(serverThreadForDraft);
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

  const environmentHasAnyThreads = environmentHasServerThreads || environmentHasDraftThreads;

  const isThreadRoute = Boolean(threadMatch && threadRef && bootstrapComplete && routeThreadExists);
  const isDraftRouteWithPanels = Boolean(draftMatch && draftId && draftSession);
  const [cadPanelOpen, setCadPanelOpenState] = useState(false);
  const cadPanelOpenRef = useRef(cadPanelOpen);
  cadPanelOpenRef.current = cadPanelOpen;
  const isProjectlessRoute =
    isProjectlessChatProject(serverThreadProject) || isProjectlessChatProject(draftProject);
  const rightPanelsEnabled = (isThreadRoute || isDraftRouteWithPanels) && !isProjectlessRoute;

  const setCadPanelOpen = useCallback(
    (open: boolean) => {
      if (open && !rightPanelsEnabled) {
        return;
      }
      setCadPanelOpenState(open);
    },
    [rightPanelsEnabled],
  );

  const panelsContextValue = useMemo(
    () => ({ cadPanelOpen, setCadPanelOpen }),
    [cadPanelOpen, setCadPanelOpen],
  );

  const closeCadPanel = useCallback(() => setCadPanelOpen(false), [setCadPanelOpen]);
  const openCadPanel = useCallback(() => setCadPanelOpen(true), [setCadPanelOpen]);

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
    setCadPanelOpenState(false);
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
  const renderCadPanel = rightPanelsEnabled;

  useEffect(() => {
    if (isProjectlessRoute && cadPanelOpen) {
      setCadPanelOpen(false);
    }
  }, [cadPanelOpen, isProjectlessRoute, setCadPanelOpen]);

  useEffect(() => {
    if (!threadRef || !renderCadPanel) {
      return;
    }
    const activeEnvironmentId = threadRef.environmentId;
    const activeThreadId = threadRef.threadId;
    const handledThreadIds = new Set<ThreadId>([activeThreadId, ...sameProjectThreadIds]);
    const environmentApi = readEnvironmentApi(activeEnvironmentId);
    if (!environmentApi) {
      return;
    }

    const openForThread = (requestThreadId: ThreadId) => {
      if (!cadPanelOpenRef.current && handledThreadIds.has(requestThreadId)) {
        openCadPanel();
      }
    };

    const unsubscribers = [
      environmentApi.onshape.onCadViewCommand((command) => openForThread(command.threadId)),
      environmentApi.onshape.onCadHierarchyRequest((request) => openForThread(request.threadId)),
      environmentApi.onshape.onCadScreenshotRequest((request) => openForThread(request.threadId)),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }, [openCadPanel, renderCadPanel, sameProjectThreadIds, threadRef]);

  if (!rightPanelsEnabled) {
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
        <CadPanelInlineSidebar
          open={cadPanelOpen}
          onClose={closeCadPanel}
          onOpen={openCadPanel}
          shouldRender={cadPanelOpen || renderCadPanel}
        />
      </ChatRoutePanelsContext.Provider>
    );
  }

  return (
    <ChatRoutePanelsContext.Provider value={panelsContextValue}>
      {children}
      <ChatCadSheetPanel
        open={cadPanelOpen}
        onClose={closeCadPanel}
        shouldRender={cadPanelOpen || renderCadPanel}
      />
    </ChatRoutePanelsContext.Provider>
  );
}
