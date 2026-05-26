import type { OrchestrationEvent } from "@cadsense/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { CadReviewService } from "../Services/CadReviewService.ts";
import { CadReviewReactor, type CadReviewReactorShape } from "../Services/CadReviewService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";

const reviewKey = (
  event: Extract<
    OrchestrationEvent,
    { type: "thread.review-requested" | "thread.review-stop-requested" }
  >,
) => `${event.payload.threadId}\0${event.payload.reviewRunId}`;

const RECOVERY_SWEEP_INTERVAL = Duration.minutes(1);

export const tryClaimCadReviewRun = (input: {
  readonly sql: SqlClient.SqlClient;
  readonly event: Extract<OrchestrationEvent, { type: "thread.review-requested" }>;
  readonly workerId: string;
}) =>
  Effect.gen(function* () {
    const claimedAt = DateTime.formatIso(yield* DateTime.now);
    const rows = yield* input.sql<{ readonly acquired: number }>`
      INSERT INTO cad_review_run_claims (
        review_id,
        thread_id,
        worker_id,
        command_id,
        claimed_at
      )
      VALUES (
        ${input.event.payload.reviewRunId},
        ${input.event.payload.threadId},
        ${input.workerId},
        ${input.event.commandId},
        ${claimedAt}
      )
      ON CONFLICT (review_id) DO NOTHING
      RETURNING 1 AS "acquired"
    `;
    return rows.length > 0;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("cad review reactor failed to claim review run", {
        reviewRunId: input.event.payload.reviewRunId,
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(false)),
    ),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const cadReviewService = yield* CadReviewService;
  const runningReviews = new Map<string, Fiber.Fiber<void, never>>();
  const workerId = `${process.pid}:${crypto.randomUUID()}`;

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
      const claimed = yield* tryClaimCadReviewRun({ sql, event, workerId });
      if (!claimed) {
        return;
      }
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
    const recoverInterruptedReviews = cadReviewService.recoverInterruptedReviews().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("cad review reactor failed to recover interrupted reviews", {
          cause: Cause.pretty(cause),
        }),
      ),
    );

    yield* recoverInterruptedReviews;
    yield* Effect.forkScoped(
      recoverInterruptedReviews.pipe(Effect.repeat(Schedule.spaced(RECOVERY_SWEEP_INTERVAL))),
    );
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
