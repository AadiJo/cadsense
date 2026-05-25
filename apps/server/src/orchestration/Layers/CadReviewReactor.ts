import type { OrchestrationEvent } from "@cadsense/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { CadReviewService } from "../Services/CadReviewService.ts";
import { CadReviewReactor, type CadReviewReactorShape } from "../Services/CadReviewService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";

const reviewKey = (
  event: Extract<
    OrchestrationEvent,
    { type: "thread.review-requested" | "thread.review-stop-requested" }
  >,
) => `${event.payload.threadId}\0${event.payload.reviewRunId}`;

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const cadReviewService = yield* CadReviewService;
  const runningReviews = new Map<string, Fiber.Fiber<void, never>>();

  const runReviewSafely = (
    event: Extract<OrchestrationEvent, { type: "thread.review-requested" }>,
  ) =>
    cadReviewService.generateReview(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        return Effect.logWarning("cad review reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
      Effect.ensuring(Effect.sync(() => runningReviews.delete(reviewKey(event)))),
    );

  const startReview = (event: Extract<OrchestrationEvent, { type: "thread.review-requested" }>) =>
    Effect.gen(function* () {
      const key = reviewKey(event);
      const existing = runningReviews.get(key);
      if (existing) {
        yield* Fiber.interrupt(existing).pipe(Effect.ignore);
      }
      const fiber = yield* runReviewSafely(event).pipe(Effect.forkScoped);
      runningReviews.set(key, fiber);
    });

  const stopReview = (
    event: Extract<OrchestrationEvent, { type: "thread.review-stop-requested" }>,
  ) =>
    Effect.gen(function* () {
      yield* cadReviewService.stopReview(event);
      const fiber = runningReviews.get(reviewKey(event));
      if (fiber) {
        yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
      }
    });

  const start: CadReviewReactorShape["start"] = Effect.fn("start")(function* () {
    yield* cadReviewService.recoverInterruptedReviews();
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        event.type === "thread.review-requested"
          ? startReview(event)
          : event.type === "thread.review-stop-requested"
            ? stopReview(event)
            : Effect.void,
      ),
    );
  });

  return {
    start,
    drain: Effect.void,
  } satisfies CadReviewReactorShape;
});

export const CadReviewReactorLive = Layer.effect(CadReviewReactor, make);
