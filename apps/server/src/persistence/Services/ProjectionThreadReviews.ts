import { CadReviewId, CadReviewReport, ThreadId } from "@cadsense/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadReview = Schema.Struct({
  reviewId: CadReviewId,
  threadId: ThreadId,
  review: CadReviewReport,
  createdAt: CadReviewReport.fields.createdAt,
  updatedAt: CadReviewReport.fields.updatedAt,
});
export type ProjectionThreadReview = typeof ProjectionThreadReview.Type;

export const ListProjectionThreadReviewsInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadReviewsInput = typeof ListProjectionThreadReviewsInput.Type;

export const DeleteProjectionThreadReviewsInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadReviewsInput = typeof DeleteProjectionThreadReviewsInput.Type;

export interface ProjectionThreadReviewRepositoryShape {
  readonly upsert: (
    review: ProjectionThreadReview,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ListProjectionThreadReviewsInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadReview>, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadReviewsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadReviewRepository extends Context.Service<
  ProjectionThreadReviewRepository,
  ProjectionThreadReviewRepositoryShape
>()("cadsense/persistence/Services/ProjectionThreadReviews/ProjectionThreadReviewRepository") {}
