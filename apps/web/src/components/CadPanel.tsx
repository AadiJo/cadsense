import { scopedThreadKey, scopeThreadRef } from "@cadsense/client-runtime";
import {
  ThreadId,
  type CadHierarchyBrowserRequest,
  type CadHierarchyUploadInput,
  type CadScreenshotBrowserRequest,
  type CadView,
  type CadViewCommand,
  type OnshapeSyncedCadFile,
  type ScopedThreadRef,
} from "@cadsense/contracts";
import {
  BoxIcon,
  ChevronRightIcon,
  CircleIcon,
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
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { useComposerDraftStore, DraftId } from "../composerDraftStore";
import { readEnvironmentApi } from "../environmentApi";
import { buildCadWebGlFailureUserMessage } from "../lib/cadViewerWebGl";
import {
  registerCadBrokerResponder,
  uploadCadHierarchyCompletion,
  uploadCadScreenshotCompletion,
  type CadBrokerClaim,
} from "../lib/cadRequestBroker";
import {
  advanceCadViewerLifecycle,
  cadViewerLegacyLoadState,
  failCadViewerLifecycle,
  idleCadViewerLifecycle,
  initialCadViewerLifecycle,
  startCadViewerLifecycle,
} from "../lib/cadViewerLifecycle";
import { isRunningCadReviewStatus } from "../lib/cadReviewStatus";
import { cadViewLabel } from "../lib/cadView";
import {
  cadReviewChildThreadIdsForActiveReviewsInEnvironment,
  deriveCadAgentViewStateForThread,
  isCadRelatedToolActivity,
  latestCadAgentViewState,
} from "../lib/cadAgentViewState";
import {
  CAD_VIEWER_FRAME_PARENT_SOURCE,
  isCadViewerFrameResponse,
  type CadViewerFrameCameraSnapshot,
  type CadViewerFrameComponentNode,
  type CadViewerFrameLoadStats,
  type CadViewerFrameRequestInput,
} from "../lib/cadViewerFrameProtocol";
import { selectProjectByRef, useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { resolveThreadRouteRef } from "../threadRoutes";
import { useUiStateStore, type LocalCadFile } from "../uiStateStore";
import { cn } from "../lib/utils";
import { SidePanelShell, type SidePanelMode } from "./SidePanelShell";
import {
  CAD_MODEL_LOAD_TARGET_MS,
  CAD_MODEL_LOAD_TIMEOUT_MS,
  applyCadComponentVisibility,
  cadComponentVisibilityCommandsForScopeChange,
  cadOnshapeModelQueryIdentity,
  cadViewerFileName,
  cadViewerFrameUrl,
  getCadModelViewerBlocker,
} from "./CadPanel.logic";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const EMPTY_CAD_REQUEST_THREAD_IDS: readonly string[] = [];
const EMPTY_CAD_COMPONENT_VISIBILITY: Readonly<Record<string, boolean>> = {};

interface CadPanelProps {
  mode?: SidePanelMode;
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

function CadPanelLoadingState() {
  return (
    <div
      className="flex size-full min-h-0 flex-1 items-center justify-center bg-background/94 text-sm text-muted-foreground"
      role="status"
      aria-live="polite"
      aria-label="Loading CAD viewer"
    >
      <div className="grid min-w-56 gap-3 rounded-md border border-border/70 bg-background px-4 py-3 shadow-sm">
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
const CAD_AGENT_CONTROL_IDLE_TIMEOUT_MS = 3_000;
const CAD_AGENT_CONTROL_EXIT_MS = 420;
const CAD_FRAME_PROTOCOL_TIMEOUT_RECOVERY_THRESHOLD = 2;
const CAD_FRAME_READY_RECOVERY_TIMEOUT_MS = 10_000;
const CAD_AGENT_SCREENSHOT_CAPTURE_TIMEOUT_MS = 90_000;
const CAD_AGENT_SCREENSHOT_VIEWER_READY_TIMEOUT_MS = 25_000;
const EMPTY_LOCAL_CAD_FILES: readonly LocalCadFile[] = [];
const CAD_TOOLBAR_VIEWS: readonly CadView[] = [
  "isometric",
  "front",
  "back",
  "left",
  "right",
  "top",
  "bottom",
];

type CadHierarchyViewerStatus = NonNullable<CadHierarchyUploadInput["status"]>;

function cadHierarchyViewerUnavailableMessage(
  loadState: "idle" | "loading" | "loaded" | "error",
  loadError: string | null,
): { status: CadHierarchyViewerStatus; message: string } {
  if (loadState === "loading") {
    return {
      status: "loading",
      message:
        "CAD viewer is still loading the synced model. Retry this CAD hierarchy request at least two times before ending the turn back to the user; the panel often becomes ready on a later attempt.",
    };
  }
  if (loadState === "error") {
    return {
      status: "error",
      message: loadError
        ? `CAD viewer failed to load the synced model: ${loadError}`
        : "CAD viewer failed to load the synced model.",
    };
  }
  return {
    status: "unavailable",
    message:
      "CAD viewer is not ready yet, so the hierarchy is unavailable. Open or reload the CAD panel and retry once the model is visible.",
  };
}

type CadViewerFrameResponsePayload = {
  readonly components?: ReadonlyArray<CadViewerFrameComponentNode>;
  readonly pngBase64?: string;
  readonly loadStats?: CadViewerFrameLoadStats;
};

function makeManualCadCameraCommand(input: {
  readonly threadId: CadViewCommand["threadId"];
  readonly camera: CadViewerFrameCameraSnapshot;
  readonly createdAt?: string;
}): CadViewCommand {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return {
    commandId: `manual-camera-${createdAt}`,
    threadId: input.threadId,
    type: "set-camera",
    direction: input.camera.direction,
    up: input.camera.up,
    distance: input.camera.distance,
    fit: false,
    closeUp: false,
    createdAt,
  };
}

function makeManualCadViewCommand(input: {
  readonly threadId: CadViewCommand["threadId"];
  readonly view: CadView;
  readonly fit: boolean;
  readonly createdAt?: string;
}): CadViewCommand {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return {
    commandId: `manual-view-${input.view}-${createdAt}`,
    threadId: input.threadId,
    type: "set-view",
    view: input.view,
    fit: input.fit,
    createdAt,
  };
}

interface PendingFrameRequest {
  readonly resolve: (payload: CadViewerFrameResponsePayload | undefined) => void;
  readonly reject: (error: Error) => void;
  readonly timeoutId: ReturnType<typeof setTimeout>;
  readonly requestType: CadViewerFrameRequestInput["type"];
  readonly generation: number;
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

function cadToolActivitySignature(activity: {
  readonly id: string;
  readonly kind: string;
  readonly summary: string;
  readonly payload: unknown;
  readonly createdAt: string;
}): string {
  return JSON.stringify([
    activity.id,
    activity.kind,
    activity.summary,
    activity.createdAt,
    activity.payload,
  ]);
}

function CadViewerToolbarButton(props: {
  readonly label: string;
  readonly tooltip: string;
  readonly disabled: boolean;
  readonly pressed?: boolean;
  readonly onClick: () => void;
  readonly icon?: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={props.tooltip}
            aria-pressed={props.pressed}
            className={cn(
              "h-7 w-7 min-w-7 rounded-sm border-border/70 bg-background/78 px-1 text-[10px] font-semibold shadow-none backdrop-blur hover:bg-background",
              "data-[pressed=true]:border-primary/45 data-[pressed=true]:bg-primary/15 data-[pressed=true]:text-primary",
            )}
            data-pressed={props.pressed ? "true" : undefined}
            disabled={props.disabled}
            size="icon-sm"
            variant="outline"
            onClick={props.onClick}
          >
            {props.icon ?? props.label}
          </Button>
        }
      />
      <TooltipPopup side="top">{props.tooltip}</TooltipPopup>
    </Tooltip>
  );
}

function CadViewCubeIcon(props: { readonly view: CadView }) {
  const activeFace = (() => {
    switch (props.view) {
      case "top":
        return "top";
      case "bottom":
        return "bottom";
      case "left":
        return "left";
      case "right":
        return "right";
      case "back":
        return "back";
      case "front":
        return "front";
      case "isometric":
        return "isometric";
    }
  })();
  const faceClass = (face: typeof activeFace) =>
    cn(
      "stroke-current stroke-[1.15] transition-[fill,opacity,transform] duration-220 ease-[var(--motion-ease-out)]",
      activeFace === "isometric" || activeFace === face
        ? "fill-red-500/85 stroke-red-300 opacity-100"
        : "fill-background/78 opacity-72",
    );
  const hiddenFaceClass = (face: "back" | "bottom") =>
    cn(
      "stroke-current stroke-[1.15] transition-[fill,opacity] duration-220 ease-[var(--motion-ease-out)]",
      activeFace === face
        ? "fill-red-500/85 stroke-red-300 opacity-100"
        : "fill-muted/20 opacity-35",
    );

  return (
    <svg aria-hidden="true" className="size-5 text-foreground" fill="none" viewBox="0 0 32 32">
      <path className={hiddenFaceClass("back")} d="M16 4.2 26 9.9 16 15.6 6 9.9Z" />
      <path className={hiddenFaceClass("bottom")} d="M6 21.2 16 27.2 26 21.2 16 15.7Z" />
      <path className={faceClass("top")} d="M16 2.8 25.2 8.2 16 13.6 6.8 8.2Z" />
      <path className={faceClass("front")} d="M6.8 9.7 16 15 16 26 6.8 20.5Z" />
      <path className={faceClass("right")} d="M16 15 25.2 9.7 25.2 20.5 16 26Z" />
      <path className={faceClass("left")} d="M4.9 10.8 6.8 9.7 6.8 20.5 4.9 19.4Z" />
      <path className={faceClass("back")} d="M25.2 9.7 27.1 10.8 27.1 19.4 25.2 20.5Z" />
      <path
        className={faceClass("bottom")}
        d="M6.8 20.5 16 26 25.2 20.5 25.2 22.6 16 28.2 6.8 22.6Z"
      />
      <path
        className="stroke-current stroke-[1.25] opacity-45"
        d="M16 13.6v12.4M6.8 8.2v12.3M25.2 8.2v12.3"
      />
    </svg>
  );
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
  const environmentId = activeThread?.environmentId ?? draftSession?.environmentId;
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
  const activeCadReview = useMemo(
    () =>
      (activeThread?.reviews ?? [])
        .filter((review) => isRunningCadReviewStatus(review.status))
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null,
    [activeThread?.reviews],
  );
  const cadReviewInProgress = activeCadReview !== null;
  const [regularCadAgentControlActive, setRegularCadAgentControlActive] = useState(false);
  const [regularCadAgentControlExiting, setRegularCadAgentControlExiting] = useState(false);
  const cadAgentRequestResponderEnabled = true;
  const activeThreadStreaming =
    activeThread?.latestTurn?.state === "running" ||
    activeThread?.messages.some((message) => message.streaming) === true;
  const cadModelStreamingActive = !agentControlHost && activeThreadStreaming;
  const cadAgentControlActive = cadReviewInProgress || regularCadAgentControlActive;
  const cadAgentControlExiting = !cadReviewInProgress && regularCadAgentControlExiting;
  const cadInteractionBlocked = cadAgentControlActive || cadModelStreamingActive;
  const cadUiStateKey =
    environmentId && cadRoutingThreadId
      ? scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(cadRoutingThreadId)))
      : (activeThread?.projectId ?? draftSession?.projectId ?? null);
  const cadExploded = useUiStateStore((store) =>
    cadUiStateKey ? (store.cadExplodedByThreadId[cadUiStateKey] ?? false) : false,
  );
  const setCadExploded = useUiStateStore((store) => store.setCadExploded);
  const recordCadAgentViewCommand = useUiStateStore((store) => store.recordCadAgentViewCommand);
  const setCadComponentVisibility = useUiStateStore((store) => store.setCadComponentVisibility);
  const cadAgentViewState = useUiStateStore((store) =>
    cadUiStateKey ? (store.cadAgentViewStateByThreadId[cadUiStateKey] ?? null) : null,
  );
  const scopedCadAgentViewState = useMemo(() => {
    if (!cadAgentViewState) {
      return null;
    }
    if (activeCadReview && cadAgentViewState.updatedAt < activeCadReview.createdAt) {
      return null;
    }
    return cadAgentViewState;
  }, [activeCadReview, cadAgentViewState]);
  const activeEnvironmentState = useStore(
    useMemo(
      () => (store) =>
        activeThread ? store.environmentStateById?.[activeThread.environmentId] : undefined,
      [activeThread],
    ),
  );
  const derivedCadAgentViewState = useMemo(() => {
    if (!cadReviewInProgress || !activeThread || !activeEnvironmentState) {
      return null;
    }
    return deriveCadAgentViewStateForThread(activeEnvironmentState, activeThread);
  }, [activeEnvironmentState, activeThread, cadReviewInProgress]);
  const effectiveCadAgentViewState = useMemo(
    () => latestCadAgentViewState(derivedCadAgentViewState, scopedCadAgentViewState),
    [derivedCadAgentViewState, scopedCadAgentViewState],
  );
  const agentViewCommand = effectiveCadAgentViewState?.viewCommand ?? null;
  const agentExploded = effectiveCadAgentViewState?.exploded;
  const cadComponentVisibilityById =
    effectiveCadAgentViewState?.componentVisibilityById ?? EMPTY_CAD_COMPONENT_VISIBILITY;
  const cadZoomToFitRequest = useUiStateStore((store) =>
    cadUiStateKey ? (store.cadZoomToFitRequestByThreadId[cadUiStateKey] ?? 0) : 0,
  );
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const pendingFrameRequestsRef = useRef(new Map<string, PendingFrameRequest>());
  const frameRequestSequenceRef = useRef(0);
  const consecutiveFrameTimeoutsRef = useRef(0);
  const frameReadyRecoveryAttemptsRef = useRef(0);
  const skipLocalManualCameraReplayCommandIdsRef = useRef(new Set<string>());
  const modelFilesRef = useRef<ReadonlyArray<OnshapeSyncedCadFile>>([]);
  const activeFrameLoadIdRef = useRef(0);
  const frameLoadStartedAtRef = useRef(0);
  const loadedFrameRequestKeyRef = useRef<string | null>(null);
  const [viewerLifecycle, setViewerLifecycle] = useState(initialCadViewerLifecycle);
  const loadState = cadViewerLegacyLoadState(viewerLifecycle);
  const loadError = viewerLifecycle.status === "failed" ? viewerLifecycle.message : null;
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
  const [localCadFileError, setLocalCadFileError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const lastRegularCadToolActivitySignatureRef = useRef<string | null>(null);
  const regularCadAgentControlTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const regularCadAgentControlExitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handledCadAgentCommandIdsRef = useRef(new Set<string>());
  const fullscreenButtonRef = useRef<HTMLButtonElement>(null);
  const fullscreenCloseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fullscreenEnterTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const screenshotCaptureQueueRef = useRef<Promise<void>>(Promise.resolve());
  const appliedCadComponentVisibilityRef = useRef<Record<string, boolean>>({});
  const loadStateRef = useRef(loadState);
  loadStateRef.current = loadState;
  const loadErrorRef = useRef(loadError);
  loadErrorRef.current = loadError;
  const cadRoutingThreadIdRef = useRef(cadRoutingThreadId);
  cadRoutingThreadIdRef.current = cadRoutingThreadId;
  const cadUiStateKeyRef = useRef(cadUiStateKey);
  cadUiStateKeyRef.current = cadUiStateKey;
  const responderIdRef = useRef<string | null>(null);
  responderIdRef.current ??= `cad-viewer-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;

  const onshapeContext =
    activeProject?.externalContext?.provider === "onshape"
      ? activeProject.externalContext.onshape
      : activeThread?.externalContext?.provider === "onshape"
        ? activeThread.externalContext.onshape
        : null;
  const isOnshapeProject = onshapeContext !== null;
  const cwd =
    activeProject?.cwd ?? activeThread?.worktreePath ?? draftSession?.worktreePath ?? null;
  const environmentApi = environmentId ? readEnvironmentApi(environmentId) : undefined;
  const activeProjectId = activeProject?.id;
  const activeProjectEnvironmentId = activeProject?.environmentId;
  const sameProjectThreadIds = useStore(
    useMemo(
      () => (store) =>
        activeProjectEnvironmentId && activeProjectId
          ? (store.environmentStateById?.[activeProjectEnvironmentId]?.threadIdsByProjectId?.[
              activeProjectId
            ] ?? EMPTY_CAD_REQUEST_THREAD_IDS)
          : EMPTY_CAD_REQUEST_THREAD_IDS,
      [activeProjectEnvironmentId, activeProjectId],
    ),
  );
  const sameProjectReviewIdsByThreadId = useStore(
    useMemo(
      () => (store) =>
        activeProjectEnvironmentId
          ? store.environmentStateById?.[activeProjectEnvironmentId]?.reviewIdsByThreadId
          : undefined,
      [activeProjectEnvironmentId],
    ),
  );
  const sameProjectReviewByThreadId = useStore(
    useMemo(
      () => (store) =>
        activeProjectEnvironmentId
          ? store.environmentStateById?.[activeProjectEnvironmentId]?.reviewByThreadId
          : undefined,
      [activeProjectEnvironmentId],
    ),
  );
  const sameProjectActiveCadReviewThreadIds = useMemo(() => {
    const activeThreadIds: string[] = [];
    for (const projectThreadId of sameProjectThreadIds) {
      const reviewThreadId = ThreadId.make(projectThreadId);
      const reviewIds = sameProjectReviewIdsByThreadId?.[reviewThreadId] ?? [];
      const reviewsById = sameProjectReviewByThreadId?.[reviewThreadId] ?? {};
      const hasActiveReview = reviewIds.some((reviewId) => {
        const status = reviewsById[reviewId]?.status;
        return status ? isRunningCadReviewStatus(status) : false;
      });
      if (hasActiveReview) {
        activeThreadIds.push(reviewThreadId);
      }
    }
    return activeThreadIds.length > 0 ? activeThreadIds : EMPTY_CAD_REQUEST_THREAD_IDS;
  }, [sameProjectReviewByThreadId, sameProjectReviewIdsByThreadId, sameProjectThreadIds]);
  const activeCadReviewChildThreadIds = useMemo(
    () =>
      activeThread && activeEnvironmentState
        ? cadReviewChildThreadIdsForActiveReviewsInEnvironment(activeEnvironmentState, activeThread)
        : [],
    [activeEnvironmentState, activeThread],
  );
  const projectCadScopeKey = activeProject
    ? `${activeProject.environmentId}:${activeProject.id}`
    : (activeThread?.projectId ?? draftSession?.projectId ?? null);
  const localCadFiles = useUiStateStore((store) =>
    projectCadScopeKey
      ? (store.localCadFilesByScopeKey[projectCadScopeKey] ?? EMPTY_LOCAL_CAD_FILES)
      : EMPTY_LOCAL_CAD_FILES,
  );
  const setLocalCadFiles = useUiStateStore((store) => store.setLocalCadFiles);

  const activateRegularCadAgentControl = useCallback(
    (activitySignature: string) => {
      if (cadReviewInProgress || agentControlHost) {
        return;
      }
      if (lastRegularCadToolActivitySignatureRef.current === activitySignature) {
        return;
      }

      lastRegularCadToolActivitySignatureRef.current = activitySignature;
      setRegularCadAgentControlActive(true);
      setRegularCadAgentControlExiting(false);

      if (regularCadAgentControlTimeoutRef.current) {
        clearTimeout(regularCadAgentControlTimeoutRef.current);
      }
      if (regularCadAgentControlExitTimeoutRef.current) {
        clearTimeout(regularCadAgentControlExitTimeoutRef.current);
        regularCadAgentControlExitTimeoutRef.current = null;
      }
      regularCadAgentControlTimeoutRef.current = setTimeout(() => {
        regularCadAgentControlTimeoutRef.current = null;
        setRegularCadAgentControlExiting(true);
        regularCadAgentControlExitTimeoutRef.current = setTimeout(() => {
          regularCadAgentControlExitTimeoutRef.current = null;
          setRegularCadAgentControlActive(false);
          setRegularCadAgentControlExiting(false);
        }, CAD_AGENT_CONTROL_EXIT_MS);
      }, CAD_AGENT_CONTROL_IDLE_TIMEOUT_MS);
    },
    [agentControlHost, cadReviewInProgress],
  );

  useEffect(() => {
    lastRegularCadToolActivitySignatureRef.current = null;
    if (regularCadAgentControlTimeoutRef.current) {
      clearTimeout(regularCadAgentControlTimeoutRef.current);
      regularCadAgentControlTimeoutRef.current = null;
    }
    if (regularCadAgentControlExitTimeoutRef.current) {
      clearTimeout(regularCadAgentControlExitTimeoutRef.current);
      regularCadAgentControlExitTimeoutRef.current = null;
    }
    setRegularCadAgentControlActive(false);
    setRegularCadAgentControlExiting(false);
    return () => {
      if (regularCadAgentControlTimeoutRef.current) {
        clearTimeout(regularCadAgentControlTimeoutRef.current);
        regularCadAgentControlTimeoutRef.current = null;
      }
      if (regularCadAgentControlExitTimeoutRef.current) {
        clearTimeout(regularCadAgentControlExitTimeoutRef.current);
        regularCadAgentControlExitTimeoutRef.current = null;
      }
    };
  }, [activeThread?.id]);

  useEffect(() => {
    if (cadReviewInProgress || agentControlHost || !activeThread) {
      if (regularCadAgentControlTimeoutRef.current) {
        clearTimeout(regularCadAgentControlTimeoutRef.current);
        regularCadAgentControlTimeoutRef.current = null;
      }
      if (regularCadAgentControlExitTimeoutRef.current) {
        clearTimeout(regularCadAgentControlExitTimeoutRef.current);
        regularCadAgentControlExitTimeoutRef.current = null;
      }
      lastRegularCadToolActivitySignatureRef.current = null;
      setRegularCadAgentControlActive(false);
      setRegularCadAgentControlExiting(false);
      return;
    }

    const activeTurnId = activeThread.latestTurn?.turnId;
    if (!activeTurnId) {
      return;
    }
    const latestCadToolActivity = activeThread.activities.findLast(
      (activity) => activity.turnId === activeTurnId && isCadRelatedToolActivity(activity),
    );
    if (!latestCadToolActivity) {
      return;
    }

    const activitySignature = cadToolActivitySignature(latestCadToolActivity);
    if (!activeThreadStreaming) {
      return;
    }

    activateRegularCadAgentControl(activitySignature);
  }, [
    activateRegularCadAgentControl,
    activeThread,
    activeThread?.activities,
    activeThreadStreaming,
    agentControlHost,
    cadReviewInProgress,
  ]);

  const filesQuery = useQuery({
    queryKey: [
      "onshape-cad-files",
      environmentId,
      cwd,
      ...cadOnshapeModelQueryIdentity(onshapeContext),
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

  const handleSelectLocalCadFiles = useCallback(
    (files: ReadonlyArray<File>) => {
      const primaryFile = files[0];
      if (
        !primaryFile ||
        !projectCadScopeKey ||
        !isSupportedCadModelPath(primaryFile.name) ||
        isObjPreviewCompanionPath(primaryFile.name)
      ) {
        setLocalCadFileError("Choose a supported CAD file such as 3MF, STL, STEP, OBJ, or GLB.");
        return;
      }
      const nextFiles: LocalCadFile[] = files.map((file, index) => ({
        relativePath: file.name,
        url: URL.createObjectURL(file),
        isPreferred: index === 0,
        sizeBytes: file.size,
      }));
      for (const file of localCadFiles) {
        if (file.url.startsWith("blob:")) {
          URL.revokeObjectURL(file.url);
        }
      }
      setLocalCadFiles(projectCadScopeKey, nextFiles);
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
    },
    [localCadFiles, projectCadScopeKey, setLocalCadFiles],
  );

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

  const recycleCadViewerFrameAfterTimeout = useCallback(() => {
    if (modelFilesRef.current.length === 0) {
      return;
    }

    activeFrameLoadIdRef.current += 1;
    const frameLoadId = activeFrameLoadIdRef.current;
    loadedFrameRequestKeyRef.current = null;
    frameLoadStartedAtRef.current = performance.now();
    setViewerLifecycle((current) => {
      const restarted = startCadViewerLifecycle(current, modelFileIdentityKey);
      return restarted.generation === frameLoadId
        ? restarted
        : { ...restarted, generation: frameLoadId };
    });
    setFrameReadySequence(0);
    setFrameActive(true);
    setFrameKey((key) => key + 1);
  }, [modelFileIdentityKey]);

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
          consecutiveFrameTimeoutsRef.current += 1;
          if (
            request.type !== "load-file-urls" &&
            consecutiveFrameTimeoutsRef.current >= CAD_FRAME_PROTOCOL_TIMEOUT_RECOVERY_THRESHOLD
          ) {
            console.warn("CAD viewer protocol stalled; recycling iframe.", {
              requestType: request.type,
              consecutiveTimeouts: consecutiveFrameTimeoutsRef.current,
            });
            consecutiveFrameTimeoutsRef.current = 0;
            recycleCadViewerFrameAfterTimeout();
          }
          reject(
            new Error(
              `The CAD viewer did not answer within ${(timeoutMs / 1000).toFixed(1)} seconds while handling '${request.type}'.`,
            ),
          );
        }, timeoutMs);
        pendingFrameRequestsRef.current.set(requestId, {
          resolve,
          reject,
          timeoutId,
          requestType: request.type,
          generation: activeFrameLoadIdRef.current,
        });
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
    [recycleCadViewerFrameAfterTimeout],
  );

  const setFixedView = useCallback(
    (view: CadView, fit = true, options?: { readonly persist?: boolean }) => {
      if (loadStateRef.current !== "loaded") {
        return;
      }
      if (options?.persist !== false && cadRoutingThreadId && cadUiStateKey) {
        const command = makeManualCadViewCommand({
          threadId: cadRoutingThreadId,
          view,
          fit,
        });
        skipLocalManualCameraReplayCommandIdsRef.current.add(command.commandId);
        recordCadAgentViewCommand(cadUiStateKey, command);
      }
      void postFrameRequest({ type: "set-view", view, fit }, 3_000).catch(() => undefined);
    },
    [cadRoutingThreadId, cadUiStateKey, postFrameRequest, recordCadAgentViewCommand],
  );

  const zoomCadToFit = useCallback(() => {
    if (loadStateRef.current !== "loaded") {
      return;
    }
    void postFrameRequest({ type: "zoom-to-fit" }, 3_000).catch(() => undefined);
  }, [postFrameRequest]);

  const toggleCadExploded = useCallback(() => {
    const nextExploded = !cadExploded;
    if (cadUiStateKey) {
      setCadExploded(cadUiStateKey, nextExploded);
      return;
    }
    if (loadStateRef.current !== "loaded") {
      return;
    }
    void postFrameRequest({ type: "set-exploded", enabled: nextExploded }, 3_000).catch(
      () => undefined,
    );
  }, [cadExploded, cadUiStateKey, postFrameRequest, setCadExploded]);

  const openFullscreen = useCallback(() => {
    if (cadInteractionBlocked) {
      return;
    }
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
  }, [cadInteractionBlocked]);

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

  useEffect(() => {
    if (!cadInteractionBlocked || (!fullscreenMounted && !fullscreenEntering)) {
      return;
    }
    closeFullscreen();
  }, [cadInteractionBlocked, closeFullscreen, fullscreenEntering, fullscreenMounted]);

  const refreshComponents = useCallback(() => {
    if (loadStateRef.current !== "loaded") {
      setComponents([]);
      return;
    }
    void postFrameRequest({ type: "get-components" }, 3_000)
      .then((result) => {
        setComponents(
          applyCadComponentVisibility(result?.components ?? [], cadComponentVisibilityById),
        );
      })
      .catch(() => {
        setComponents([]);
      });
  }, [cadComponentVisibilityById, postFrameRequest]);

  const toggleComponent = useCallback(
    (
      component: CadViewerFrameComponentNode,
      visible: boolean,
      options?: { readonly persistKey?: string | null },
    ) => {
      const nextVisibilityByComponentId = {
        ...cadComponentVisibilityById,
        [component.id]: visible,
      };
      let previousComponents: ReadonlyArray<CadViewerFrameComponentNode> | null = null;
      setComponents((current) => {
        previousComponents = current;
        return applyCadComponentVisibility(current, { [component.id]: visible });
      });
      const persistKey = options?.persistKey === undefined ? cadUiStateKey : options.persistKey;
      if (persistKey) {
        setCadComponentVisibility(persistKey, component.id, visible);
      }
      void postFrameRequest(
        {
          type: "set-component-visibility",
          componentId: component.id,
          visible,
        },
        3_000,
      )
        .then((result) => {
          if (!result?.components) {
            return;
          }
          setComponents(
            applyCadComponentVisibility(result.components, nextVisibilityByComponentId),
          );
        })
        .catch(() => {
          if (previousComponents) {
            setComponents(previousComponents);
          }
        });
    },
    [cadComponentVisibilityById, cadUiStateKey, postFrameRequest, setCadComponentVisibility],
  );

  const applyCadViewCommand = useCallback(
    (command: CadViewCommand, options?: { readonly persistKey?: string | null }) => {
      if (command.type === "set-view") {
        setFixedView(command.view, command.fit, { persist: false });
        return;
      }
      if (loadStateRef.current !== "loaded") {
        return;
      }
      if (command.type === "set-camera") {
        const request = {
          type: "set-camera" as const,
          direction: command.direction,
          ...(command.up === undefined ? {} : { up: command.up }),
          ...(command.distance === undefined ? {} : { distance: command.distance }),
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
          options && "persistKey" in options ? { persistKey: options.persistKey } : undefined,
        );
        return;
      }
      if (command.type === "set-exploded") {
        const persistKey = options?.persistKey === undefined ? cadUiStateKey : options.persistKey;
        if (persistKey && cadRoutingThreadId) {
          setCadExploded(persistKey, command.exploded);
          return;
        }
        void postFrameRequest({ type: "set-exploded", enabled: command.exploded }, 3_000).catch(
          () => undefined,
        );
        return;
      }
      void postFrameRequest({ type: "zoom-to-fit" }, 3_000).catch(() => undefined);
    },
    [
      cadRoutingThreadId,
      cadUiStateKey,
      postFrameRequest,
      setCadExploded,
      setFixedView,
      toggleComponent,
    ],
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
        const pending = pendingFrameRequestsRef.current.get(event.data.requestId);
        if (pending?.requestType === "load-file-urls") {
          const phase =
            event.data.stage === "request-received" ||
            event.data.stage === "direct-3mf-imports-loaded"
              ? "fetching-assets"
              : "importing-model";
          setViewerLifecycle((current) =>
            advanceCadViewerLifecycle(current, pending.generation, {
              status: "loading",
              phase,
            }),
          );
        }
        return;
      }
      if (event.data.type === "camera-change") {
        const currentCadUiStateKey = cadUiStateKeyRef.current;
        const currentCadRoutingThreadId = cadRoutingThreadIdRef.current;
        if (currentCadUiStateKey && currentCadRoutingThreadId) {
          const command = makeManualCadCameraCommand({
            threadId: currentCadRoutingThreadId,
            camera: event.data.camera,
          });
          skipLocalManualCameraReplayCommandIdsRef.current.add(command.commandId);
          recordCadAgentViewCommand(currentCadUiStateKey, command);
        }
        return;
      }

      const pending = pendingFrameRequestsRef.current.get(event.data.requestId);
      if (!pending) {
        return;
      }
      pendingFrameRequestsRef.current.delete(event.data.requestId);
      clearTimeout(pending.timeoutId);
      consecutiveFrameTimeoutsRef.current = 0;

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
  }, [recordCadAgentViewCommand, rejectAllPendingFrameRequests]);

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
    if (loadState !== "loaded") {
      return;
    }
    const previousVisibilityByComponentId = appliedCadComponentVisibilityRef.current;
    const commands = cadComponentVisibilityCommandsForScopeChange(
      previousVisibilityByComponentId,
      cadComponentVisibilityById,
    );
    if (commands.length === 0) {
      return;
    }
    appliedCadComponentVisibilityRef.current = { ...cadComponentVisibilityById };
    for (const command of commands) {
      void postFrameRequest(
        {
          type: "set-component-visibility",
          componentId: command.componentId,
          visible: command.visible,
        },
        3_000,
      ).catch(() => undefined);
    }
    setComponents((current) => applyCadComponentVisibility(current, cadComponentVisibilityById));
  }, [cadComponentVisibilityById, loadState, modelFileIdentityKey, postFrameRequest]);

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
    setLocalCadFileError(null);
  }, [projectCadScopeKey]);

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
    if (!cadUiStateKey || agentExploded === undefined) {
      return;
    }
    setCadExploded(cadUiStateKey, agentExploded);
  }, [agentExploded, cadUiStateKey, modelFileIdentityKey, setCadExploded]);

  const handleCadViewCommand = useCallback(
    (command: CadViewCommand) => {
      if (!environmentId) {
        return;
      }
      if (handledCadAgentCommandIdsRef.current.has(command.commandId)) {
        return;
      }
      handledCadAgentCommandIdsRef.current.add(command.commandId);
      if (handledCadAgentCommandIdsRef.current.size > 256) {
        const oldestCommandId = handledCadAgentCommandIdsRef.current.values().next().value;
        if (oldestCommandId) {
          handledCadAgentCommandIdsRef.current.delete(oldestCommandId);
        }
      }
      activateRegularCadAgentControl(`cad-command:${command.commandId}`);
      const commandUiStateKey = scopedThreadKey(
        scopeThreadRef(environmentId, ThreadId.make(command.threadId)),
      );
      if (commandUiStateKey) {
        recordCadAgentViewCommand(commandUiStateKey, command);
      }
      applyCadViewCommand(command, { persistKey: commandUiStateKey });
    },
    [activateRegularCadAgentControl, applyCadViewCommand, environmentId, recordCadAgentViewCommand],
  );

  useEffect(() => {
    if (loadState !== "loaded" || !agentViewCommand) {
      return;
    }
    if (skipLocalManualCameraReplayCommandIdsRef.current.delete(agentViewCommand.commandId)) {
      return;
    }
    applyCadViewCommand(agentViewCommand);
  }, [agentViewCommand, applyCadViewCommand, loadState]);

  useEffect(() => {
    if (loadState !== "loaded" || agentViewCommand) {
      return;
    }
    setFixedView("isometric", true, { persist: false });
  }, [agentViewCommand, cadRoutingThreadId, loadState, modelFileIdentityKey, setFixedView]);

  const handleCadHierarchyRequest = useCallback(
    (req: CadHierarchyBrowserRequest, claim: CadBrokerClaim) => {
      if (!environmentApi) {
        return;
      }
      activateRegularCadAgentControl(`cad-hierarchy:${req.requestId}`);
      return (async () => {
        try {
          if (loadStateRef.current !== "loaded") {
            const unavailable = cadHierarchyViewerUnavailableMessage(
              loadStateRef.current,
              loadErrorRef.current,
            );
            await uploadCadHierarchyCompletion(environmentApi, {
              requestId: req.requestId,
              ...claim,
              components: [],
              status: unavailable.status,
              message: unavailable.message,
            });
            return;
          }
          const result = await postFrameRequest({ type: "get-components" }, 3_000);
          await uploadCadHierarchyCompletion(environmentApi, {
            requestId: req.requestId,
            ...claim,
            components: result?.components ?? [],
            status: "loaded",
          });
        } catch (error) {
          const message =
            error instanceof Error
              ? `CAD hierarchy request failed while reading the loaded viewer: ${error.message}`
              : "CAD hierarchy request failed while reading the loaded viewer.";
          await uploadCadHierarchyCompletion(environmentApi, {
            requestId: req.requestId,
            ...claim,
            components: [],
            status: "error",
            message,
          }).catch(() => undefined);
        }
      })();
    },
    [activateRegularCadAgentControl, environmentApi, postFrameRequest],
  );

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

  const handleCadScreenshotRequest = useCallback(
    (req: CadScreenshotBrowserRequest, claim: CadBrokerClaim) => {
      if (!environmentApi) {
        return;
      }
      activateRegularCadAgentControl(`cad-screenshot:${req.requestId}`);
      const finalizeFailure = (status: "failed" | "cancelled", message: string) =>
        uploadCadScreenshotCompletion(environmentApi, {
          requestId: req.requestId,
          ...claim,
          status,
          message,
        }).catch(() => undefined);
      const capture = async () => {
        try {
          const viewerReadyDeadline = Date.now() + CAD_AGENT_SCREENSHOT_VIEWER_READY_TIMEOUT_MS;
          while (loadStateRef.current !== "loaded" && Date.now() < viewerReadyDeadline) {
            if (loadStateRef.current === "error") {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }

          if (loadStateRef.current !== "loaded") {
            await finalizeFailure(
              "failed",
              loadErrorRef.current
                ? `CAD viewer failed before screenshot capture: ${loadErrorRef.current}`
                : "CAD viewer did not become ready before screenshot capture.",
            );
            return;
          }
          const result = await postFrameRequest(
            {
              type: "capture",
              ...(req.view ? { view: req.view } : {}),
              fit: req.fit,
            },
            CAD_AGENT_SCREENSHOT_CAPTURE_TIMEOUT_MS,
          );
          const pngBase64 = result?.pngBase64 ?? "";
          if (!pngBase64) {
            await finalizeFailure("failed", "CAD viewer returned an empty screenshot.");
            return;
          }
          await uploadCadScreenshotCompletion(environmentApi, {
            requestId: req.requestId,
            ...claim,
            status: "completed",
            pngBase64,
          });
        } catch (error) {
          await finalizeFailure(
            "failed",
            `CAD screenshot capture failed: ${errorFromUnknown(error).message}`,
          );
        }
      };
      const queuedCapture = screenshotCaptureQueueRef.current.catch(() => undefined).then(capture);
      screenshotCaptureQueueRef.current = queuedCapture.catch(() => undefined);
      return queuedCapture;
    },
    [activateRegularCadAgentControl, environmentApi, postFrameRequest],
  );

  useEffect(() => {
    if (
      !cadAgentRequestResponderEnabled ||
      !environmentId ||
      !environmentApi ||
      !cadRoutingThreadId
    ) {
      return;
    }
    return registerCadBrokerResponder(environmentId, environmentApi, {
      responderId: responderIdRef.current!,
      routingThreadId: cadRoutingThreadId,
      sameProjectThreadIds,
      activeReviewThreadIds: sameProjectActiveCadReviewThreadIds,
      reviewChildThreadIds: activeCadReviewChildThreadIds,
      controlsReviewChildren: cadReviewInProgress,
      allowProjectFallback: !agentControlHost && !cadReviewInProgress,
      visibility: agentControlHost ? "background" : "visible",
      onViewCommand: handleCadViewCommand,
      onHierarchyRequest: handleCadHierarchyRequest,
      onScreenshotRequest: handleCadScreenshotRequest,
    });
  }, [
    activeCadReviewChildThreadIds,
    agentControlHost,
    cadAgentRequestResponderEnabled,
    cadReviewInProgress,
    cadRoutingThreadId,
    environmentApi,
    environmentId,
    handleCadHierarchyRequest,
    handleCadScreenshotRequest,
    handleCadViewCommand,
    sameProjectActiveCadReviewThreadIds,
    sameProjectThreadIds,
  ]);

  useEffect(() => {
    const currentModelFiles = modelFilesRef.current;
    if (currentModelFiles.length === 0) {
      screenshotCaptureQueueRef.current = Promise.resolve();
      activeFrameLoadIdRef.current += 1;
      appliedCadComponentVisibilityRef.current = {};
      rejectAllPendingFrameRequests("CAD viewer model changed.");
      loadedFrameRequestKeyRef.current = null;
      frameLoadStartedAtRef.current = 0;
      consecutiveFrameTimeoutsRef.current = 0;
      setFrameActive(false);
      setFrameReadySequence(0);
      setViewerLifecycle((current) => idleCadViewerLifecycle(current));
      return;
    }

    const blocker = getCadModelViewerBlocker(currentModelFiles);
    if (blocker) {
      activeFrameLoadIdRef.current += 1;
      appliedCadComponentVisibilityRef.current = {};
      rejectAllPendingFrameRequests("CAD viewer model is too large.");
      loadedFrameRequestKeyRef.current = null;
      frameLoadStartedAtRef.current = 0;
      consecutiveFrameTimeoutsRef.current = 0;
      setFrameActive(false);
      setFrameReadySequence(0);
      setViewerLifecycle((current) => failCadViewerLifecycle(current, blocker));
      return;
    }

    activeFrameLoadIdRef.current += 1;
    const frameLoadId = activeFrameLoadIdRef.current;
    appliedCadComponentVisibilityRef.current = {};
    screenshotCaptureQueueRef.current = Promise.resolve();
    rejectAllPendingFrameRequests("CAD viewer model changed.");
    loadedFrameRequestKeyRef.current = null;
    frameLoadStartedAtRef.current = performance.now();
    consecutiveFrameTimeoutsRef.current = 0;
    frameReadyRecoveryAttemptsRef.current = 0;
    setViewerLifecycle((current) => {
      const started = startCadViewerLifecycle(current, modelFileIdentityKey);
      return started.generation === frameLoadId ? started : { ...started, generation: frameLoadId };
    });
    setFrameReadySequence(0);
    setFrameActive(true);
    setFrameKey((key) => key + 1);
  }, [modelFileIdentityKey, rejectAllPendingFrameRequests]);

  useEffect(() => {
    if (!frameActive || loadState !== "loading" || frameReadySequence !== 0) {
      return;
    }
    const frameLoadId = activeFrameLoadIdRef.current;
    const startedAt = frameLoadStartedAtRef.current || performance.now();
    const readyTimeoutId = setTimeout(() => {
      if (
        frameLoadId !== activeFrameLoadIdRef.current ||
        loadStateRef.current !== "loading" ||
        frameReadySequence !== 0
      ) {
        return;
      }
      if (frameReadyRecoveryAttemptsRef.current < 1) {
        frameReadyRecoveryAttemptsRef.current += 1;
        recycleCadViewerFrameAfterTimeout();
        return;
      }
      activeFrameLoadIdRef.current += 1;
      setFrameActive(false);
      setViewerLifecycle((current) =>
        advanceCadViewerLifecycle(current, frameLoadId, {
          status: "failed",
          message: "The CAD viewer frame did not become ready. Close and reopen the CAD panel.",
        }),
      );
    }, CAD_FRAME_READY_RECOVERY_TIMEOUT_MS);
    const loadTimeoutId = setTimeout(
      () => {
        if (frameLoadId !== activeFrameLoadIdRef.current || loadStateRef.current !== "loading") {
          return;
        }
        activeFrameLoadIdRef.current += 1;
        setFrameActive(false);
        setViewerLifecycle((current) =>
          advanceCadViewerLifecycle(current, frameLoadId, {
            status: "failed",
            message: `The synced CAD file did not finish importing within ${CAD_MODEL_LOAD_TIMEOUT_MS / 1000} seconds.`,
          }),
        );
      },
      Math.max(1, CAD_MODEL_LOAD_TIMEOUT_MS - (performance.now() - startedAt)),
    );
    return () => {
      clearTimeout(readyTimeoutId);
      clearTimeout(loadTimeoutId);
    };
  }, [frameActive, frameKey, frameReadySequence, loadState, recycleCadViewerFrameAfterTimeout]);

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
    setViewerLifecycle((current) =>
      advanceCadViewerLifecycle(current, frameLoadId, {
        status: "loading",
        phase: "fetching-assets",
      }),
    );

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
        setViewerLifecycle((current) =>
          advanceCadViewerLifecycle(current, frameLoadId, { status: "ready" }),
        );
      } catch (error) {
        if (frameLoadId !== activeFrameLoadIdRef.current) {
          return;
        }
        setFrameActive(false);
        setViewerLifecycle((current) =>
          advanceCadViewerLifecycle(current, frameLoadId, {
            status: "failed",
            message: buildCadWebGlFailureUserMessage(
              errorFromUnknown(error).message ||
                `The synced CAD file did not finish importing within ${CAD_MODEL_LOAD_TIMEOUT_MS / 1000} seconds. (Empty error received)`,
            ),
          }),
        );
      }
    })();
  }, [frameActive, frameReadySequence, modelFileIdentityKey, postFrameRequest]);

  if (!isOnshapeProject) {
    if (localCadFiles.length === 0) {
      return (
        <SidePanelShell mode={mode} {...cadShellProps}>
          <LocalCadOpenState error={localCadFileError} onSelectFiles={handleSelectLocalCadFiles} />
        </SidePanelShell>
      );
    }
  }

  if (isOnshapeProject && !cwd) {
    return (
      <SidePanelShell mode={mode} {...cadShellProps}>
        <CadPanelEmptyState
          title="CAD view unavailable"
          detail="This project does not have a workspace path."
        />
      </SidePanelShell>
    );
  }

  if (filesQuery.isLoading) {
    return (
      <SidePanelShell mode={mode} {...cadShellProps}>
        <CadPanelLoadingState />
      </SidePanelShell>
    );
  }

  if (modelFiles.length === 0) {
    return (
      <SidePanelShell mode={mode} {...cadShellProps}>
        <CadPanelEmptyState
          title="No synced CAD model"
          detail="Sync this Onshape project to download an OBJ preview or other supported model file."
        />
      </SidePanelShell>
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
        right: fullscreenButtonShowsExit ? 16 : 8,
        top: fullscreenButtonShowsExit ? 48 : 8,
      } as const);
  const fullscreenControlDisabled = !fullscreenButtonShowsExit && cadInteractionBlocked;
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
            disabled={fullscreenControlDisabled}
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
  const cadToolbarDisabled = loadState !== "loaded" || cadInteractionBlocked;
  const cadToolbar = (
    <div
      className={cn(
        "pointer-events-auto absolute inset-x-2 bottom-11 z-[80] flex justify-center transition-[filter,opacity] duration-180 ease-[var(--motion-ease-out)]",
        fullscreen && "inset-x-4 bottom-14",
        cadToolbarDisabled && "opacity-45 grayscale",
        loadState !== "loaded" && "hidden",
      )}
    >
      <div
        className="flex max-w-full min-w-0 items-center gap-0.5 overflow-hidden rounded-md border border-border/70 bg-background/86 p-0.5 shadow-lg shadow-black/10 backdrop-blur"
        aria-label="CAD viewer toolbar"
        aria-disabled={cadToolbarDisabled}
      >
        <div className="flex min-w-0 shrink items-center gap-0.5">
          {CAD_TOOLBAR_VIEWS.map((view) => (
            <CadViewerToolbarButton
              key={view}
              label={cadViewLabel(view)}
              tooltip={`${cadViewLabel(view)} CAD view`}
              disabled={cadToolbarDisabled}
              icon={<CadViewCubeIcon view={view} />}
              onClick={() => setFixedView(view, true)}
            />
          ))}
        </div>
        <div className="mx-0.5 h-5 w-px shrink-0 bg-border/70" />
        <CadViewerToolbarButton
          label="Fit"
          tooltip="Zoom CAD view to fit"
          disabled={cadToolbarDisabled}
          icon={<SearchIcon className="size-3.5" />}
          onClick={zoomCadToFit}
        />
        <CadViewerToolbarButton
          label="Explode"
          tooltip={cadExploded ? "Collapse CAD assembly" : "Explode CAD assembly"}
          disabled={cadToolbarDisabled}
          icon={<CircleIcon className="size-3.5" />}
          pressed={cadExploded}
          onClick={toggleCadExploded}
        />
      </div>
    </div>
  );

  return (
    <SidePanelShell mode={mode} {...cadShellProps}>
      <div
        ref={panelRef}
        data-cad-load-state={loadState}
        data-cad-load-phase={
          viewerLifecycle.status === "loading" ? viewerLifecycle.phase : viewerLifecycle.status
        }
        data-cad-load-generation={viewerLifecycle.generation}
        data-cad-load-changed-at={viewerLifecycle.changedAt}
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
          {cadInteractionBlocked ? (
            <div
              className="pointer-events-auto absolute inset-0 z-[75] cursor-not-allowed"
              aria-hidden="true"
              data-cad-interaction-blocker="true"
            />
          ) : null}
          {cadAgentControlActive && !agentControlHost ? (
            <div
              aria-hidden="true"
              className="cad-agent-control-overlay pointer-events-none absolute inset-0"
              data-ending={cadAgentControlExiting ? "true" : undefined}
              data-cad-agent-control-overlay="true"
            >
              <div className="cad-agent-control-glow" />
              <div className="cad-agent-control-frame" />
            </div>
          ) : null}
          {cadAgentControlActive ? (
            <div className="pointer-events-none absolute inset-x-0 top-4 z-[80] flex justify-center">
              <div
                className="cad-agent-control-pill rounded-full border border-emerald-300/80 bg-emerald-950/45 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-100 shadow-[0_0_20px_rgba(16,185,129,0.45)] backdrop-blur"
                data-ending={cadAgentControlExiting ? "true" : undefined}
              >
                Agent control
              </div>
            </div>
          ) : null}
          {loadState === "loading" && (
            <div className="absolute inset-0 z-10">
              <div
                className={cn(
                  "size-full transition-[opacity,transform] duration-220 ease-[var(--motion-ease-out)]",
                  showLoadingText ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0",
                )}
              >
                <CadPanelLoadingState />
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
          {cadToolbar}
          {cadInteractionBlocked ? null : (
            <div
              className={cn(
                "pointer-events-none absolute bottom-2 left-2 rounded-md border border-border/70 bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm",
                fullscreen && "left-4 bottom-4",
                loadState !== "loaded" && "hidden",
              )}
            >
              Drag to rotate, scroll to zoom
            </div>
          )}
        </div>
        {fullscreenBeaconAnchored ? null : fullscreenControl}
        {fullscreenControlPortal}
        {fullscreenMist}
      </div>
    </SidePanelShell>
  );
}
