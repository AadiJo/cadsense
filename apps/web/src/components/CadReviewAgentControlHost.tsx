import {
  EnvironmentId,
  type CadReviewStatus,
  type ScopedThreadRef,
  ThreadId,
} from "@cadsense/contracts";
import { scopeThreadRef } from "@cadsense/client-runtime";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { getThreadFromEnvironmentState } from "../threadDerivation";
import { type AppState, useStore } from "../store";
import CadPanel from "./CadPanel";

const ACTIVE_CAD_REVIEW_STATUSES = new Set<CadReviewStatus>([
  "requested",
  "planning",
  "capturing-baseline",
  "reviewing",
  "deep-diving",
  "synthesizing",
]);

const THREAD_REF_KEY_SEPARATOR = "\0";

function threadRefKey(ref: ScopedThreadRef): string {
  return `${ref.environmentId}${THREAD_REF_KEY_SEPARATOR}${ref.threadId}`;
}

function parseThreadRefKey(key: string): ScopedThreadRef | null {
  const [environmentId, threadId, ...extra] = key.split(THREAD_REF_KEY_SEPARATOR);
  if (!environmentId || !threadId || extra.length > 0) {
    return null;
  }
  return scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId));
}

function selectActiveCadReviewThreadKeys(state: AppState): string[] {
  const keys: string[] = [];
  for (const environmentState of Object.values(state.environmentStateById)) {
    for (const threadId of environmentState.threadIds) {
      const thread = getThreadFromEnvironmentState(environmentState, threadId);
      if (!thread) {
        continue;
      }
      if ((thread.reviews ?? []).some((review) => ACTIVE_CAD_REVIEW_STATUSES.has(review.status))) {
        keys.push(threadRefKey(scopeThreadRef(thread.environmentId, thread.id)));
      }
    }
  }
  return keys.toSorted();
}

export function CadReviewAgentControlHost() {
  const activeReviewThreadKeys = useStore(useShallow(selectActiveCadReviewThreadKeys));
  const activeReviewThreadRefs = useMemo(
    () =>
      activeReviewThreadKeys
        .map(parseThreadRefKey)
        .filter((ref): ref is ScopedThreadRef => ref !== null),
    [activeReviewThreadKeys],
  );

  if (activeReviewThreadRefs.length === 0) {
    return null;
  }

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed top-0 left-[-10000px] z-[-1] h-[720px] w-[960px] overflow-hidden opacity-0"
      data-cad-review-agent-control-host="true"
    >
      {activeReviewThreadRefs.map((threadRef) => (
        <div key={threadRefKey(threadRef)} className="h-[720px] w-[960px]">
          <CadPanel mode="inline" threadRef={threadRef} agentControlHost />
        </div>
      ))}
    </div>
  );
}
