import type { CadView, OnshapeSyncedCadFile } from "@cadsense/contracts";
import {
  BoxIcon,
  ChevronRightIcon,
  FolderIcon,
  Maximize2Icon,
  Minimize2Icon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { useComposerDraftStore, DraftId } from "../composerDraftStore";
import { readEnvironmentApi } from "../environmentApi";
import { buildCadWebGlFailureUserMessage } from "../lib/cadViewerWebGl";
import {
  CAD_VIEWER_FRAME_PARENT_SOURCE,
  isCadViewerFrameResponse,
  type CadViewerFrameComponentNode,
  type CadViewerFrameLoadStats,
  type CadViewerFrameRequestInput,
} from "../lib/cadViewerFrameProtocol";
import { selectProjectByRef, useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { threadHasStarted } from "../threadLifecycle";
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
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

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

type CadViewerFrameResponsePayload = {
  readonly components?: ReadonlyArray<CadViewerFrameComponentNode>;
  readonly pngBase64?: string;
  readonly loadStats?: CadViewerFrameLoadStats;
};

interface PendingFrameRequest {
  readonly resolve: (payload: CadViewerFrameResponsePayload | undefined) => void;
  readonly reject: (error: Error) => void;
  readonly timeoutId: ReturnType<typeof setTimeout>;
}

function CadComponentTree(props: {
  components: ReadonlyArray<CadViewerFrameComponentNode>;
  onToggle: (component: CadViewerFrameComponentNode, visible: boolean) => void;
}) {
  const [expandedById, setExpandedById] = useState<Record<string, boolean>>({});
  const childrenByParentId = useMemo(() => {
    const children = new Map<string | undefined, CadViewerFrameComponentNode[]>();
    for (const component of props.components) {
      const siblings = children.get(component.parentId);
      if (siblings) {
        siblings.push(component);
      } else {
        children.set(component.parentId, [component]);
      }
    }
    return children;
  }, [props.components]);

  if (props.components.length === 0) {
    return (
      <div className="px-3 py-4 text-xs leading-relaxed text-muted-foreground">
        Component folders are available for synced 3MF assemblies.
      </div>
    );
  }

  const renderNode = (
    component: CadViewerFrameComponentNode,
    depth: number,
    parentVisible: boolean,
  ) => {
    const children = childrenByParentId.get(component.id) ?? [];
    const expanded = expandedById[component.id] ?? depth < 1;
    const visible = component.visible && parentVisible;
    return (
      <div key={component.id} className="cad-component-tree-row">
        <label
          className={cn(
            "group flex h-8 min-w-0 items-center gap-2 rounded-md pr-2 text-sm text-foreground/90 transition-[background-color,opacity,transform] duration-120 ease-out hover:bg-accent/55",
            !visible && "text-muted-foreground opacity-68",
          )}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
        >
          <button
            aria-label={expanded ? "Collapse CAD component" : "Expand CAD component"}
            className={cn(
              "flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-transform duration-150 ease-out hover:bg-accent",
              expanded && "rotate-90",
              children.length === 0 && "invisible",
            )}
            type="button"
            onClick={(event) => {
              event.preventDefault();
              setExpandedById((current) => ({
                ...current,
                [component.id]: !expanded,
              }));
            }}
          >
            <ChevronRightIcon className="size-3.5" />
          </button>
          <Checkbox
            checked={visible}
            onCheckedChange={(checked) => props.onToggle(component, checked === true)}
          />
          {component.kind === "assembly" ? (
            <FolderIcon className="size-4 shrink-0 text-muted-foreground/80" />
          ) : (
            <BoxIcon className="size-4 shrink-0 text-muted-foreground/80" />
          )}
          <span className="min-w-0 truncate">{component.name}</span>
        </label>
        <div
          className={cn(
            "grid transition-[grid-template-rows,opacity,transform] duration-160 ease-out",
            expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0 -translate-y-0.5",
          )}
        >
          <div className="min-h-0 overflow-hidden">
            {children.map((child) => renderNode(child, depth + 1, visible))}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-0.5">
      {(childrenByParentId.get(undefined) ?? []).map((component) => renderNode(component, 0, true))}
    </div>
  );
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
  const activeThreadStarted = threadHasStarted(activeThread);
  const cadUiStateKey =
    activeThread && activeThreadStarted
      ? activeThread.id
      : (activeThread?.projectId ?? draftSession?.projectId ?? null);
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
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenMounted, setFullscreenMounted] = useState(false);
  const [components, setComponents] = useState<ReadonlyArray<CadViewerFrameComponentNode>>([]);
  const fullscreenCloseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      new Promise<CadViewerFrameResponsePayload | undefined>((resolve, reject) => {
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

  const openFullscreen = useCallback(() => {
    if (fullscreenCloseTimeoutRef.current) {
      clearTimeout(fullscreenCloseTimeoutRef.current);
      fullscreenCloseTimeoutRef.current = null;
    }
    setFullscreenMounted(true);
    requestAnimationFrame(() => {
      setFullscreen(true);
    });
  }, []);

  const closeFullscreen = useCallback(() => {
    setFullscreen(false);
    if (fullscreenCloseTimeoutRef.current) {
      clearTimeout(fullscreenCloseTimeoutRef.current);
    }
    fullscreenCloseTimeoutRef.current = setTimeout(() => {
      fullscreenCloseTimeoutRef.current = null;
      setFullscreenMounted(false);
    }, 180);
  }, []);

  const refreshComponents = useCallback(() => {
    if (loadStateRef.current !== "loaded") {
      setComponents([]);
      return;
    }
    void postFrameRequest({ type: "get-components" }, 3_000)
      .then((result) => {
        setComponents(result?.components ?? []);
      })
      .catch(() => {
        setComponents([]);
      });
  }, [postFrameRequest]);

  const toggleComponent = useCallback(
    (component: CadViewerFrameComponentNode, visible: boolean) => {
      setComponents((current) =>
        current.map((item) => (item.id === component.id ? { ...item, visible } : item)),
      );
      void postFrameRequest(
        {
          type: "set-component-visibility",
          componentId: component.id,
          visible,
        },
        3_000,
      ).catch(() => {
        setComponents((current) =>
          current.map((item) =>
            item.id === component.id ? { ...item, visible: component.visible } : item,
          ),
        );
      });
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
    if (loadState !== "loaded") {
      setComponents([]);
      return;
    }
    refreshComponents();
  }, [loadState, modelFileIdentityKey, refreshComponents]);

  useEffect(() => {
    if (!fullscreenMounted) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeFullscreen();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [closeFullscreen, fullscreenMounted]);

  useEffect(
    () => () => {
      if (fullscreenCloseTimeoutRef.current) {
        clearTimeout(fullscreenCloseTimeoutRef.current);
      }
    },
    [],
  );

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
      if (command.type === "set-view") {
        setFixedView(command.view, command.fit);
        return;
      }
      if (loadStateRef.current !== "loaded") {
        return;
      }
      if (command.type === "set-camera") {
        const request =
          command.up === undefined
            ? {
                type: "set-camera" as const,
                direction: command.direction,
                fit: command.fit,
                closeUp: command.closeUp,
              }
            : {
                type: "set-camera" as const,
                direction: command.direction,
                up: command.up,
                fit: command.fit,
                closeUp: command.closeUp,
              };
        void postFrameRequest(request, 3_000).catch(() => undefined);
        return;
      }
      if (command.type === "set-component-visibility") {
        toggleComponent(
          {
            id: command.componentId,
            name: command.componentId,
            kind: "part",
            hasChildren: false,
            visible: !command.visible,
          },
          command.visible,
        );
        return;
      }
      if (command.type === "set-exploded") {
        void postFrameRequest({ type: "set-exploded", enabled: command.exploded }, 3_000).catch(
          () => undefined,
        );
        return;
      }
      void postFrameRequest({ type: "zoom-to-fit" }, 3_000).catch(() => undefined);
    });
  }, [cadRoutingThreadId, environmentApi, postFrameRequest, setFixedView, toggleComponent]);

  useEffect(() => {
    if (!environmentApi || !cadRoutingThreadId) {
      return;
    }
    return environmentApi.onshape.onCadHierarchyRequest((req) => {
      if (cadRoutingThreadId && req.threadId !== cadRoutingThreadId) {
        return;
      }
      void (async () => {
        try {
          const result =
            loadStateRef.current === "loaded"
              ? await postFrameRequest({ type: "get-components" }, 3_000)
              : undefined;
          await environmentApi.onshape.uploadCadHierarchy({
            requestId: req.requestId,
            components: result?.components ?? [],
          });
        } catch {
          await environmentApi.onshape
            .uploadCadHierarchy({ requestId: req.requestId, components: [] })
            .catch(() => undefined);
        }
      })();
    });
  }, [cadRoutingThreadId, environmentApi, postFrameRequest]);

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
          "relative min-h-0 flex-1 bg-card/20 transition-[background-color,box-shadow,outline-color,opacity,transform] duration-180 ease-out",
          fullscreenMounted &&
            "fixed inset-0 z-50 grid grid-cols-[280px_minmax(0,1fr)] bg-background/96 backdrop-blur supports-[height:100dvh]:h-dvh",
          fullscreenMounted && (fullscreen ? "opacity-100" : "opacity-0"),
          cadReviewInProgress && "cad-agent-control-frame",
        )}
      >
        {fullscreenMounted ? (
          <aside
            className={cn(
              "relative z-30 flex min-h-0 flex-col border-r border-border/80 bg-background/95 shadow-xl transition-[opacity,transform] duration-180 ease-out",
              fullscreen ? "translate-x-0 opacity-100" : "-translate-x-3 opacity-0",
            )}
          >
            <div className="border-b border-border/70 px-4 py-3">
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Worktree
              </div>
              <div className="mt-1 truncate text-sm font-medium">
                {modelFiles[0] ? cadViewerFileName(modelFiles[0].relativePath) : "CAD model"}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              <CadComponentTree components={components} onToggle={toggleComponent} />
            </div>
          </aside>
        ) : null}
        <div
          className={cn(
            "relative min-h-0 transition-[opacity,transform] duration-180 ease-out",
            fullscreenMounted ? "h-full" : "size-full",
            fullscreenMounted &&
              (fullscreen ? "scale-100 opacity-100" : "scale-[0.992] opacity-80"),
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
          <div
            className={cn(
              "absolute z-30 transition-[right,top,transform] duration-180 ease-out",
              fullscreenMounted ? "right-4 top-12" : "right-2 top-2",
              fullscreenMounted && fullscreen && "cad-fullscreen-exit-button",
            )}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={fullscreenMounted ? "Exit fullscreen CAD view" : "Expand CAD view"}
                    className="border-border/70 bg-background/90 shadow-sm backdrop-blur hover:bg-background"
                    size="icon-sm"
                    variant="outline"
                    onClick={fullscreenMounted ? closeFullscreen : openFullscreen}
                  >
                    {fullscreenMounted ? <Minimize2Icon /> : <Maximize2Icon />}
                  </Button>
                }
              />
              <TooltipPopup side="left">
                {fullscreenMounted ? "Exit fullscreen CAD view" : "Expand CAD view"}
              </TooltipPopup>
            </Tooltip>
          </div>
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
              fullscreen && "left-4 bottom-4",
              loadState !== "loaded" && "hidden",
            )}
          >
            Drag to rotate, scroll to zoom
          </div>
        </div>
      </div>
    </DiffPanelShell>
  );
}
