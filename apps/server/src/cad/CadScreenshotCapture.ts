import { randomUUID } from "node:crypto";

import type {
  CadRequestClaim,
  CadRequestClaimInput,
  CadRequestClaimResult,
  CadScreenshotBrowserRequest,
  CadScreenshotCaptureHttpResult,
  CadView,
  ThreadId,
} from "@cadsense/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import {
  claimCadRequestLease,
  isCadRequestAvailable,
  ownsCadRequestLease,
  type CadRequestLease,
} from "./CadRequestLease.ts";

const CAPTURE_TIMEOUT = Duration.seconds(120);
export const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024;
const CAD_SCREENSHOT_REQUEST_PUBSUB_CAPACITY = 256;

const cadScreenshotRequestPubSub = Effect.runSync(
  PubSub.bounded<CadScreenshotBrowserRequest>(CAD_SCREENSHOT_REQUEST_PUBSUB_CAPACITY),
);

export const publishCadScreenshotRequest = (
  event: CadScreenshotBrowserRequest,
): Effect.Effect<void> => PubSub.publish(cadScreenshotRequestPubSub, event);

interface CadScreenshotPending {
  readonly deferred: Deferred.Deferred<CadScreenshotCaptureHttpResult, Error>;
  readonly threadId: string;
  readonly exportRoot: string;
  readonly suggestedBaseName: string | undefined;
  readonly browserRequest: CadScreenshotBrowserRequest;
  lease: CadRequestLease | undefined;
}

const pendingByRequestId = new Map<string, CadScreenshotPending>();

export const cadScreenshotRequestStream = Stream.unwrap(
  Effect.gen(function* () {
    const subscription = yield* PubSub.subscribe(cadScreenshotRequestPubSub);
    const nowMs = yield* Clock.currentTimeMillis;
    const pendingRequests = [...pendingByRequestId.values()]
      .filter((entry) => isCadRequestAvailable(entry, nowMs))
      .map((entry) => entry.browserRequest);
    return Stream.concat(
      Stream.fromIterable(pendingRequests),
      Stream.fromSubscription(subscription),
    );
  }),
);

export const startCadScreenshotCaptureEffect = (input: {
  readonly threadId: ThreadId;
  readonly exportRoot: string;
  readonly suggestedBaseName: string | undefined;
  readonly view: CadView | undefined;
  readonly fit: boolean;
}): Effect.Effect<
  {
    readonly requestId: string;
    readonly browserRequest: CadScreenshotBrowserRequest;
    readonly awaitResult: Effect.Effect<CadScreenshotCaptureHttpResult, Error, never>;
  },
  never,
  never
> =>
  Effect.gen(function* () {
    const requestId = randomUUID();
    const deferred = yield* Deferred.make<CadScreenshotCaptureHttpResult, Error>();
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const browserRequest: CadScreenshotBrowserRequest = {
      requestId,
      threadId: input.threadId,
      createdAt,
      view: input.view,
      fit: input.fit,
      suggestedBaseName: input.suggestedBaseName,
    };
    pendingByRequestId.set(requestId, {
      deferred,
      threadId: input.threadId,
      exportRoot: input.exportRoot,
      suggestedBaseName: input.suggestedBaseName,
      browserRequest,
      lease: undefined,
    });
    return {
      requestId,
      browserRequest,
      awaitResult: Deferred.await(deferred),
    };
  });

export function completeCadScreenshotPending(
  requestId: string,
  claim: CadRequestClaim,
  result: CadScreenshotCaptureHttpResult,
  nowMs = Effect.runSync(Clock.currentTimeMillis),
): boolean {
  const entry = pendingByRequestId.get(requestId);
  if (!entry || !ownsCadRequestLease(entry, claim, nowMs)) {
    return false;
  }
  pendingByRequestId.delete(requestId);
  Effect.runFork(Deferred.succeed(entry.deferred, result));
  return true;
}

export function claimCadScreenshotPending(
  input: CadRequestClaimInput,
  nowMs = Effect.runSync(Clock.currentTimeMillis),
): CadRequestClaimResult {
  const entry = pendingByRequestId.get(input.requestId);
  if (!entry) {
    return { status: "unavailable", reason: "unknown-or-finalized" };
  }
  return claimCadRequestLease(entry, input.responderId, nowMs);
}

export function failCadScreenshotPending(
  requestId: string,
  claim: CadRequestClaim,
  message: string,
  nowMs = Effect.runSync(Clock.currentTimeMillis),
): boolean {
  const entry = pendingByRequestId.get(requestId);
  if (!entry || !ownsCadRequestLease(entry, claim, nowMs)) {
    return false;
  }
  pendingByRequestId.delete(requestId);
  Effect.runFork(Deferred.fail(entry.deferred, new Error(message)));
  return true;
}

export function rejectCadScreenshotPending(requestId: string, message: string): boolean {
  const entry = pendingByRequestId.get(requestId);
  if (!entry) {
    return false;
  }
  pendingByRequestId.delete(requestId);
  Effect.runFork(Deferred.fail(entry.deferred, new Error(message)));
  return true;
}

export function rejectCadScreenshotPendingForThread(threadId: ThreadId, message: string): number {
  let rejectedCount = 0;
  for (const [requestId, entry] of pendingByRequestId) {
    if (entry.threadId !== threadId) {
      continue;
    }
    pendingByRequestId.delete(requestId);
    Effect.runFork(Deferred.fail(entry.deferred, new Error(message)));
    rejectedCount += 1;
  }
  return rejectedCount;
}

export function getCadScreenshotPendingExportRoot(requestId: string): string | undefined {
  return pendingByRequestId.get(requestId)?.exportRoot;
}

export function getCadScreenshotPendingThreadId(requestId: string): string | undefined {
  return pendingByRequestId.get(requestId)?.threadId;
}

export function getCadScreenshotPendingSuggestedBaseName(requestId: string): string | undefined {
  return pendingByRequestId.get(requestId)?.suggestedBaseName;
}

export function getCadScreenshotPendingForClaim(
  requestId: string,
  claim: CadRequestClaim,
  nowMs = Effect.runSync(Clock.currentTimeMillis),
):
  | {
      readonly exportRoot: string;
      readonly threadId: string;
      readonly suggestedBaseName: string | undefined;
    }
  | undefined {
  const entry = pendingByRequestId.get(requestId);
  if (!entry || !ownsCadRequestLease(entry, claim, nowMs)) {
    return undefined;
  }
  return {
    exportRoot: entry.exportRoot,
    threadId: entry.threadId,
    suggestedBaseName: entry.suggestedBaseName,
  };
}

export function sanitizeCadScreenshotBaseName(raw: string | undefined): string {
  const normalized = (raw ?? "cad-view")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized.length > 0 ? normalized : "cad-view";
}

export function makeCadScreenshotFilename(
  stamp: string,
  suggestedBaseName: string | undefined,
): string {
  return `${stamp}_${sanitizeCadScreenshotBaseName(suggestedBaseName)}.png`;
}

export { CAPTURE_TIMEOUT };
