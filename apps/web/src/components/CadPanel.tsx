import type { CadView, OnshapeSyncedCadFile } from "@cadsense/contracts";
import { BoxIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { useComposerDraftStore, DraftId } from "../composerDraftStore";
import { readEnvironmentApi } from "../environmentApi";
import { buildCadWebGlFailureUserMessage } from "../lib/cadViewerWebGl";
import {
  CAD_VIEWER_FRAME_PARENT_SOURCE,
  isCadViewerFrameResponse,
  type CadViewerFrameLoadStats,
  type CadViewerFrameRequestInput,
} from "../lib/cadViewerFrameProtocol";
import { selectProjectByRef, useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { resolveThreadRouteRef } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { cn } from "../lib/utils";
import { DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import {
  CAD_MODEL_LOAD_TARGET_MS,
  CAD_MODEL_LOAD_TIMEOUT_MS,
  cadViewerFileName,
  cadViewerFrameUrl,
  getCadModelViewerBlocker,
} from "./CadPanel.logic";

interface CadPanelProps {
  mode?: DiffPanelMode;
}

function CadPanelEmptyState(props: { title: string; detail: string; icon?: "error" }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="max-w-sm text-center">
        <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-md border border-border bg-card">
          {props.icon === "error" ? (
            <XIcon className="size-5 text-destructive" />
          ) : (
            <BoxIcon className="size-5 text-muted-foreground" />
          )}
        </div>
        <div className="text-sm font-medium">{props.title}</div>
        <div className="mt-1 text-sm text-muted-foreground">{props.detail}</div>
      </div>
    </div>
  );
}

const cadShellProps = {
  showHeader: false as const,
  header: null,
};

const CAD_MODEL_LOADING_TEXT_DELAY_MS = 350;

interface PendingFrameRequest {
  readonly resolve: (
    payload:
      | { readonly pngBase64?: string; readonly loadStats?: CadViewerFrameLoadStats }
      | undefined,
  ) => void;
  readonly reject: (error: Error) => void;
  readonly timeoutId: ReturnType<typeof setTimeout>;
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error || "CAD viewer request failed."));
}

export default function CadPanel({ mode = "inline" }: CadPanelProps) {
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const routeDraftIdRaw = useParams({
    strict: false,
    select: (params) =>
      typeof params.draftId === "string" && params.draftId.length > 0 ? params.draftId : null,
  });
  const routeDraftId = useMemo(
    () => (routeDraftIdRaw ? DraftId.make(routeDraftIdRaw) : null),
    [routeDraftIdRaw],
  );
  const draftSession = useComposerDraftStore((store) =>
    routeDraftId ? store.getDraftSession(routeDraftId) : null,
  );
  const activeThread = useStore(
    useMemo(() => createThreadSelectorByRef(routeThreadRef), [routeThreadRef]),
  );
  /** Draft CAD uses `draftSession.threadId`; server threads use `activeThread.id` (must match MCP `CADSENSE_CAD_VIEW_THREAD_ID`). */
  const cadRoutingThreadId = useMemo(
    () => activeThread?.id ?? draftSession?.threadId,
    [activeThread?.id, draftSession?.threadId],
  );
  const activeProject = useStore((store) => {
    if (activeThread) {
      return selectProjectByRef(store, {
        environmentId: activeThread.environmentId,
        projectId: activeThread.projectId,
      });
    }
    if (draftSession) {
      return selectProjectByRef(store, {
        environmentId: draftSession.environmentId,
        projectId: draftSession.projectId,
      });
    }
    return undefined;
  });
  const cadUiStateKey = activeThread?.projectId ?? draftSession?.projectId ?? null;
  const cadExploded = useUiStateStore((store) =>
    cadUiStateKey ? (store.cadExplodedByThreadId[cadUiStateKey] ?? false) : false,
  );
  const setCadExploded = useUiStateStore((store) => store.setCadExploded);
  const cadZoomToFitRequest = useUiStateStore((store) =>
    cadUiStateKey ? (store.cadZoomToFitRequestByThreadId[cadUiStateKey] ?? 0) : 0,
  );
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const pendingFrameRequestsRef = useRef(new Map<string, PendingFrameRequest>());
  const frameRequestSequenceRef = useRef(0);
  const modelFilesRef = useRef<ReadonlyArray<OnshapeSyncedCadFile>>([]);
  const activeFrameLoadIdRef = useRef(0);
  const frameLoadStartedAtRef = useRef(0);
  const loadedFrameRequestKeyRef = useRef<string | null>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [frameActive, setFrameActive] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const [frameReadySequence, setFrameReadySequence] = useState(0);
  const [showLoadingText, setShowLoadingText] = useState(false);
  const loadStateRef = useRef(loadState);
  loadStateRef.current = loadState;

  const onshapeContext =
    activeProject?.externalContext?.provider === "onshape"
      ? activeProject.externalContext.onshape
      : activeThread?.externalContext?.provider === "onshape"
        ? activeThread.externalContext.onshape
        : null;
  const cwd =
    activeProject?.cwd ?? activeThread?.worktreePath ?? draftSession?.worktreePath ?? null;
  const environmentId = activeThread?.environmentId ?? draftSession?.environmentId;
  const environmentApi = environmentId ? readEnvironmentApi(environmentId) : undefined;
  const cadReviewInProgress = (activeThread?.reviews ?? []).some(
    (review) =>
      review.status === "requested" ||
      review.status === "capturing-baseline" ||
      review.status === "reviewing" ||
      review.status === "synthesizing",
  );

  const filesQuery = useQuery({
    queryKey: [
      "onshape-cad-files",
      environmentId,
      cwd,
      onshapeContext?.lastSyncedRelativePath,
      onshapeContext?.lastSyncedAt,
    ],
    enabled: Boolean(environmentApi && cwd && onshapeContext),
    queryFn: async () => {
      if (!environmentApi || !cwd) {
        return { files: [] };
      }
      return environmentApi.onshape.listSyncedCadFiles({
        cwd,
        ...(onshapeContext?.lastSyncedRelativePath
          ? { preferredRelativePath: onshapeContext.lastSyncedRelativePath }
          : {}),
      });
    },
  });

  const modelFiles = useMemo(() => {
    const files = filesQuery.data?.files ?? [];
    const preferredOnly = files.filter((file) => file.isPreferred);
    return preferredOnly.length > 0 ? preferredOnly : files;
  }, [filesQuery.data?.files]);
  modelFilesRef.current = modelFiles;

  const modelFileIdentityKey = useMemo(
    () => modelFiles.map((file) => `${file.url}:${file.sizeBytes ?? "unknown"}`).join("\0"),
    [modelFiles],
  );

  const rejectAllPendingFrameRequests = useCallback((message: string) => {
    for (const pending of pendingFrameRequestsRef.current.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error(message));
    }
    pendingFrameRequestsRef.current.clear();
  }, []);

  const postFrameRequest = useCallback(
    (
      request: CadViewerFrameRequestInput,
      timeoutMs = CAD_MODEL_LOAD_TIMEOUT_MS,
      transfer?: Transferable[],
    ) =>
      new Promise<
        { readonly pngBase64?: string; readonly loadStats?: CadViewerFrameLoadStats } | undefined
      >((resolve, reject) => {
        const targetWindow = iframeRef.current?.contentWindow;
        if (!targetWindow) {
          reject(new Error("CAD viewer frame is not available."));
          return;
        }

        const requestId = `cad-frame-${++frameRequestSequenceRef.current}`;
        const timeoutId = setTimeout(() => {
          pendingFrameRequestsRef.current.delete(requestId);
          reject(
            new Error(
              `The CAD viewer did not answer within ${(timeoutMs / 1000).toFixed(1)} seconds while handling '${request.type}'.`,
            ),
          );
        }, timeoutMs);
        pendingFrameRequestsRef.current.set(requestId, { resolve, reject, timeoutId });
        targetWindow.postMessage(
          {
            source: CAD_VIEWER_FRAME_PARENT_SOURCE,
            requestId,
            ...request,
          },
          "*",
          transfer ?? [],
        );
      }),
    [],
  );

  const setFixedView = useCallback(
    (view: CadView, fit = true) => {
      if (loadStateRef.current !== "loaded") {
        return;
      }
      void postFrameRequest({ type: "set-view", view, fit }, 3_000).catch(() => undefined);
    },
    [postFrameRequest],
  );

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      if (!isCadViewerFrameResponse(event.data)) {
        return;
      }
      if (iframeRef.current?.contentWindow && event.source !== iframeRef.current.contentWindow) {
        return;
      }
      if (event.data.type === "ready") {
        setFrameReadySequence((sequence) => sequence + 1);
        return;
      }
      if (event.data.type === "status") {
        console.info("CAD viewer frame status", {
          requestId: event.data.requestId,
          stage: event.data.stage,
          elapsedMs: event.data.elapsedMs,
        });
        return;
      }

      const pending = pendingFrameRequestsRef.current.get(event.data.requestId);
      if (!pending) {
        return;
      }
      pendingFrameRequestsRef.current.delete(event.data.requestId);
      clearTimeout(pending.timeoutId);

      if (event.data.ok) {
        pending.resolve(event.data.payload);
      } else {
        pending.reject(new Error(event.data.error));
      }
    };

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      rejectAllPendingFrameRequests("CAD viewer panel was closed.");
    };
  }, [rejectAllPendingFrameRequests]);

  useEffect(() => {
    if (loadState !== "loading") {
      setShowLoadingText(false);
      return;
    }

    setShowLoadingText(false);
    const timeoutId = setTimeout(() => {
      setShowLoadingText(true);
    }, CAD_MODEL_LOADING_TEXT_DELAY_MS);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [loadState]);

  useEffect(() => {
    if (!cadUiStateKey) {
      return;
    }
    setCadExploded(cadUiStateKey, false);
  }, [cadUiStateKey, modelFileIdentityKey, setCadExploded]);

  useEffect(() => {
    if (!environmentApi || !cadRoutingThreadId) {
      return;
    }
    return environmentApi.onshape.onCadViewCommand((command) => {
      if (cadRoutingThreadId && command.threadId !== cadRoutingThreadId) {
        return;
      }
      setFixedView(command.view, command.fit);
    });
  }, [cadRoutingThreadId, environmentApi, setFixedView]);

  useEffect(() => {
    if (loadState !== "loaded") {
      return;
    }
    void postFrameRequest({ type: "set-exploded", enabled: cadExploded }, 3_000).catch(
      () => undefined,
    );
  }, [cadExploded, loadState, postFrameRequest]);

  useEffect(() => {
    if (loadState !== "loaded" || cadZoomToFitRequest === 0) {
      return;
    }
    void postFrameRequest({ type: "zoom-to-fit" }, 3_000).catch(() => undefined);
  }, [cadZoomToFitRequest, loadState, postFrameRequest]);

  useEffect(() => {
    if (!environmentApi || !cadRoutingThreadId) {
      return;
    }
    return environmentApi.onshape.onCadScreenshotRequest((req) => {
      if (cadRoutingThreadId && req.threadId !== cadRoutingThreadId) {
        return;
      }
      void (async () => {
        try {
          // Wait up to 10 seconds for the frame to finish loading.
          let attempts = 0;
          while (loadStateRef.current !== "loaded" && attempts < 100) {
            if (loadStateRef.current === "error") {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
            attempts++;
          }

          if (loadStateRef.current !== "loaded") {
            await environmentApi.onshape.uploadCadScreenshot({
              requestId: req.requestId,
              pngBase64: "",
            });
            return;
          }

          const result = await postFrameRequest(
            {
              type: "capture",
              fit: req.fit,
              ...(req.view ? { view: req.view } : {}),
            },
            CAD_MODEL_LOAD_TIMEOUT_MS,
          );
          const pngBase64 = result?.pngBase64 ?? "";
          await environmentApi.onshape.uploadCadScreenshot({ requestId: req.requestId, pngBase64 });
        } catch {
          await environmentApi.onshape
            .uploadCadScreenshot({ requestId: req.requestId, pngBase64: "" })
            .catch(() => undefined);
        }
      })();
    });
  }, [cadRoutingThreadId, environmentApi, postFrameRequest]);

  useEffect(() => {
    if (modelFiles.length === 0) {
      activeFrameLoadIdRef.current += 1;
      rejectAllPendingFrameRequests("CAD viewer model changed.");
      loadedFrameRequestKeyRef.current = null;
      frameLoadStartedAtRef.current = 0;
      setFrameActive(false);
      setFrameReadySequence(0);
      setLoadState("idle");
      setLoadError(null);
      return;
    }

    const blocker = getCadModelViewerBlocker(modelFiles);
    if (blocker) {
      activeFrameLoadIdRef.current += 1;
      rejectAllPendingFrameRequests("CAD viewer model is too large.");
      loadedFrameRequestKeyRef.current = null;
      frameLoadStartedAtRef.current = 0;
      setFrameActive(false);
      setFrameReadySequence(0);
      setLoadState("error");
      setLoadError(blocker);
      return;
    }

    activeFrameLoadIdRef.current += 1;
    rejectAllPendingFrameRequests("CAD viewer model changed.");
    loadedFrameRequestKeyRef.current = null;
    frameLoadStartedAtRef.current = performance.now();
    setLoadState("loading");
    setLoadError(null);
    const hasLiveFrame = frameActive && iframeRef.current?.contentWindow;
    if (hasLiveFrame) {
      setFrameActive(true);
    } else {
      setFrameReadySequence(0);
      setFrameActive(true);
      setFrameKey((key) => key + 1);
    }
  }, [frameActive, modelFileIdentityKey, modelFiles, rejectAllPendingFrameRequests]);

  useEffect(() => {
    if (!frameActive || frameReadySequence === 0) {
      return;
    }

    const files = modelFilesRef.current;
    if (files.length === 0) {
      return;
    }

    const frameLoadId = activeFrameLoadIdRef.current;
    const requestKey = `${frameLoadId}:${frameReadySequence}:${modelFileIdentityKey}`;
    if (loadedFrameRequestKeyRef.current === requestKey) {
      return;
    }
    loadedFrameRequestKeyRef.current = requestKey;
    const loadStartedAt = frameLoadStartedAtRef.current || performance.now();

    void (async () => {
      try {
        const remainingLoadBudgetMs = Math.max(
          1,
          CAD_MODEL_LOAD_TIMEOUT_MS - (performance.now() - loadStartedAt),
        );
        const result = await postFrameRequest(
          {
            type: "load-file-urls",
            files: files.map((file) => {
              const name = cadViewerFileName(file.relativePath);
              const descriptor = {
                name,
                url: file.url,
              };
              if (name.toLowerCase().includes(".3mf")) {
                Object.assign(descriptor, { type: "model/3mf" });
              }
              return file.sizeBytes === undefined
                ? descriptor
                : Object.assign(descriptor, { sizeBytes: file.sizeBytes });
            }),
          },
          remainingLoadBudgetMs,
        );
        if (frameLoadId !== activeFrameLoadIdRef.current) {
          return;
        }
        if (result?.loadStats) {
          const log =
            result.loadStats.totalMs > CAD_MODEL_LOAD_TARGET_MS ? console.warn : console.info;
          log("CAD viewer loaded", {
            ...result.loadStats,
            targetMs: CAD_MODEL_LOAD_TARGET_MS,
          });
        }
        setLoadState("loaded");
        setLoadError(null);
      } catch (error) {
        if (frameLoadId !== activeFrameLoadIdRef.current) {
          return;
        }
        setFrameActive(false);
        setLoadState("error");
        setLoadError(
          buildCadWebGlFailureUserMessage(
            errorFromUnknown(error).message ||
              `The synced CAD file did not finish importing within ${CAD_MODEL_LOAD_TIMEOUT_MS / 1000} seconds. (Empty error received)`,
          ),
        );
      }
    })();
  }, [frameActive, frameReadySequence, modelFileIdentityKey, postFrameRequest]);

  if (!onshapeContext || !cwd) {
    return (
      <DiffPanelShell mode={mode} {...cadShellProps}>
        <CadPanelEmptyState
          title="CAD view unavailable"
          detail="This thread is not attached to an Onshape project."
        />
      </DiffPanelShell>
    );
  }

  if (filesQuery.isLoading) {
    return (
      <DiffPanelShell mode={mode} {...cadShellProps}>
        <div
          className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground"
          role="status"
          aria-live="polite"
          aria-label="Loading CAD files"
        >
          Loading CAD files…
        </div>
      </DiffPanelShell>
    );
  }

  if (modelFiles.length === 0) {
    return (
      <DiffPanelShell mode={mode} {...cadShellProps}>
        <CadPanelEmptyState
          title="No synced CAD model"
          detail="Sync this Onshape project to download an OBJ preview or other supported model file."
        />
      </DiffPanelShell>
    );
  }

  return (
    <DiffPanelShell mode={mode} {...cadShellProps}>
      <div
        className={cn(
          "relative min-h-0 flex-1 bg-card/20 transition-[box-shadow,outline-color] duration-500",
          cadReviewInProgress && "cad-agent-control-frame",
        )}
      >
        {frameActive ? (
          <iframe
            key={frameKey}
            ref={iframeRef}
            title="CAD model viewer"
            src={cadViewerFrameUrl()}
            sandbox="allow-scripts allow-same-origin"
            className="absolute inset-0 size-full border-0 bg-transparent"
          />
        ) : null}
        {cadReviewInProgress ? (
          <div className="pointer-events-none absolute inset-x-0 top-4 z-20 flex justify-center">
            <div className="cad-agent-control-pill rounded-full border border-emerald-300/80 bg-emerald-950/45 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-100 shadow-[0_0_20px_rgba(16,185,129,0.45)] backdrop-blur">
              Agent control
            </div>
          </div>
        ) : null}
        {loadState === "loading" && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background text-sm text-muted-foreground">
            <span
              className={cn(
                "transition-opacity duration-150 ease-out",
                showLoadingText ? "opacity-100" : "opacity-0",
              )}
            >
              Loading CAD model...
            </span>
          </div>
        )}
        {loadState === "error" && (
          <div className="absolute inset-0 bg-background">
            <CadPanelEmptyState
              title="Could not load CAD model"
              detail={loadError ?? "The viewer failed to import the synced model."}
              icon="error"
            />
          </div>
        )}
        <div
          className={cn(
            "pointer-events-none absolute bottom-2 left-2 rounded-md border border-border/70 bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm",
            loadState !== "loaded" && "hidden",
          )}
        >
          Drag to rotate, scroll to zoom
        </div>
      </div>
    </DiffPanelShell>
  );
}
