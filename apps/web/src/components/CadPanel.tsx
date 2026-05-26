import type {
  CadView,
  CadViewCommand,
  OnshapeSyncedCadFile,
  ScopedThreadRef,
} from "@cadsense/contracts";
import {
  BoxIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  Maximize2Icon,
  Minimize2Icon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import {
  isSupportedCadModelPath,
  isObjPreviewCompanionPath,
  OBJ_MTLLIB_SCAN_MAX_BYTES,
  parseObjMtllibFilenames,
  SUPPORTED_CAD_MODEL_EXTENSIONS,
} from "@cadsense/shared/cad";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { useComposerDraftStore, DraftId } from "../composerDraftStore";
import { readEnvironmentApi } from "../environmentApi";
import { buildCadWebGlFailureUserMessage } from "../lib/cadViewerWebGl";
import {
  deriveCadAgentViewStateForThread,
  latestCadAgentViewState,
} from "../lib/cadAgentViewState";
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
  threadRef?: ScopedThreadRef;
  agentControlHost?: boolean;
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

function LocalCadOpenState(props: {
  error: string | null;
  onSelectFiles: (files: ReadonlyArray<File>) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const accept = useMemo(
    () => SUPPORTED_CAD_MODEL_EXTENSIONS.map((extension) => `.${extension}`).join(","),
    [],
  );

  const openPicker = useCallback(() => {
    inputRef.current?.click();
  }, []);

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-card/20 p-6">
      <div className="grid max-w-sm justify-items-center text-center">
        <button
          type="button"
          className="group flex size-16 items-center justify-center rounded-xl border border-border/75 bg-background/80 shadow-sm transition-[border-color,background-color,box-shadow,transform] duration-180 ease-[var(--motion-ease-out)] hover:-translate-y-0.5 hover:border-primary/45 hover:bg-background hover:shadow-md"
          aria-label="Open a supported CAD file"
          onClick={openPicker}
        >
          <FolderOpenIcon className="size-8 text-muted-foreground transition-colors group-hover:text-foreground" />
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="sr-only"
          multiple
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            if (files.length > 0) {
              props.onSelectFiles(files);
            }
          }}
        />
        <div className="mt-4 text-sm font-medium">Open a supported CAD file</div>
        <div className="mt-1 max-w-xs text-sm leading-5 text-muted-foreground">
          Preview a local file for this project only, for example 3MF, STL, STEP, OBJ, or GLB.
          Select related OBJ material files and textures at the same time to preserve colors.
        </div>
        {props.error ? (
          <div className="mt-3 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">
            {props.error}
          </div>
        ) : null}
      </div>
    </div>
  );
}

const cadShellProps = {
  showHeader: false as const,
  header: null,
};

const CAD_MODEL_LOADING_TEXT_DELAY_MS = 350;
const CAD_FULLSCREEN_TRANSITION_MS = 260;
const CAD_FULLSCREEN_BEACON_RELEASE_MS = CAD_FULLSCREEN_TRANSITION_MS * 3;

interface CadAgentControlOverlayRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

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
  const [searchQuery, setSearchQuery] = useState("");
  const componentById = useMemo(() => {
    const components = new Map<string, CadViewerFrameComponentNode>();
    for (const component of props.components) {
      components.set(component.id, component);
    }
    return components;
  }, [props.components]);
  const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase();
  const visibleComponentIds = useMemo(() => {
    if (normalizedSearchQuery.length === 0) {
      return null;
    }
    const ids = new Set<string>();
    for (const component of props.components) {
      if (!component.name.toLocaleLowerCase().includes(normalizedSearchQuery)) {
        continue;
      }
      let current: CadViewerFrameComponentNode | undefined = component;
      while (current) {
        ids.add(current.id);
        current = current.parentId ? componentById.get(current.parentId) : undefined;
      }
    }
    return ids;
  }, [componentById, normalizedSearchQuery, props.components]);
  const childrenByParentId = useMemo(() => {
    const children = new Map<string | undefined, CadViewerFrameComponentNode[]>();
    for (const component of props.components) {
      if (visibleComponentIds && !visibleComponentIds.has(component.id)) {
        continue;
      }
      const siblings = children.get(component.parentId);
      if (siblings) {
        siblings.push(component);
      } else {
        children.set(component.parentId, [component]);
      }
    }
    return children;
  }, [props.components, visibleComponentIds]);
  const rootComponents = childrenByParentId.get(undefined) ?? [];

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
    const expanded = normalizedSearchQuery.length > 0 || (expandedById[component.id] ?? depth < 1);
    const visible = component.visible && parentVisible;
    return (
      <div key={component.id} className="cad-component-tree-row">
        <label
          className={cn(
            "group flex h-8 min-w-0 items-center gap-2 rounded-md border border-transparent pr-2 text-sm text-foreground/90 transition-[background-color,border-color,box-shadow,opacity,transform] duration-180 ease-[var(--motion-ease-out)] hover:border-border/65 hover:bg-background/58 hover:shadow-sm motion-safe:hover:translate-x-0.5",
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
          <span className="ml-auto hidden shrink-0 rounded-sm border border-border/50 px-1 py-0.5 text-[10px] uppercase tracking-[0.08em] text-muted-foreground/70 group-hover:inline-flex">
            {component.kind === "assembly" ? "Asm" : "Part"}
          </span>
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
    <div className="flex min-h-full flex-col gap-2">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
        <input
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.currentTarget.value)}
          placeholder="Search assembly"
          className="cad-hierarchy-search h-8 w-full rounded-md border border-border/70 bg-background/62 pl-8 pr-3 text-sm outline-none transition-[border-color,box-shadow,background-color] duration-180 ease-[var(--motion-ease-out)] placeholder:text-muted-foreground/50 focus:border-ring/50 focus:shadow-sm"
        />
      </div>
      <div className="space-y-0.5">
        {rootComponents.length > 0 ? (
          rootComponents.map((component) => renderNode(component, 0, true))
        ) : (
          <div className="rounded-md border border-dashed border-border/70 px-3 py-4 text-xs leading-relaxed text-muted-foreground">
            No matching components.
          </div>
        )}
      </div>
    </div>
  );
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error || "CAD viewer request failed."));
}

export default function CadPanel({
  mode = "inline",
  threadRef: explicitThreadRef,
  agentControlHost = false,
}: CadPanelProps) {
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
  const resolvedThreadRef = explicitThreadRef ?? routeThreadRef;
  const activeThread = useStore(
    useMemo(() => createThreadSelectorByRef(resolvedThreadRef), [resolvedThreadRef]),
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
  const cadReviewInProgress = (activeThread?.reviews ?? []).some(
    (review) =>
      review.status === "requested" ||
      review.status === "planning" ||
      review.status === "capturing-baseline" ||
      review.status === "reviewing" ||
      review.status === "deep-diving" ||
      review.status === "synthesizing",
  );
  const cadUiStateKey =
    activeThread && activeThreadStarted
      ? activeThread.id
      : (activeThread?.projectId ?? draftSession?.projectId ?? null);
  const cadExploded = useUiStateStore((store) =>
    cadUiStateKey ? (store.cadExplodedByThreadId[cadUiStateKey] ?? false) : false,
  );
  const setCadExploded = useUiStateStore((store) => store.setCadExploded);
  const recordCadAgentViewCommand = useUiStateStore((store) => store.recordCadAgentViewCommand);
  const cadAgentViewState = useUiStateStore((store) =>
    cadReviewInProgress && cadRoutingThreadId
      ? (store.cadAgentViewStateByThreadId[cadRoutingThreadId] ?? null)
      : null,
  );
  const derivedCadAgentViewState = useStore(
    useMemo(
      () => (store) => {
        if (!cadReviewInProgress || !activeThread) {
          return null;
        }
        const environmentState = store.environmentStateById?.[activeThread.environmentId];
        if (!environmentState) {
          return null;
        }
        return deriveCadAgentViewStateForThread(environmentState, activeThread);
      },
      [activeThread, cadReviewInProgress],
    ),
  );
  const effectiveCadAgentViewState = useMemo(
    () => latestCadAgentViewState(derivedCadAgentViewState, cadAgentViewState),
    [cadAgentViewState, derivedCadAgentViewState],
  );
  const agentViewCommand = effectiveCadAgentViewState?.viewCommand ?? null;
  const agentExploded = effectiveCadAgentViewState?.exploded;
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
  const [fullscreenClosing, setFullscreenClosing] = useState(false);
  const [fullscreenEntering, setFullscreenEntering] = useState(false);
  const [fullscreenBeaconRect, setFullscreenBeaconRect] = useState<DOMRect | null>(null);
  const [fullscreenMistVisible, setFullscreenMistVisible] = useState(false);
  const [fullscreenMistOpaque, setFullscreenMistOpaque] = useState(false);
  const [components, setComponents] = useState<ReadonlyArray<CadViewerFrameComponentNode>>([]);
  const [localCadFiles, setLocalCadFiles] = useState<ReadonlyArray<OnshapeSyncedCadFile>>([]);
  const [localCadFileError, setLocalCadFileError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [agentControlOverlayRect, setAgentControlOverlayRect] =
    useState<CadAgentControlOverlayRect | null>(null);
  const fullscreenButtonRef = useRef<HTMLButtonElement>(null);
  const fullscreenCloseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fullscreenEnterTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const screenshotCaptureQueueRef = useRef<Promise<void>>(Promise.resolve());
  const loadStateRef = useRef(loadState);
  loadStateRef.current = loadState;

  const onshapeContext =
    activeProject?.externalContext?.provider === "onshape"
      ? activeProject.externalContext.onshape
      : activeThread?.externalContext?.provider === "onshape"
        ? activeThread.externalContext.onshape
        : null;
  const isOnshapeProject = onshapeContext !== null;
  const cwd =
    activeProject?.cwd ?? activeThread?.worktreePath ?? draftSession?.worktreePath ?? null;
  const environmentId = activeThread?.environmentId ?? draftSession?.environmentId;
  const environmentApi = environmentId ? readEnvironmentApi(environmentId) : undefined;
  const projectCadScopeKey = activeProject
    ? `${activeProject.environmentId}:${activeProject.id}`
    : (activeThread?.projectId ?? draftSession?.projectId ?? null);

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
    if (!isOnshapeProject) {
      return localCadFiles;
    }
    const files = filesQuery.data?.files ?? [];
    const preferredOnly = files.filter((file) => file.isPreferred);
    return preferredOnly.length > 0 ? preferredOnly : files;
  }, [filesQuery.data?.files, isOnshapeProject, localCadFiles]);
  modelFilesRef.current = modelFiles;

  const handleSelectLocalCadFiles = useCallback((files: ReadonlyArray<File>) => {
    const primaryFile = files[0];
    if (
      !primaryFile ||
      !isSupportedCadModelPath(primaryFile.name) ||
      isObjPreviewCompanionPath(primaryFile.name)
    ) {
      setLocalCadFileError("Choose a supported CAD file such as 3MF, STL, STEP, OBJ, or GLB.");
      return;
    }
    const nextFiles = files.map((file, index) => ({
      relativePath: file.name,
      url: URL.createObjectURL(file),
      isPreferred: index === 0,
      sizeBytes: file.size,
    }));
    setLocalCadFiles((previous) => {
      for (const file of previous) {
        if (file.url.startsWith("blob:")) {
          URL.revokeObjectURL(file.url);
        }
      }
      return nextFiles;
    });
    setLocalCadFileError(null);
    if (primaryFile.name.toLowerCase().endsWith(".obj")) {
      void primaryFile
        .slice(0, OBJ_MTLLIB_SCAN_MAX_BYTES)
        .text()
        .then((source) => {
          const selectedNames = new Set(files.map((file) => file.name.toLowerCase()));
          const missingMaterials = parseObjMtllibFilenames(source).filter(
            (name) =>
              !selectedNames.has(name.replaceAll("\\", "/").split("/").pop()!.toLowerCase()),
          );
          if (missingMaterials.length > 0) {
            setLocalCadFileError(
              `This OBJ references ${missingMaterials.slice(0, 3).join(", ")}. Select the OBJ together with its MTL and texture files to preserve colors.`,
            );
          }
        })
        .catch(() => undefined);
    }
  }, []);

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
    if (fullscreenEnterTimeoutRef.current) {
      clearTimeout(fullscreenEnterTimeoutRef.current);
      fullscreenEnterTimeoutRef.current = null;
    }
    setFullscreenBeaconRect(fullscreenButtonRef.current?.getBoundingClientRect() ?? null);
    setFullscreenClosing(false);
    setFullscreenEntering(true);
    setFullscreenMistVisible(true);
    setFullscreenMistOpaque(false);
    requestAnimationFrame(() => {
      setFullscreenMistOpaque(true);
      fullscreenEnterTimeoutRef.current = setTimeout(() => {
        setFullscreen(true);
        setFullscreenMounted(true);
        requestAnimationFrame(() => {
          setFullscreenMistOpaque(false);
        });
        fullscreenEnterTimeoutRef.current = setTimeout(() => {
          fullscreenEnterTimeoutRef.current = null;
          setFullscreenEntering(false);
          setFullscreenBeaconRect(null);
          setFullscreenMistVisible(false);
        }, CAD_FULLSCREEN_BEACON_RELEASE_MS);
      }, CAD_FULLSCREEN_TRANSITION_MS);
    });
  }, []);

  const closeFullscreen = useCallback(() => {
    if (fullscreenEnterTimeoutRef.current) {
      clearTimeout(fullscreenEnterTimeoutRef.current);
      fullscreenEnterTimeoutRef.current = null;
    }
    setFullscreenEntering(false);
    setFullscreenBeaconRect(null);
    setFullscreenMistVisible(false);
    setFullscreenMistOpaque(false);
    if (!fullscreenMounted) {
      setFullscreen(false);
      setFullscreenClosing(false);
      return;
    }
    setFullscreenClosing(true);
    setFullscreen(false);
    if (fullscreenCloseTimeoutRef.current) {
      clearTimeout(fullscreenCloseTimeoutRef.current);
    }
    fullscreenCloseTimeoutRef.current = setTimeout(() => {
      fullscreenCloseTimeoutRef.current = null;
      setFullscreenMounted(false);
      setFullscreenClosing(false);
    }, CAD_FULLSCREEN_TRANSITION_MS);
  }, [fullscreenMounted]);

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

  const applyCadViewCommand = useCallback(
    (command: CadViewCommand) => {
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
        if (cadUiStateKey) {
          setCadExploded(cadUiStateKey, command.exploded);
          return;
        }
        void postFrameRequest({ type: "set-exploded", enabled: command.exploded }, 3_000).catch(
          () => undefined,
        );
        return;
      }
      void postFrameRequest({ type: "zoom-to-fit" }, 3_000).catch(() => undefined);
    },
    [cadUiStateKey, postFrameRequest, setCadExploded, setFixedView, toggleComponent],
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
      if (fullscreenEnterTimeoutRef.current) {
        clearTimeout(fullscreenEnterTimeoutRef.current);
      }
      setFullscreenMistVisible(false);
      setFullscreenMistOpaque(false);
    },
    [],
  );

  useEffect(() => {
    setLocalCadFiles((previous) => {
      for (const file of previous) {
        if (file.url.startsWith("blob:")) {
          URL.revokeObjectURL(file.url);
        }
      }
      return [];
    });
    setLocalCadFileError(null);
  }, [projectCadScopeKey]);

  useEffect(
    () => () => {
      for (const file of localCadFiles) {
        if (file.url.startsWith("blob:")) {
          URL.revokeObjectURL(file.url);
        }
      }
    },
    [localCadFiles],
  );

  useEffect(() => {
    if (agentControlHost) {
      return;
    }
    document.body.classList.toggle("cad-fullscreen-mounted", fullscreenMounted);
    document.body.classList.toggle("cad-fullscreen-active", fullscreenMounted && fullscreen);
    return () => {
      document.body.classList.remove("cad-fullscreen-mounted");
      document.body.classList.remove("cad-fullscreen-active");
    };
  }, [agentControlHost, fullscreen, fullscreenMounted]);

  useEffect(() => {
    if (!cadReviewInProgress || agentControlHost) {
      setAgentControlOverlayRect(null);
      return;
    }
    const panel = panelRef.current;
    if (!panel) {
      setAgentControlOverlayRect(null);
      return;
    }

    let animationFrame = 0;
    const updateRect = () => {
      animationFrame = 0;
      const rect = panel.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        setAgentControlOverlayRect(null);
        return;
      }
      setAgentControlOverlayRect({
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      });
    };
    const scheduleUpdate = () => {
      if (animationFrame === 0) {
        animationFrame = requestAnimationFrame(updateRect);
      }
    };

    updateRect();
    const resizeObserver = new ResizeObserver(scheduleUpdate);
    resizeObserver.observe(panel);
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("scroll", scheduleUpdate, true);
    window.visualViewport?.addEventListener("resize", scheduleUpdate);
    window.visualViewport?.addEventListener("scroll", scheduleUpdate);

    return () => {
      if (animationFrame !== 0) {
        cancelAnimationFrame(animationFrame);
      }
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, true);
      window.visualViewport?.removeEventListener("resize", scheduleUpdate);
      window.visualViewport?.removeEventListener("scroll", scheduleUpdate);
    };
  }, [
    agentControlHost,
    cadReviewInProgress,
    fullscreenClosing,
    fullscreenEntering,
    fullscreenMounted,
  ]);

  useEffect(() => {
    if (!cadUiStateKey) {
      return;
    }
    setCadExploded(cadUiStateKey, agentExploded ?? false);
  }, [agentExploded, cadUiStateKey, modelFileIdentityKey, setCadExploded]);

  useEffect(() => {
    if (!environmentApi || !cadRoutingThreadId) {
      return;
    }
    return environmentApi.onshape.onCadViewCommand((command) => {
      if (cadRoutingThreadId && command.threadId !== cadRoutingThreadId) {
        return;
      }
      if (agentControlHost) {
        recordCadAgentViewCommand(cadRoutingThreadId, command);
      }
      applyCadViewCommand(command);
    });
  }, [
    cadRoutingThreadId,
    agentControlHost,
    applyCadViewCommand,
    environmentApi,
    recordCadAgentViewCommand,
  ]);

  useEffect(() => {
    if (loadState !== "loaded" || !agentViewCommand) {
      return;
    }
    applyCadViewCommand(agentViewCommand);
  }, [agentViewCommand, applyCadViewCommand, loadState]);

  useEffect(() => {
    if (!agentControlHost || !environmentApi || !cadRoutingThreadId) {
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
  }, [cadRoutingThreadId, agentControlHost, environmentApi, postFrameRequest]);

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
    if (!agentControlHost || !environmentApi || !cadRoutingThreadId) {
      return;
    }
    return environmentApi.onshape.onCadScreenshotRequest((req) => {
      if (cadRoutingThreadId && req.threadId !== cadRoutingThreadId) {
        return;
      }
      if (req.view) {
        recordCadAgentViewCommand(cadRoutingThreadId, {
          commandId: `capture:${req.requestId}`,
          type: "set-view",
          threadId: req.threadId,
          view: req.view,
          fit: req.fit,
          createdAt: new Date().toISOString(),
        });
      }
      const capture = async () => {
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
      };
      const queuedCapture = screenshotCaptureQueueRef.current.catch(() => undefined).then(capture);
      screenshotCaptureQueueRef.current = queuedCapture.catch(() => undefined);
      void queuedCapture;
    });
  }, [
    cadRoutingThreadId,
    agentControlHost,
    environmentApi,
    postFrameRequest,
    recordCadAgentViewCommand,
  ]);

  useEffect(() => {
    if (modelFiles.length === 0) {
      screenshotCaptureQueueRef.current = Promise.resolve();
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
    screenshotCaptureQueueRef.current = Promise.resolve();
    rejectAllPendingFrameRequests("CAD viewer model changed.");
    loadedFrameRequestKeyRef.current = null;
    frameLoadStartedAtRef.current = performance.now();
    setLoadState("loading");
    setLoadError(null);
    setFrameReadySequence(0);
    setFrameActive(true);
    setFrameKey((key) => key + 1);
  }, [modelFileIdentityKey, modelFiles, rejectAllPendingFrameRequests]);

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

  if (!isOnshapeProject) {
    if (localCadFiles.length === 0) {
      return (
        <DiffPanelShell mode={mode} {...cadShellProps}>
          <LocalCadOpenState error={localCadFileError} onSelectFiles={handleSelectLocalCadFiles} />
        </DiffPanelShell>
      );
    }
  }

  if (isOnshapeProject && !cwd) {
    return (
      <DiffPanelShell mode={mode} {...cadShellProps}>
        <CadPanelEmptyState
          title="CAD view unavailable"
          detail="This project does not have a workspace path."
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

  const fullscreenVisible = fullscreen && !fullscreenClosing;
  const fullscreenBeaconAnchored = fullscreenEntering && fullscreenBeaconRect !== null;
  const fullscreenChromeFadeClass = fullscreenMounted
    ? cn(
        "transition-opacity duration-260 ease-out motion-reduce:transition-none",
        fullscreenClosing ? "opacity-0" : "opacity-100",
      )
    : undefined;
  const fullscreenButtonShowsExit = fullscreenMounted || fullscreenEntering;
  const fullscreenButtonStyle = fullscreenBeaconAnchored
    ? ({
        position: "fixed",
        zIndex: 70,
        left: fullscreenBeaconRect.left,
        top: fullscreenBeaconRect.top,
        width: fullscreenBeaconRect.width,
        height: fullscreenBeaconRect.height,
      } as const)
    : ({
        position: "absolute",
        zIndex: 70,
        right: fullscreenMounted ? 16 : 8,
        top: fullscreenMounted ? 56 : 8,
      } as const);
  const fullscreenControl = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            ref={fullscreenButtonRef}
            aria-label={fullscreenButtonShowsExit ? "Exit fullscreen CAD view" : "Expand CAD view"}
            className={cn(
              "border-border/70 bg-background/90 shadow-sm backdrop-blur motion-safe:hover:translate-y-0 hover:bg-background",
            )}
            size="icon-sm"
            style={fullscreenButtonStyle}
            variant="outline"
            onClick={fullscreenButtonShowsExit ? closeFullscreen : openFullscreen}
          >
            {fullscreenButtonShowsExit ? <Minimize2Icon /> : <Maximize2Icon />}
          </Button>
        }
      />
      <TooltipPopup side="left">
        {fullscreenButtonShowsExit ? "Exit fullscreen CAD view" : "Expand CAD view"}
      </TooltipPopup>
    </Tooltip>
  );
  const fullscreenMist =
    fullscreenMistVisible && typeof document !== "undefined"
      ? createPortal(
          <div
            className={cn(
              "pointer-events-none bg-background/96 backdrop-blur transition-opacity duration-260 ease-out motion-reduce:transition-none",
              fullscreenMistOpaque ? "opacity-100" : "opacity-0",
            )}
            style={{ position: "fixed", inset: 0, zIndex: 60 }}
          />,
          document.body,
        )
      : null;
  const fullscreenControlPortal =
    fullscreenBeaconAnchored && typeof document !== "undefined"
      ? createPortal(fullscreenControl, document.body)
      : null;
  const agentControlOverlay =
    cadReviewInProgress &&
    !agentControlHost &&
    agentControlOverlayRect &&
    typeof document !== "undefined"
      ? createPortal(
          <div
            aria-hidden="true"
            className="cad-agent-control-overlay pointer-events-none fixed"
            data-cad-agent-control-overlay="true"
            style={{
              left: agentControlOverlayRect.left,
              top: agentControlOverlayRect.top,
              width: agentControlOverlayRect.width,
              height: agentControlOverlayRect.height,
            }}
          >
            <div className="cad-agent-control-glow" />
            <div className="cad-agent-control-frame" />
          </div>,
          document.body,
        )
      : null;

  return (
    <DiffPanelShell mode={mode} {...cadShellProps}>
      <div
        ref={panelRef}
        className={cn(
          "relative min-h-0 flex-1 bg-card/20",
          !fullscreenMounted &&
            "transition-[background-color,box-shadow,outline-color] duration-260 ease-[var(--motion-ease-out)]",
          fullscreenMounted &&
            "fixed inset-0 z-50 grid grid-cols-[280px_minmax(0,1fr)] overflow-hidden bg-transparent shadow-2xl supports-[height:100dvh]:h-dvh",
        )}
      >
        {fullscreenMounted ? (
          <div
            className={cn(
              "pointer-events-none absolute inset-0 bg-background/96 backdrop-blur transition-opacity duration-260 ease-out motion-reduce:transition-none",
              fullscreenVisible || fullscreenEntering ? "opacity-100" : "opacity-0",
            )}
          />
        ) : null}
        {fullscreenMounted ? (
          <aside
            className={cn(
              "cad-hierarchy-panel relative z-30 flex min-h-0 flex-col border-r border-border/80 shadow-xl",
              fullscreenChromeFadeClass,
            )}
          >
            <div className="border-b border-border/70 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  Assembly
                </div>
                <div className="rounded-sm border border-border/70 bg-background/58 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {components.length} nodes
                </div>
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
            "relative isolate min-h-0",
            fullscreenMounted ? "h-full" : "size-full",
            fullscreenChromeFadeClass,
          )}
        >
          {frameActive ? (
            // oxlint-disable-next-line react/iframe-missing-sandbox -- The CAD viewer is a first-party same-origin module; sandboxing without same-origin breaks synced model fetches.
            <iframe
              key={frameKey}
              ref={iframeRef}
              title="CAD model viewer"
              src={cadViewerFrameUrl()}
              className="absolute inset-0 size-full border-0 bg-transparent"
            />
          ) : null}
          {cadReviewInProgress ? (
            <div
              className="absolute inset-0 z-[70] cursor-not-allowed"
              aria-hidden="true"
              data-cad-agent-control-interaction-blocker="true"
            />
          ) : null}
          {cadReviewInProgress ? (
            <div className="pointer-events-none absolute inset-x-0 top-4 z-[80] flex justify-center">
              <div className="cad-agent-control-pill rounded-full border border-emerald-300/80 bg-emerald-950/45 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-100 shadow-[0_0_20px_rgba(16,185,129,0.45)] backdrop-blur">
                Agent control
              </div>
            </div>
          ) : null}
          {loadState === "loading" && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/94 text-sm text-muted-foreground backdrop-blur-sm">
              <div
                className={cn(
                  "cad-loading-card app-glass-surface grid min-w-56 gap-3 rounded-md px-4 py-3 transition-[opacity,transform] duration-220 ease-[var(--motion-ease-out)]",
                  showLoadingText ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0",
                )}
              >
                <div className="flex items-center gap-3">
                  <div className="cad-loading-orbit size-6 rounded-md border border-primary/35" />
                  <div>
                    <div className="text-sm font-medium text-foreground">Loading CAD model</div>
                    <div className="text-xs text-muted-foreground">
                      Parsing geometry and preparing the scene
                    </div>
                  </div>
                </div>
              </div>
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
        {fullscreenBeaconAnchored ? null : fullscreenControl}
        {fullscreenControlPortal}
        {fullscreenMist}
        {agentControlOverlay}
      </div>
    </DiffPanelShell>
  );
}
