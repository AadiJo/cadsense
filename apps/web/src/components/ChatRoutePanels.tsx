import { scopeThreadRef } from "@cadsense/client-runtime";
import type { EnvironmentId, ThreadId } from "@cadsense/contracts";
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useMatch, useNavigate } from "@tanstack/react-router";

import { ChatDiffSheetPanels, DiffPanelInlineSidebar } from "./ChatDiffRoutePanels";
import {
  finalizePromotedDraftThreadByRef,
  DraftId,
  useComposerDraftStore,
} from "../composerDraftStore";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import { stripDiffSearchParams } from "../diffRouteSearch";
import { selectEnvironmentState, selectThreadExistsByRef, useStore } from "../store";
import {
  createThreadSelectorAcrossEnvironments,
  createThreadSelectorByRef,
} from "../storeSelectors";
import { threadHasStarted } from "../threadLifecycle";
import { buildThreadRouteParams } from "../threadRoutes";

const THREAD_ROUTE_ID = "/_chat/$environmentId/$threadId" as const;
const DRAFT_ROUTE_ID = "/_chat/draft/$draftId" as const;

interface ChatRoutePanelsContextValue {
  readonly markDiffOpened: () => void;
}

const ChatRoutePanelsContext = createContext<ChatRoutePanelsContextValue | null>(null);

export function useChatRoutePanelsMarkOpened(): (() => void) | undefined {
  return useContext(ChatRoutePanelsContext)?.markDiffOpened;
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

  const environmentHasAnyThreads = environmentHasServerThreads || environmentHasDraftThreads;

  const isThreadRoute = Boolean(threadMatch && threadRef && bootstrapComplete && routeThreadExists);
  const isDraftRouteWithPanels = Boolean(draftMatch && draftId && draftSession);
  const diffOpen = (threadMatch?.search.diff ?? draftMatch?.search.diff) === "1";

  const setDiffOpen = useCallback(
    (open: boolean) => {
      if (threadMatch && threadRef) {
        void navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: threadRef.environmentId,
            threadId: threadRef.threadId,
          },
          replace: true,
          search: (previous) => {
            const rest = stripDiffSearchParams(previous);
            return open ? { ...rest, diff: "1" } : { ...rest, diff: undefined };
          },
        });
        return;
      }

      if (draftMatch && draftId) {
        void navigate({
          to: "/draft/$draftId",
          params: { draftId },
          replace: true,
          search: (previous) => {
            const rest = stripDiffSearchParams(previous);
            return open ? { ...rest, diff: "1" } : { ...rest, diff: undefined };
          },
        });
      }
    },
    [draftId, draftMatch, navigate, threadMatch, threadRef],
  );

  const markDiffOpened = useCallback(() => {
    setDiffOpen(true);
  }, [setDiffOpen]);

  const panelsContextValue = useMemo(() => ({ markDiffOpened }), [markDiffOpened]);

  const closeDiff = useCallback(() => setDiffOpen(false), [setDiffOpen]);
  const openDiff = useCallback(() => setDiffOpen(true), [setDiffOpen]);

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
          renderDiffContent={diffOpen}
          renderCadPanel
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
        shouldRenderDiffContent={diffOpen}
        renderCadPanel
      />
    </ChatRoutePanelsContext.Provider>
  );
}
