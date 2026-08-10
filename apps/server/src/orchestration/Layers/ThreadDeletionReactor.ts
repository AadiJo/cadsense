import type { OrchestrationEvent } from "@cadsense/contracts";
import { makeDrainableWorker } from "@cadsense/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { markCadThreadCreated, markCadThreadDeleted } from "../../cad/CadThreadAliases.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor.ts";

type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;
type ThreadLifecycleEvent = Extract<
  OrchestrationEvent,
  { type: "thread.created" | "thread.deleted" }
>;

export const logCleanupCauseUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>;
  readonly message: string;
  readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
}): Effect.Effect<void, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logDebug(message, {
        threadId,
        cause: Cause.pretty(cause),
      });
    }),
  );

export const cleanupDeletedThread = <R, E>({
  stopProviderSession,
  threadId,
}: {
  readonly stopProviderSession: Effect.Effect<void, E, R>;
  readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
}): Effect.Effect<void, E, R> =>
  Effect.sync(() => markCadThreadDeleted(threadId)).pipe(
    Effect.andThen(
      logCleanupCauseUnlessInterrupted({
        effect: stopProviderSession,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    ),
  );

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;

  const processThreadLifecycle = Effect.fn("processThreadLifecycle")(function* (
    event: ThreadLifecycleEvent,
  ) {
    const { threadId } = event.payload;
    if (event.type === "thread.created") {
      yield* Effect.sync(() => markCadThreadCreated(threadId));
      return;
    }
    yield* cleanupDeletedThread({
      stopProviderSession: providerService.stopSession({ threadId }),
      threadId,
    });
  });

  const processThreadLifecycleSafely = (event: ThreadLifecycleEvent) =>
    processThreadLifecycle(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread deletion reactor failed to process event", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processThreadLifecycleSafely);

  const start: ThreadDeletionReactorShape["start"] = Effect.fn("start")(function* () {
    const domainEvents = yield* orchestrationEngine.subscribeDomainEvents;
    yield* Effect.forkScoped(
      Stream.runForEach(Stream.fromSubscription(domainEvents), (event) => {
        if (event.type !== "thread.created" && event.type !== "thread.deleted") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadDeletionReactorShape;
});

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make);
