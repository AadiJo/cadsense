import { type ScopedThreadRef } from "@cadsense/contracts";
import { scopeThreadRef } from "@cadsense/client-runtime";
import { useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { getThreadFromEnvironmentState } from "../threadDerivation";
import { hasRunningCadReview } from "../lib/cadReviewStatus";
import { cadReviewChildThreadIdsForActiveReviewsInEnvironment } from "../lib/cadAgentViewState";
import { registerCadBrokerActivator } from "../lib/cadRequestBroker";
import { readEnvironmentApi } from "../environmentApi";
import { type AppState, useStore } from "../store";
import { resolveThreadRouteRef } from "../threadRoutes";
import CadPanel from "./CadPanel";

const THREAD_REF_KEY_SEPARATOR = "\0";

function threadRefKey(ref: ScopedThreadRef): string {
  return `${ref.environmentId}${THREAD_REF_KEY_SEPARATOR}${ref.threadId}`;
}

interface CadReviewHostCandidate {
  readonly key: string;
  readonly threadRef: ScopedThreadRef;
  readonly childThreadIds: readonly string[];
}

export function selectActiveCadReviewHostCandidates(state: AppState): CadReviewHostCandidate[] {
  const candidates: CadReviewHostCandidate[] = [];
  for (const environmentState of Object.values(state.environmentStateById)) {
    for (const threadId of environmentState.threadIds) {
      const thread = getThreadFromEnvironmentState(environmentState, threadId);
      if (!thread) {
        continue;
      }
      if (hasRunningCadReview(thread.reviews)) {
        const threadRef = scopeThreadRef(thread.environmentId, thread.id);
        candidates.push({
          key: threadRefKey(threadRef),
          threadRef,
          childThreadIds: cadReviewChildThreadIdsForActiveReviewsInEnvironment(
            environmentState,
            thread,
          ),
        });
      }
    }
  }
  return candidates.toSorted((left, right) => left.key.localeCompare(right.key));
}

export function CadReviewAgentControlHost() {
  const visibleThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const activeReviewCandidates = useStore(useShallow(selectActiveCadReviewHostCandidates));
  const visibleThreadKey = visibleThreadRef ? threadRefKey(visibleThreadRef) : null;
  const backgroundCandidates = useMemo(
    () => activeReviewCandidates.filter((candidate) => candidate.key !== visibleThreadKey),
    [activeReviewCandidates, visibleThreadKey],
  );
  const [activatedThreadKey, setActivatedThreadKey] = useState<string | null>(null);
  const activeCandidate =
    backgroundCandidates.find((candidate) => candidate.key === activatedThreadKey) ??
    backgroundCandidates[0] ??
    null;

  useEffect(() => {
    const unregister: Array<() => void> = [];
    for (const candidate of backgroundCandidates) {
      const api = readEnvironmentApi(candidate.threadRef.environmentId);
      if (!api) {
        continue;
      }
      unregister.push(
        registerCadBrokerActivator(candidate.threadRef.environmentId, api, {
          activatorId: `cad-review-host:${candidate.key}`,
          routingThreadId: candidate.threadRef.threadId,
          sameProjectThreadIds: [candidate.threadRef.threadId],
          activeReviewThreadIds: [candidate.threadRef.threadId],
          reviewChildThreadIds: candidate.childThreadIds,
          controlsReviewChildren: true,
          allowProjectFallback: false,
          activate: () => setActivatedThreadKey(candidate.key),
        }),
      );
    }
    return () => {
      for (const remove of unregister) {
        remove();
      }
    };
  }, [backgroundCandidates]);

  if (!activeCandidate) {
    return null;
  }

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed top-0 left-[-10000px] z-[-1] h-[720px] w-[960px] overflow-hidden opacity-0"
      data-cad-review-agent-control-host="true"
      data-cad-review-host-candidate-count={backgroundCandidates.length}
    >
      <div key={activeCandidate.key} className="h-[720px] w-[960px]">
        <CadPanel mode="inline" threadRef={activeCandidate.threadRef} agentControlHost />
      </div>
    </div>
  );
}
