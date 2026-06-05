import type { CadReviewReport, CadReviewStatus } from "@cadsense/contracts";

const CAD_REVIEW_SUCCESS_STATUSES: ReadonlySet<CadReviewStatus> = new Set(["completed", "partial"]);

export const CAD_REVIEW_RUNNING_STATUSES: ReadonlySet<CadReviewStatus> = new Set([
  "requested",
  "planning",
  "capturing-baseline",
  "reviewing",
  "deep-diving",
  "synthesizing",
]);

export function isRunningCadReviewStatus(status: CadReviewStatus): boolean {
  return CAD_REVIEW_RUNNING_STATUSES.has(status);
}

export function hasRunningCadReview(
  reviews: ReadonlyArray<Pick<CadReviewReport, "status">> | undefined,
): boolean {
  return reviews?.some((review) => isRunningCadReviewStatus(review.status)) ?? false;
}

export function shouldKeepExistingCadReviewOnUpsert(
  existing: Pick<CadReviewReport, "status"> | undefined,
  incoming: Pick<CadReviewReport, "status">,
): boolean {
  return (
    existing !== undefined &&
    CAD_REVIEW_SUCCESS_STATUSES.has(existing.status) &&
    incoming.status === "failed"
  );
}
