import type { OrchestrationEvent, ThreadId } from "@cadsense/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface CadReviewServiceShape {
  readonly generateReview: (
    event: Extract<OrchestrationEvent, { type: "thread.review-requested" }>,
  ) => Effect.Effect<void, never>;
  readonly recoverInterruptedReviews: () => Effect.Effect<void, never>;
}

export class CadReviewService extends Context.Service<CadReviewService, CadReviewServiceShape>()(
  "cadsense/orchestration/Services/CadReviewService",
) {}

export interface CadReviewReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class CadReviewReactor extends Context.Service<CadReviewReactor, CadReviewReactorShape>()(
  "cadsense/orchestration/Services/CadReviewReactor",
) {}

export type CadReviewRequestEvent = Extract<
  OrchestrationEvent,
  { type: "thread.review-requested"; aggregateId: ThreadId }
>;
