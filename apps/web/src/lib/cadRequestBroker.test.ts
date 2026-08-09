import { EnvironmentId, ThreadId, type EnvironmentApi } from "@cadsense/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetCadRequestBrokersForTests,
  registerCadBrokerActivator,
  registerCadBrokerResponder,
  selectCadBrokerResponder,
  type CadBrokerResponder,
} from "./cadRequestBroker";

const environmentId = EnvironmentId.make("environment-cad-broker");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function subscribe<T>(target: Array<(request: T) => void>, listener: (request: T) => void) {
  target.push(listener);
  return () => target.splice(target.indexOf(listener), 1);
}

function makeApi() {
  const listeners = {
    view: [] as Array<(request: never) => void>,
    hierarchy: [] as Array<(request: never) => void>,
    screenshot: [] as Array<(request: never) => void>,
  };
  const api = {
    onshape: {
      onCadViewCommand: (listener: (request: never) => void) => subscribe(listeners.view, listener),
      onCadHierarchyRequest: (listener: (request: never) => void) =>
        subscribe(listeners.hierarchy, listener),
      onCadScreenshotRequest: (listener: (request: never) => void) =>
        subscribe(listeners.screenshot, listener),
      claimCadHierarchyRequest: vi.fn(async () => ({
        status: "claimed",
        leaseId: "hierarchy-lease",
        leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
        attempt: 1,
      })),
      claimCadScreenshotRequest: vi.fn(async () => ({
        status: "claimed",
        leaseId: "screenshot-lease",
        leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
        attempt: 1,
      })),
    },
  } as unknown as EnvironmentApi;
  return { api, listeners };
}

function responder(
  input: Partial<CadBrokerResponder> & { responderId: string },
): CadBrokerResponder {
  return {
    responderId: input.responderId,
    routingThreadId: input.routingThreadId ?? "visible",
    sameProjectThreadIds: input.sameProjectThreadIds ?? ["visible", "sibling"],
    activeReviewThreadIds: input.activeReviewThreadIds ?? [],
    reviewChildThreadIds: input.reviewChildThreadIds ?? [],
    controlsReviewChildren: input.controlsReviewChildren ?? false,
    allowProjectFallback: input.allowProjectFallback ?? true,
    visibility: input.visibility ?? "visible",
    onViewCommand: input.onViewCommand ?? vi.fn(),
    onHierarchyRequest: input.onHierarchyRequest ?? vi.fn(),
    onScreenshotRequest: input.onScreenshotRequest ?? vi.fn(),
  };
}

async function flushBroker() {
  for (let step = 0; step < 10; step++) {
    await Promise.resolve();
  }
}

afterEach(() => {
  vi.useRealTimers();
  __resetCadRequestBrokersForTests();
});

describe("CAD request broker", () => {
  it("selects exact and review-child owners ahead of same-project fallback", () => {
    const fallback = responder({ responderId: "fallback", routingThreadId: "visible" });
    const exact = responder({ responderId: "exact", routingThreadId: "sibling" });
    const review = responder({
      responderId: "review",
      routingThreadId: "review-parent",
      reviewChildThreadIds: ["review-child"],
      controlsReviewChildren: true,
      allowProjectFallback: false,
      visibility: "background",
    });

    expect(
      selectCadBrokerResponder(
        [
          { order: 1, responder: fallback },
          { order: 2, responder: exact },
          { order: 3, responder: review },
        ],
        "sibling",
        new Set(["review-parent", "review-child"]),
      )?.responderId,
    ).toBe("exact");
    expect(
      selectCadBrokerResponder(
        [
          { order: 1, responder: fallback },
          { order: 3, responder: review },
        ],
        "review-child",
        new Set(["review-parent", "review-child"]),
      )?.responderId,
    ).toBe("review");
  });

  it("uses one environment subscription and excludes visible siblings from review-child work", async () => {
    const { api, listeners } = makeApi();
    const visibleScreenshot = vi.fn();
    const reviewScreenshot = vi.fn();
    registerCadBrokerResponder(
      environmentId,
      api,
      responder({ responderId: "visible", onScreenshotRequest: visibleScreenshot }),
    );
    registerCadBrokerResponder(
      environmentId,
      api,
      responder({
        responderId: "review",
        routingThreadId: "review-parent",
        reviewChildThreadIds: ["review-child"],
        controlsReviewChildren: true,
        allowProjectFallback: false,
        visibility: "background",
        onScreenshotRequest: reviewScreenshot,
      }),
    );

    expect(listeners.screenshot).toHaveLength(1);
    listeners.screenshot[0]!({
      requestId: "request-1",
      threadId: ThreadId.make("review-child"),
      createdAt: new Date().toISOString(),
      fit: true,
    } as never);
    await flushBroker();

    expect(reviewScreenshot).toHaveBeenCalledOnce();
    expect(visibleScreenshot).not.toHaveBeenCalled();
  });

  it("retries an expired competing claim once without holding the dispatch queue", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { api, listeners } = makeApi();
    const screenshot = vi.fn();
    const claim = vi.mocked(api.onshape.claimCadScreenshotRequest);
    claim.mockResolvedValueOnce({
      status: "unavailable",
      reason: "already-claimed",
      retryAt: "2026-01-01T00:00:00.020Z",
    });
    registerCadBrokerResponder(
      environmentId,
      api,
      responder({ responderId: "retry-owner", onScreenshotRequest: screenshot }),
    );

    listeners.screenshot[0]!({
      requestId: "retry-request",
      threadId: ThreadId.make("visible"),
      createdAt: "2026-01-01T00:00:00.000Z",
      fit: true,
    } as never);
    await flushBroker();
    expect(claim).toHaveBeenCalledOnce();
    expect(screenshot).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20);
    await flushBroker();
    expect(claim).toHaveBeenCalledTimes(2);
    expect(screenshot).toHaveBeenCalledOnce();
  });

  it("keeps following renewed competing leases until failover succeeds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { api, listeners } = makeApi();
    const screenshot = vi.fn();
    const claim = vi.mocked(api.onshape.claimCadScreenshotRequest);
    claim
      .mockResolvedValueOnce({
        status: "unavailable",
        reason: "already-claimed",
        retryAt: "2026-01-01T00:00:00.020Z",
      })
      .mockResolvedValueOnce({
        status: "unavailable",
        reason: "already-claimed",
        retryAt: "2026-01-01T00:00:00.040Z",
      });
    registerCadBrokerResponder(
      environmentId,
      api,
      responder({ responderId: "eventual-owner", onScreenshotRequest: screenshot }),
    );
    listeners.screenshot[0]!({
      requestId: "renewed-winner-request",
      threadId: ThreadId.make("visible"),
      createdAt: "2026-01-01T00:00:00.000Z",
      fit: true,
    } as never);
    await flushBroker();

    await vi.advanceTimersByTimeAsync(20);
    await flushBroker();
    expect(claim).toHaveBeenCalledTimes(2);
    expect(screenshot).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20);
    await flushBroker();
    expect(claim).toHaveBeenCalledTimes(3);
    expect(screenshot).toHaveBeenCalledOnce();
  });

  it("deduplicates replayed requests while the selected handler is in flight", async () => {
    const { api, listeners } = makeApi();
    const finished = deferred();
    const screenshot = vi.fn(() => finished.promise);
    registerCadBrokerResponder(
      environmentId,
      api,
      responder({ responderId: "dedupe-owner", onScreenshotRequest: screenshot }),
    );
    const request = {
      requestId: "duplicate-request",
      threadId: ThreadId.make("visible"),
      createdAt: new Date().toISOString(),
      fit: true,
    } as never;

    listeners.screenshot[0]!(request);
    listeners.screenshot[0]!(request);
    await flushBroker();

    expect(api.onshape.claimCadScreenshotRequest).toHaveBeenCalledOnce();
    expect(screenshot).toHaveBeenCalledOnce();
    finished.resolve();
    await flushBroker();
  });

  it("renews a long-running handler claim and stops the heartbeat when it settles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { api, listeners } = makeApi();
    const finished = deferred();
    registerCadBrokerResponder(
      environmentId,
      api,
      responder({
        responderId: "heartbeat-owner",
        onScreenshotRequest: () => finished.promise,
      }),
    );

    listeners.screenshot[0]!({
      requestId: "heartbeat-request",
      threadId: ThreadId.make("visible"),
      createdAt: "2026-01-01T00:00:00.000Z",
      fit: true,
    } as never);
    await flushBroker();
    expect(api.onshape.claimCadScreenshotRequest).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.onshape.claimCadScreenshotRequest).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.onshape.claimCadScreenshotRequest).toHaveBeenCalledTimes(3);

    finished.resolve();
    await flushBroker();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.onshape.claimCadScreenshotRequest).toHaveBeenCalledTimes(3);
  });

  it("updates the active handler token when a suspended browser reclaims a new lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { api, listeners } = makeApi();
    const finished = deferred();
    let handlerClaim: { readonly leaseId: string } | undefined;
    const claim = vi.mocked(api.onshape.claimCadScreenshotRequest);
    claim
      .mockReset()
      .mockResolvedValueOnce({
        status: "claimed",
        leaseId: "lease-before-suspension",
        leaseExpiresAt: "2026-01-01T00:00:30.000Z",
        attempt: 1,
      })
      .mockResolvedValue({
        status: "claimed",
        leaseId: "lease-after-suspension",
        leaseExpiresAt: "2026-01-01T00:01:10.000Z",
        attempt: 2,
      });
    registerCadBrokerResponder(
      environmentId,
      api,
      responder({
        responderId: "suspended-owner",
        onScreenshotRequest: (_request, activeClaim) => {
          handlerClaim = activeClaim;
          return finished.promise;
        },
      }),
    );
    listeners.screenshot[0]!({
      requestId: "suspended-request",
      threadId: ThreadId.make("visible"),
      createdAt: "2026-01-01T00:00:00.000Z",
      fit: true,
    } as never);
    await flushBroker();
    expect(handlerClaim?.leaseId).toBe("lease-before-suspension");

    // Move wall time beyond the original lease before delivering the delayed timer callback.
    vi.setSystemTime(new Date("2026-01-01T00:00:40.000Z"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(handlerClaim?.leaseId).toBe("lease-after-suspension");

    finished.resolve();
    await flushBroker();
  });

  it("stops heartbeats when a responder unmounts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { api, listeners } = makeApi();
    const finished = deferred();
    const unregister = registerCadBrokerResponder(
      environmentId,
      api,
      responder({
        responderId: "unmounted-owner",
        onScreenshotRequest: () => finished.promise,
      }),
    );
    listeners.screenshot[0]!({
      requestId: "unmounted-request",
      threadId: ThreadId.make("visible"),
      createdAt: "2026-01-01T00:00:00.000Z",
      fit: true,
    } as never);
    await flushBroker();

    unregister();
    await flushBroker();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.onshape.claimCadScreenshotRequest).toHaveBeenCalledOnce();
    finished.resolve();
  });

  it("keeps a claimed background viewer mounted until its handler finishes", async () => {
    const { api, listeners } = makeApi();
    const firstFinished = deferred();
    const activations: string[] = [];
    let removeCurrent: () => void = vi.fn();
    const activate = (parent: string, child: string, wait?: Promise<void>) => {
      removeCurrent();
      activations.push(parent);
      removeCurrent = registerCadBrokerResponder(
        environmentId,
        api,
        responder({
          responderId: `background-${parent}`,
          routingThreadId: parent,
          reviewChildThreadIds: [child],
          controlsReviewChildren: true,
          allowProjectFallback: false,
          visibility: "background",
          onScreenshotRequest: () => wait,
        }),
      );
    };
    for (const [parent, child, wait] of [
      ["review-a", "child-a", firstFinished.promise],
      ["review-b", "child-b", undefined],
    ] as const) {
      registerCadBrokerActivator(environmentId, api, {
        activatorId: `activate-${parent}`,
        routingThreadId: parent,
        sameProjectThreadIds: [parent],
        activeReviewThreadIds: [parent],
        reviewChildThreadIds: [child],
        controlsReviewChildren: true,
        allowProjectFallback: false,
        activate: () => activate(parent, child, wait),
      });
    }

    const createdAt = new Date().toISOString();
    listeners.screenshot[0]!({
      requestId: "a",
      threadId: "child-a",
      createdAt,
      fit: true,
    } as never);
    await flushBroker();
    listeners.screenshot[0]!({
      requestId: "b",
      threadId: "child-b",
      createdAt,
      fit: true,
    } as never);
    await flushBroker();
    expect(activations).toEqual(["review-a"]);

    firstFinished.resolve();
    await vi.waitFor(() => expect(activations).toEqual(["review-a", "review-b"]));
    removeCurrent();
  });
});
