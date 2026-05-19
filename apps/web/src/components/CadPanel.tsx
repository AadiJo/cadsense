import type { CadView } from "@cadsense/contracts";
import { BoxIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { useComposerDraftStore, DraftId } from "../composerDraftStore";
import { readEnvironmentApi } from "../environmentApi";
import { cadViewIsCloseUp, cadViewVector } from "../lib/cadView";
import {
  cadViewerOrientationTweenMs,
  cadViewerViewCommandSettleMs,
} from "../lib/cadViewerCameraTransition";
import { cadEmbeddedViewerEdgeSettings } from "../lib/cadEmbeddedViewerTuning";
import { createCadViewerResizeCoordinator } from "../lib/cadViewerResizeThrottle";
import { buildCadWebGlFailureUserMessage, getWebGl1UnavailableReason } from "../lib/cadViewerWebGl";
import { selectProjectByRef, useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { resolveThreadRouteRef } from "../threadRoutes";
import { cn } from "../lib/utils";
import { DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";

type Online3DViewerModule = typeof import("online-3d-viewer");
type EmbeddedViewerInstance = InstanceType<Online3DViewerModule["EmbeddedViewer"]>;

interface CadPanelProps {
  mode?: DiffPanelMode;
}

function applyCadView(
  module: Online3DViewerModule,
  embeddedViewer: EmbeddedViewerInstance,
  view: CadView,
  fit: boolean,
  cancelPendingFollowUp: () => void,
  afterOrientationTween: (delayMs: number, fn: () => void) => void,
) {
  cancelPendingFollowUp();
  const viewer = embeddedViewer.GetViewer() as ReturnType<EmbeddedViewerInstance["GetViewer"]> & {
    navigation: {
      MoveCamera: (camera: InstanceType<Online3DViewerModule["Camera"]>, stepCount: number) => void;
    };
    settings?: { animationSteps?: number };
  };
  const sphere = viewer.GetBoundingSphere(() => true);
  if (!sphere) {
    return;
  }
  const { direction, up } = cadViewVector(view);
  const directionLength = Math.hypot(direction[0], direction[1], direction[2]) || 1;
  const normalizedDirection = direction.map((value) => value / directionLength) as [
    number,
    number,
    number,
  ];
  let distance = Math.max(sphere.radius * 2.8, 10);
  if (fit) {
    let fieldOfView = 45 / 2.0;
    const canvas = (viewer as any).GetCanvas ? (viewer as any).GetCanvas() : null;
    if (canvas && canvas.width < canvas.height) {
      fieldOfView = (fieldOfView * canvas.width) / canvas.height;
    }
    const DegRad = Math.PI / 180.0;
    const fitDistance = sphere.radius / Math.sin(fieldOfView * DegRad);
    if (fitDistance > 0 && fitDistance !== Infinity) {
      distance = fitDistance;
    }
  }
  if (cadViewIsCloseUp(view)) {
    distance *= 0.44;
  }
  const center = sphere.center;
  const camera = new module.Camera(
    new module.Coord3D(
      center.x + normalizedDirection[0] * distance,
      center.y + normalizedDirection[1] * distance,
      center.z + normalizedDirection[2] * distance,
    ),
    new module.Coord3D(center.x, center.y, center.z),
    new module.Coord3D(up[0], up[1], up[2]),
    45,
  );

  const steps = viewer.settings?.animationSteps ?? 40;
  viewer.navigation.MoveCamera(camera, steps);
  if (typeof (viewer as any).Render === "function") {
    (viewer as any).Render();
  } else if (typeof (viewer as any).Draw === "function") {
    (viewer as any).Draw();
  }
  const delayMs = cadViewerOrientationTweenMs(steps);
  afterOrientationTween(delayMs, () => {
    viewer.AdjustClippingPlanesToSphere(sphere);
    if (typeof (viewer as any).Render === "function") {
      (viewer as any).Render();
    } else if (typeof (viewer as any).Draw === "function") {
      (viewer as any).Draw();
    }
  });
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
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<EmbeddedViewerInstance | null>(null);
  const moduleRef = useRef<Online3DViewerModule | null>(null);
  const cadViewFollowUpRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [loadError, setLoadError] = useState<string | null>(null);
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
    queryKey: ["onshape-cad-files", environmentId, cwd, onshapeContext?.lastSyncedRelativePath],
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

  const modelFileUrlsKey = useMemo(
    () => modelFiles.map((file) => file.url).join("\0"),
    [modelFiles],
  );

  const cancelCadViewFollowUp = useCallback(() => {
    if (cadViewFollowUpRef.current !== null) {
      clearTimeout(cadViewFollowUpRef.current);
      cadViewFollowUpRef.current = null;
    }
  }, []);

  const scheduleCadViewAfterOrientation = useCallback((delayMs: number, fn: () => void) => {
    cadViewFollowUpRef.current = setTimeout(() => {
      cadViewFollowUpRef.current = null;
      fn();
    }, delayMs);
  }, []);

  const setFixedView = useCallback(
    (view: CadView, fit = true) => {
      const module = moduleRef.current;
      const embeddedViewer = viewerRef.current;
      if (!module || !embeddedViewer) {
        return;
      }
      applyCadView(
        module,
        embeddedViewer,
        view,
        fit,
        cancelCadViewFollowUp,
        scheduleCadViewAfterOrientation,
      );
    },
    [cancelCadViewFollowUp, scheduleCadViewAfterOrientation],
  );

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
    if (!environmentApi || !cadRoutingThreadId) {
      return;
    }
    return environmentApi.onshape.onCadScreenshotRequest((req) => {
      if (cadRoutingThreadId && req.threadId !== cadRoutingThreadId) {
        return;
      }
      void (async () => {
        try {
          // Wait up to 10 seconds for the viewer to finish loading
          let attempts = 0;
          while (loadStateRef.current !== "loaded" && attempts < 100) {
            if (loadStateRef.current === "error") {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
            attempts++;
          }

          if (loadStateRef.current !== "loaded" || !viewerRef.current || !moduleRef.current) {
            await environmentApi.onshape.uploadCadScreenshot({
              requestId: req.requestId,
              pngBase64: "",
            });
            return;
          }
          const module = moduleRef.current;
          const embeddedViewer = viewerRef.current;
          if (req.view) {
            applyCadView(
              module,
              embeddedViewer,
              req.view,
              req.fit,
              cancelCadViewFollowUp,
              scheduleCadViewAfterOrientation,
            );
            const viewerForTiming = embeddedViewer.GetViewer() as {
              settings?: { animationSteps?: number };
            };
            const settleMs = cadViewerViewCommandSettleMs(
              viewerForTiming.settings?.animationSteps ?? 40,
              req.fit,
            );
            await new Promise<void>((resolve) => {
              setTimeout(resolve, settleMs);
            });
          }
          const viewer = embeddedViewer.GetViewer();
          const size = viewer.GetCanvasSize();
          const w = Math.max(1, Math.round(size.width));
          const h = Math.max(1, Math.round(size.height));
          const capture = viewer as unknown as {
            GetImageAsDataUrl(width: number, height: number, isTransparent: boolean): string;
          };
          const dataUrl = capture.GetImageAsDataUrl(w, h, true);
          const comma = dataUrl.indexOf(",");
          const pngBase64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
          await environmentApi.onshape.uploadCadScreenshot({ requestId: req.requestId, pngBase64 });
        } catch {
          await environmentApi.onshape
            .uploadCadScreenshot({ requestId: req.requestId, pngBase64: "" })
            .catch(() => undefined);
        }
      })();
    });
  }, [cadRoutingThreadId, environmentApi, cancelCadViewFollowUp, scheduleCadViewAfterOrientation]);

  useEffect(() => {
    const container = containerRef.current;
    const modelUrls = modelFileUrlsKey.length > 0 ? modelFileUrlsKey.split("\0") : [];
    if (!container || modelUrls.length === 0) {
      return;
    }

    const webGlReason = getWebGl1UnavailableReason();
    if (webGlReason) {
      setLoadState("error");
      setLoadError(webGlReason);
      return;
    }

    let cancelled = false;
    setLoadState("loading");
    setLoadError(null);
    container.replaceChildren();

    void import("online-3d-viewer")
      .then((module) => {
        if (cancelled) {
          return;
        }
        moduleRef.current = module;
        const embeddedViewer = new module.EmbeddedViewer(container, {
          backgroundColor: new module.RGBAColor(0, 0, 0, 0),
          // Darker neutral than stock gray when the mesh has no material / `usemtl` assignment.
          defaultColor: new module.RGBColor(56, 60, 67),
          defaultLineColor: new module.RGBColor(40, 43, 49),
          edgeSettings: cadEmbeddedViewerEdgeSettings(module),
          onModelLoaded: () => {
            if (cancelled) {
              return;
            }
            const localViewer = viewerRef.current?.GetViewer() as any;
            if (
              localViewer?.navigation?.callbacks?.onUpdate &&
              !localViewer.navigation._cadSenseThrottled
            ) {
              localViewer.navigation._cadSenseThrottled = true;
              const origUpdate = localViewer.navigation.callbacks.onUpdate;
              let updatePending = false;
              localViewer.navigation.callbacks.onUpdate = () => {
                if (!updatePending) {
                  updatePending = true;
                  requestAnimationFrame(() => {
                    updatePending = false;
                    origUpdate.apply(localViewer.navigation.callbacks);
                  });
                }
              };
            }
            setLoadState("loaded");
            setFixedView("isometric", true);
          },
          onModelLoadFailed: () => {
            if (cancelled) {
              return;
            }
            setLoadState("error");
            setLoadError("The synced CAD file could not be imported by the viewer.");
          },
        });
        viewerRef.current = embeddedViewer;
        embeddedViewer.LoadModelFromUrlList(modelUrls);
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setLoadState("error");
        setLoadError(
          buildCadWebGlFailureUserMessage(
            error instanceof Error ? error.message : "Failed to load CAD viewer.",
          ),
        );
      });

    const resizeCoordinator = createCadViewerResizeCoordinator(() => {
      viewerRef.current?.Resize();
    });
    const resizeObserver = new ResizeObserver(() => {
      resizeCoordinator.schedule();
    });
    resizeObserver.observe(container);

    return () => {
      cancelled = true;
      cancelCadViewFollowUp();
      resizeCoordinator.cancel();
      resizeObserver.disconnect();
      viewerRef.current?.Destroy();
      viewerRef.current = null;
      moduleRef.current = null;
      container.replaceChildren();
    };
  }, [modelFileUrlsKey, setFixedView, cancelCadViewFollowUp]);

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
        <div
          ref={containerRef}
          className="absolute inset-0 overflow-hidden [&>div:nth-child(2)]:hidden"
        />
        {cadReviewInProgress ? (
          <div className="pointer-events-none absolute inset-x-0 top-4 z-20 flex justify-center">
            <div className="cad-agent-control-pill rounded-full border border-emerald-300/80 bg-emerald-950/45 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-100 shadow-[0_0_20px_rgba(16,185,129,0.45)] backdrop-blur">
              Agent control
            </div>
          </div>
        ) : null}
        {loadState === "loading" && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/70 text-sm text-muted-foreground">
            Loading CAD model...
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
