import type {
  CadHierarchyBrowserRequest,
  CadHierarchyUploadInput,
  CadScreenshotBrowserRequest,
  CadScreenshotUploadInput,
  CadViewCommand,
  EnvironmentApi,
  EnvironmentId,
} from "@cadsense/contracts";

export type CadBrokerRequestKind = "view-command" | "hierarchy" | "screenshot";

export interface CadBrokerRoute {
  readonly routingThreadId: string;
  readonly sameProjectThreadIds: ReadonlyArray<string>;
  readonly activeReviewThreadIds: ReadonlyArray<string>;
  readonly reviewChildThreadIds: ReadonlyArray<string>;
  readonly controlsReviewChildren: boolean;
  readonly allowProjectFallback: boolean;
}

export interface CadBrokerResponder extends CadBrokerRoute {
  /** Stable for the lifetime of the browser viewer, including React re-renders. */
  readonly responderId: string;
  readonly visibility: "visible" | "background";
  readonly onViewCommand: (command: CadViewCommand) => void | Promise<void>;
  readonly onHierarchyRequest: (
    request: CadHierarchyBrowserRequest,
    claim: CadBrokerClaim,
  ) => void | Promise<void>;
  readonly onScreenshotRequest: (
    request: CadScreenshotBrowserRequest,
    claim: CadBrokerClaim,
  ) => void | Promise<void>;
}

export interface CadBrokerClaim {
  readonly responderId: string;
  readonly leaseId: string;
}

export interface CadBrokerActivator extends CadBrokerRoute {
  readonly activatorId: string;
  readonly activate: (requestThreadId: string, kind: CadBrokerRequestKind) => void | Promise<void>;
}

export interface RegisteredResponder {
  readonly order: number;
  readonly responder: CadBrokerResponder;
}

interface RegisteredActivator {
  readonly order: number;
  readonly activator: CadBrokerActivator;
}

interface InFlightCadRequest {
  readonly responderId: string;
  readonly claim: { responderId: string; leaseId: string };
  readonly request: CadHierarchyBrowserRequest | CadScreenshotBrowserRequest;
  readonly kind: "hierarchy" | "screenshot";
  leaseExpiresAt: string;
  stopHeartbeat: () => void;
  readonly released: Promise<void>;
  readonly release: () => void;
}

interface EnvironmentBroker {
  api: EnvironmentApi;
  readonly responders: Map<string, RegisteredResponder>;
  readonly activators: Map<string, RegisteredActivator>;
  unsubscribe: (() => void) | null;
  queue: Promise<void>;
  changeSequence: number;
  readonly changeWaiters: Set<() => void>;
  readonly inFlightRequests: Map<string, InFlightCadRequest>;
  readonly retryTimers: Map<string, ReturnType<typeof setTimeout>>;
}

const CAD_CLAIM_HEARTBEAT_MS = 10_000;
const CAD_REQUEST_DEADLINE_MS = 120_000;
const environmentBrokers = new Map<EnvironmentId, EnvironmentBroker>();
let registrationSequence = 0;
let backgroundDispatchQueue: Promise<void> = Promise.resolve();

function routeRank(
  route: CadBrokerRoute,
  requestThreadId: string,
  protectedThreadIds: ReadonlySet<string>,
): number | null {
  if (route.routingThreadId === requestThreadId) {
    return 0;
  }
  if (route.controlsReviewChildren && route.reviewChildThreadIds.includes(requestThreadId)) {
    return 1;
  }
  if (protectedThreadIds.has(requestThreadId) || !route.allowProjectFallback) {
    return null;
  }
  return route.sameProjectThreadIds.includes(requestThreadId) ? 2 : null;
}

function protectedThreadIdsForBroker(broker: EnvironmentBroker): Set<string> {
  const protectedIds = new Set<string>();
  for (const { responder } of broker.responders.values()) {
    for (const threadId of responder.activeReviewThreadIds) {
      protectedIds.add(threadId);
    }
    for (const threadId of responder.reviewChildThreadIds) {
      protectedIds.add(threadId);
    }
  }
  for (const { activator } of broker.activators.values()) {
    for (const threadId of activator.activeReviewThreadIds) {
      protectedIds.add(threadId);
    }
    for (const threadId of activator.reviewChildThreadIds) {
      protectedIds.add(threadId);
    }
  }
  return protectedIds;
}

export function selectCadBrokerResponder(
  responders: ReadonlyArray<RegisteredResponder>,
  requestThreadId: string,
  protectedThreadIds: ReadonlySet<string>,
): CadBrokerResponder | null {
  return (
    responders
      .map((entry) => ({
        order: entry.order,
        responder: entry.responder,
        rank: routeRank(entry.responder, requestThreadId, protectedThreadIds),
      }))
      .filter((entry): entry is typeof entry & { readonly rank: number } => entry.rank !== null)
      .toSorted(
        (left, right) =>
          left.rank - right.rank ||
          (left.responder.visibility === right.responder.visibility
            ? 0
            : left.responder.visibility === "visible"
              ? -1
              : 1) ||
          left.order - right.order ||
          left.responder.responderId.localeCompare(right.responder.responderId),
      )[0]?.responder ?? null
  );
}

function selectActivator(
  broker: EnvironmentBroker,
  requestThreadId: string,
): CadBrokerActivator | null {
  const protectedIds = protectedThreadIdsForBroker(broker);
  return (
    [...broker.activators.values()]
      .map((entry) => ({
        order: entry.order,
        activator: entry.activator,
        rank: routeRank(entry.activator, requestThreadId, protectedIds),
      }))
      .filter((entry): entry is typeof entry & { readonly rank: number } => entry.rank !== null)
      .toSorted(
        (left, right) =>
          left.rank - right.rank ||
          left.order - right.order ||
          left.activator.activatorId.localeCompare(right.activator.activatorId),
      )[0]?.activator ?? null
  );
}

function selectResponder(broker: EnvironmentBroker, requestThreadId: string) {
  return selectCadBrokerResponder(
    [...broker.responders.values()],
    requestThreadId,
    protectedThreadIdsForBroker(broker),
  );
}

function notifyBrokerChanged(broker: EnvironmentBroker) {
  broker.changeSequence += 1;
  for (const waiter of broker.changeWaiters) {
    waiter();
  }
  broker.changeWaiters.clear();
}

async function waitForResponder(
  broker: EnvironmentBroker,
  requestThreadId: string,
  timeoutMs = 10_000,
): Promise<CadBrokerResponder | null> {
  const deadline = Date.now() + timeoutMs;
  let observedSequence = broker.changeSequence;
  for (;;) {
    const responder = selectResponder(broker, requestThreadId);
    if (responder) {
      return responder;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return null;
    }
    await new Promise<void>((resolve) => {
      const timeoutId = setTimeout(() => {
        broker.changeWaiters.delete(onChange);
        resolve();
      }, remainingMs);
      const onChange = () => {
        clearTimeout(timeoutId);
        resolve();
      };
      broker.changeWaiters.add(onChange);
      if (broker.changeSequence !== observedSequence) {
        broker.changeWaiters.delete(onChange);
        clearTimeout(timeoutId);
        resolve();
      }
    });
    observedSequence = broker.changeSequence;
  }
}

async function claimRequest(
  broker: EnvironmentBroker,
  responder: CadBrokerResponder,
  requestId: string,
  kind: "hierarchy" | "screenshot",
): Promise<
  | {
      readonly status: "claimed";
      readonly claim: CadBrokerClaim;
      readonly leaseExpiresAt: string;
    }
  | { readonly status: "unavailable"; readonly reason: string; readonly retryAt?: string }
> {
  const claim =
    kind === "screenshot"
      ? broker.api.onshape.claimCadScreenshotRequest
      : broker.api.onshape.claimCadHierarchyRequest;
  const result = await claim({
    requestId,
    responderId: responder.responderId,
  });
  return result.status === "claimed"
    ? {
        status: "claimed",
        claim: { responderId: responder.responderId, leaseId: result.leaseId },
        leaseExpiresAt: result.leaseExpiresAt,
      }
    : result;
}

function inFlightRequestKey(kind: "hierarchy" | "screenshot", requestId: string): string {
  return `${kind}:${requestId}`;
}

function requestDeadline(request: CadHierarchyBrowserRequest | CadScreenshotBrowserRequest) {
  return Date.parse(request.createdAt) + CAD_REQUEST_DEADLINE_MS;
}

function scheduleRequestRetry(
  broker: EnvironmentBroker,
  request: CadHierarchyBrowserRequest | CadScreenshotBrowserRequest,
  kind: "hierarchy" | "screenshot",
  retryAt: string,
) {
  const retryAtMs = Date.parse(retryAt);
  if (!Number.isFinite(retryAtMs) || retryAtMs >= requestDeadline(request)) {
    return;
  }
  const requestKey = inFlightRequestKey(kind, request.requestId);
  const existingTimer = broker.retryTimers.get(requestKey);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }
  const timeoutId = setTimeout(
    () => {
      broker.retryTimers.delete(requestKey);
      enqueueDispatch(broker, request, kind, true);
    },
    Math.max(0, retryAtMs - Date.now()),
  );
  broker.retryTimers.set(requestKey, timeoutId);
}

function startClaimHeartbeat(
  broker: EnvironmentBroker,
  responder: CadBrokerResponder,
  request: CadHierarchyBrowserRequest | CadScreenshotBrowserRequest,
  kind: "hierarchy" | "screenshot",
  entry: InFlightCadRequest,
): () => void {
  let stopped = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    stopped = true;
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };
  const schedule = () => {
    if (!stopped) {
      timeoutId = setTimeout(() => void renew(), CAD_CLAIM_HEARTBEAT_MS);
    }
  };
  const renew = async () => {
    if (stopped) {
      return;
    }
    try {
      const result = await claimRequest(broker, responder, request.requestId, kind);
      if (stopped) {
        return;
      }
      if (result.status === "unavailable") {
        stop();
        const requestKey = inFlightRequestKey(kind, request.requestId);
        if (broker.inFlightRequests.get(requestKey) === entry) {
          broker.inFlightRequests.delete(requestKey);
          entry.release();
        }
        if (result.reason === "already-claimed" && result.retryAt) {
          scheduleRequestRetry(broker, request, kind, result.retryAt);
        }
        return;
      }
      // A suspended browser may miss the old lease window and reclaim the still-pending
      // request under a new lease. Handlers retain this object and read it at upload time.
      entry.claim.leaseId = result.claim.leaseId;
      entry.leaseExpiresAt = result.leaseExpiresAt;
      schedule();
    } catch (error) {
      console.warn("CAD request claim heartbeat failed", { kind, error });
      schedule();
    }
  };
  schedule();
  return stop;
}

async function dispatchToResponder(
  broker: EnvironmentBroker,
  request: CadViewCommand | CadHierarchyBrowserRequest | CadScreenshotBrowserRequest,
  kind: CadBrokerRequestKind,
  retryAllowed: boolean,
  awaitHandler: boolean,
) {
  let responder = selectResponder(broker, request.threadId);
  if (!responder) {
    const activator = selectActivator(broker, request.threadId);
    if (activator) {
      await activator.activate(request.threadId, kind);
      responder = await waitForResponder(broker, request.threadId);
    }
  }
  if (!responder) {
    return;
  }
  if (kind === "view-command") {
    const handled = Promise.resolve(responder.onViewCommand(request as CadViewCommand)).catch(
      (error) => {
        console.error("CAD view command handler failed", error);
      },
    );
    if (awaitHandler) {
      await handled;
    }
    return;
  }
  const requestWithId = request as CadHierarchyBrowserRequest | CadScreenshotBrowserRequest;
  const claimKind = kind as "hierarchy" | "screenshot";
  const requestKey = inFlightRequestKey(claimKind, requestWithId.requestId);
  if (broker.inFlightRequests.has(requestKey)) {
    return;
  }
  const claimResult = await claimRequest(broker, responder, requestWithId.requestId, claimKind);
  if (claimResult.status === "unavailable") {
    if (retryAllowed && claimResult.reason === "already-claimed" && claimResult.retryAt) {
      scheduleRequestRetry(broker, requestWithId, claimKind, claimResult.retryAt);
    }
    return;
  }
  const claim = { ...claimResult.claim };
  const retryTimer = broker.retryTimers.get(requestKey);
  if (retryTimer) {
    clearTimeout(retryTimer);
    broker.retryTimers.delete(requestKey);
  }
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inFlight: InFlightCadRequest = {
    responderId: responder.responderId,
    claim,
    request: requestWithId,
    kind: claimKind,
    leaseExpiresAt: claimResult.leaseExpiresAt,
    stopHeartbeat: () => undefined,
    released,
    release,
  };
  broker.inFlightRequests.set(requestKey, inFlight);
  inFlight.stopHeartbeat = startClaimHeartbeat(
    broker,
    responder,
    requestWithId,
    claimKind,
    inFlight,
  );
  let handlerFailed = false;
  let handled: Promise<void>;
  if (kind === "hierarchy") {
    handled = Promise.resolve()
      .then(() => responder.onHierarchyRequest(request as CadHierarchyBrowserRequest, claim))
      .catch((error) => {
        handlerFailed = true;
        console.error("CAD hierarchy request handler failed", error);
      });
  } else {
    handled = Promise.resolve()
      .then(() => responder.onScreenshotRequest(request as CadScreenshotBrowserRequest, claim))
      .catch((error) => {
        handlerFailed = true;
        console.error("CAD screenshot request handler failed", error);
      });
  }
  handled = handled.finally(() => {
    inFlight.stopHeartbeat();
    if (broker.inFlightRequests.get(requestKey) === inFlight) {
      broker.inFlightRequests.delete(requestKey);
      if (handlerFailed) {
        // The server still owns this request until the current lease expires. Stop renewing it
        // and retry at that boundary; repeated unavailable responses keep following retryAt up
        // to the request deadline.
        scheduleRequestRetry(broker, requestWithId, claimKind, inFlight.leaseExpiresAt);
      }
    }
  });
  if (awaitHandler) {
    await Promise.race([handled, inFlight.released]);
  }
}

function enqueueDispatch(
  broker: EnvironmentBroker,
  request: CadViewCommand | CadHierarchyBrowserRequest | CadScreenshotBrowserRequest,
  kind: CadBrokerRequestKind,
  retryAllowed = true,
) {
  const currentResponder = selectResponder(broker, request.threadId);
  const currentActivator = currentResponder ? null : selectActivator(broker, request.threadId);
  const serializeBackground =
    currentResponder?.visibility === "background" ||
    currentActivator?.controlsReviewChildren === true;
  const previous = serializeBackground ? backgroundDispatchQueue : broker.queue;
  const dispatched = previous
    .catch(() => undefined)
    .then(() =>
      dispatchToResponder(broker, request, kind, retryAllowed, serializeBackground).catch(
        (error) => {
          console.error("CAD request broker dispatch failed", { kind, error });
        },
      ),
    );
  if (serializeBackground) {
    backgroundDispatchQueue = dispatched;
  } else {
    broker.queue = dispatched;
  }
}

function ensureSubscriptions(broker: EnvironmentBroker) {
  if (broker.unsubscribe) {
    return;
  }
  const unsubscribers = [
    broker.api.onshape.onCadViewCommand((command) =>
      enqueueDispatch(broker, command, "view-command"),
    ),
    broker.api.onshape.onCadHierarchyRequest((request) =>
      enqueueDispatch(broker, request, "hierarchy"),
    ),
    broker.api.onshape.onCadScreenshotRequest((request) =>
      enqueueDispatch(broker, request, "screenshot"),
    ),
  ];
  broker.unsubscribe = () => {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
  };
}

function ensureBroker(environmentId: EnvironmentId, api: EnvironmentApi): EnvironmentBroker {
  let broker = environmentBrokers.get(environmentId);
  if (!broker) {
    broker = {
      api,
      responders: new Map(),
      activators: new Map(),
      unsubscribe: null,
      queue: Promise.resolve(),
      changeSequence: 0,
      changeWaiters: new Set(),
      inFlightRequests: new Map(),
      retryTimers: new Map(),
    };
    environmentBrokers.set(environmentId, broker);
  } else {
    broker.api = api;
  }
  return broker;
}

function removeBrokerIfUnused(environmentId: EnvironmentId, broker: EnvironmentBroker) {
  if (broker.responders.size > 0 || broker.activators.size > 0) {
    return;
  }
  broker.unsubscribe?.();
  broker.unsubscribe = null;
  environmentBrokers.delete(environmentId);
}

function releaseResponderClaims(broker: EnvironmentBroker, responderId: string) {
  for (const [requestKey, inFlight] of broker.inFlightRequests) {
    if (inFlight.responderId !== responderId) {
      continue;
    }
    inFlight.stopHeartbeat();
    inFlight.release();
    broker.inFlightRequests.delete(requestKey);
    scheduleRequestRetry(broker, inFlight.request, inFlight.kind, inFlight.leaseExpiresAt);
  }
}

export function registerCadBrokerResponder(
  environmentId: EnvironmentId,
  api: EnvironmentApi,
  responder: CadBrokerResponder,
): () => void {
  const broker = ensureBroker(environmentId, api);
  broker.responders.set(responder.responderId, {
    order: ++registrationSequence,
    responder,
  });
  notifyBrokerChanged(broker);
  // Register the route before subscribing because a transport may synchronously replay pending
  // requests while the subscription is being established.
  ensureSubscriptions(broker);
  return () => {
    if (broker.responders.get(responder.responderId)?.responder !== responder) {
      return;
    }
    broker.responders.delete(responder.responderId);
    notifyBrokerChanged(broker);
    removeBrokerIfUnused(environmentId, broker);
    queueMicrotask(() => {
      if (!broker.responders.has(responder.responderId)) {
        releaseResponderClaims(broker, responder.responderId);
      }
    });
  };
}

export function registerCadBrokerActivator(
  environmentId: EnvironmentId,
  api: EnvironmentApi,
  activator: CadBrokerActivator,
): () => void {
  const broker = ensureBroker(environmentId, api);
  broker.activators.set(activator.activatorId, {
    order: ++registrationSequence,
    activator,
  });
  notifyBrokerChanged(broker);
  ensureSubscriptions(broker);
  return () => {
    if (broker.activators.get(activator.activatorId)?.activator !== activator) {
      return;
    }
    broker.activators.delete(activator.activatorId);
    notifyBrokerChanged(broker);
    removeBrokerIfUnused(environmentId, broker);
  };
}

export async function uploadCadScreenshotCompletion(
  api: EnvironmentApi,
  input: CadScreenshotUploadInput,
): Promise<void> {
  await api.onshape.uploadCadScreenshot(input);
}

export async function uploadCadHierarchyCompletion(
  api: EnvironmentApi,
  input: CadHierarchyUploadInput,
): Promise<void> {
  await api.onshape.uploadCadHierarchy(input);
}

export function __resetCadRequestBrokersForTests() {
  for (const broker of environmentBrokers.values()) {
    broker.unsubscribe?.();
    for (const inFlight of broker.inFlightRequests.values()) {
      inFlight.stopHeartbeat();
      inFlight.release();
    }
    for (const timeoutId of broker.retryTimers.values()) {
      clearTimeout(timeoutId);
    }
    for (const waiter of broker.changeWaiters) {
      waiter();
    }
  }
  environmentBrokers.clear();
  registrationSequence = 0;
  backgroundDispatchQueue = Promise.resolve();
}
