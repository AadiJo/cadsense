import type { OrchestrationEvent } from "@cadsense/contracts";
import { makeDrainableWorker } from "@cadsense/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { CadReviewService } from "../Services/CadReviewService.ts";
import { CadReviewReactor, type CadReviewReactorShape } from "../Services/CadReviewService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const cadReviewService = yield* CadReviewService;

  const processEvent = (event: OrchestrationEvent) =>
    event.type === "thread.review-requested" ? cadReviewService.generateReview(event) : Effect.void;

  const processEventSafely = (event: OrchestrationEvent) =>
    processEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("cad review reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processEventSafely);

  const start: CadReviewReactorShape["start"] = Effect.fn("start")(function* () {
    yield* cadReviewService.recoverInterruptedReviews();
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        event.type === "thread.review-requested" ? worker.enqueue(event) : Effect.void,
      ),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies CadReviewReactorShape;
});

export const CadReviewReactorLive = Layer.effect(CadReviewReactor, make);
