export type CadViewerLoadingPhase = "booting-frame" | "fetching-assets" | "importing-model";

export type CadViewerLifecycle =
  | {
      readonly status: "idle";
      readonly generation: number;
      readonly assetKey: null;
      readonly changedAt: number;
    }
  | {
      readonly status: "loading";
      readonly phase: CadViewerLoadingPhase;
      readonly generation: number;
      readonly assetKey: string;
      readonly startedAt: number;
      readonly changedAt: number;
    }
  | {
      readonly status: "ready";
      readonly generation: number;
      readonly assetKey: string;
      readonly startedAt: number;
      readonly changedAt: number;
    }
  | {
      readonly status: "failed";
      readonly generation: number;
      readonly assetKey: string | null;
      readonly startedAt: number | null;
      readonly changedAt: number;
      readonly message: string;
    };

export function initialCadViewerLifecycle(now = Date.now()): CadViewerLifecycle {
  return { status: "idle", generation: 0, assetKey: null, changedAt: now };
}

export function startCadViewerLifecycle(
  previous: CadViewerLifecycle,
  assetKey: string,
  now = Date.now(),
): CadViewerLifecycle {
  return {
    status: "loading",
    phase: "booting-frame",
    generation: previous.generation + 1,
    assetKey,
    startedAt: now,
    changedAt: now,
  };
}

export function idleCadViewerLifecycle(
  previous: CadViewerLifecycle,
  now = Date.now(),
): CadViewerLifecycle {
  return {
    status: "idle",
    generation: previous.generation + 1,
    assetKey: null,
    changedAt: now,
  };
}

export function failCadViewerLifecycle(
  previous: CadViewerLifecycle,
  message: string,
  now = Date.now(),
): CadViewerLifecycle {
  return {
    status: "failed",
    generation: previous.generation + 1,
    assetKey: previous.assetKey,
    startedAt: previous.status === "idle" ? null : previous.startedAt,
    changedAt: now,
    message,
  };
}

export function advanceCadViewerLifecycle(
  current: CadViewerLifecycle,
  generation: number,
  transition:
    | { readonly status: "loading"; readonly phase: CadViewerLoadingPhase }
    | { readonly status: "ready" }
    | { readonly status: "failed"; readonly message: string },
  now = Date.now(),
): CadViewerLifecycle {
  if (current.generation !== generation || current.status === "idle") {
    return current;
  }
  if (transition.status === "loading") {
    if (current.status !== "loading") {
      return current;
    }
    return { ...current, phase: transition.phase, changedAt: now };
  }
  if (transition.status === "ready") {
    if (current.status !== "loading") {
      return current;
    }
    return {
      status: "ready",
      generation,
      assetKey: current.assetKey,
      startedAt: current.startedAt,
      changedAt: now,
    };
  }
  return {
    status: "failed",
    generation,
    assetKey: current.assetKey,
    startedAt: current.startedAt,
    changedAt: now,
    message: transition.message,
  };
}

/** Thread/view-state rebinding must never restart or invalidate an asset import. */
export function rebindCadViewerLifecycleToThread(
  current: CadViewerLifecycle,
  _threadId: string | undefined,
): CadViewerLifecycle {
  return current;
}

export function cadViewerLegacyLoadState(
  lifecycle: CadViewerLifecycle,
): "idle" | "loading" | "loaded" | "error" {
  if (lifecycle.status === "ready") {
    return "loaded";
  }
  if (lifecycle.status === "failed") {
    return "error";
  }
  return lifecycle.status;
}
