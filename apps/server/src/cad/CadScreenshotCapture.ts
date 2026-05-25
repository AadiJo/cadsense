import { randomUUID } from "node:crypto";

import type {
  CadScreenshotBrowserRequest,
  CadScreenshotCaptureHttpResult,
  CadView,
  ThreadId,
} from "@cadsense/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

const CAPTURE_TIMEOUT = Duration.seconds(45);
export const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024;

const cadScreenshotRequestPubSub = Effect.runSync(PubSub.unbounded<CadScreenshotBrowserRequest>());

export const publishCadScreenshotRequest = (
  event: CadScreenshotBrowserRequest,
): Effect.Effect<void> => PubSub.publish(cadScreenshotRequestPubSub, event);

interface CadScreenshotPending {
  readonly deferred: Deferred.Deferred<CadScreenshotCaptureHttpResult, Error>;
  readonly threadId: string;
  readonly exportRoot: string;
  readonly suggestedBaseName: string | undefined;
  readonly browserRequest: CadScreenshotBrowserRequest;
}

const pendingByRequestId = new Map<string, CadScreenshotPending>();

export const cadScreenshotRequestStream = Stream.unwrap(
  Effect.gen(function* () {
    const subscription = yield* PubSub.subscribe(cadScreenshotRequestPubSub);
    const pendingRequests = [...pendingByRequestId.values()].map((entry) => entry.browserRequest);
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
    const browserRequest: CadScreenshotBrowserRequest = {
      requestId,
      threadId: input.threadId,
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
    });
    return {
      requestId,
      browserRequest,
      awaitResult: Deferred.await(deferred),
    };
  });

export function completeCadScreenshotPending(
  requestId: string,
  result: CadScreenshotCaptureHttpResult,
): boolean {
  const entry = pendingByRequestId.get(requestId);
  if (!entry) {
    return false;
  }
  pendingByRequestId.delete(requestId);
  Effect.runFork(Deferred.succeed(entry.deferred, result));
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
