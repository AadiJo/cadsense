import type { Thread } from "./types";

export function threadHasStarted(thread: Thread | null | undefined): boolean {
  if (!thread) {
    return false;
  }
  return thread.latestTurn != null || (thread.messages?.length ?? 0) > 0 || thread.session != null;
}
