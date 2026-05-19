export function isCadReviewChildThreadId(threadId: string): boolean {
  return threadId.includes(":cad-review:");
}
