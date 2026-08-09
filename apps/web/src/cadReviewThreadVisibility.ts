export function isCadReviewChildThreadId(threadId: string): boolean {
  return threadId.includes(":cad-review:");
}

export function isCadReviewChildThread(thread: {
  readonly id: string;
  readonly purpose?: "general" | "cad-review";
}): boolean {
  return thread.purpose === "cad-review" || isCadReviewChildThreadId(thread.id);
}
