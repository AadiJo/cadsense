import type {
  CadReviewId,
  CadReviewReport,
  MessageId,
  ThreadId,
  TurnId,
} from "@cadsense/contracts";
import type { EnvironmentState } from "./store";
import type {
  ChatMessage,
  ProposedPlan,
  Thread,
  ThreadSession,
  ThreadShell,
  ThreadTurnState,
  TurnDiffSummary,
} from "./types";

const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_ACTIVITIES: Thread["activities"] = [];
const EMPTY_PROPOSED_PLANS: ProposedPlan[] = [];
const EMPTY_REVIEWS: CadReviewReport[] = [];
const EMPTY_TURN_DIFF_SUMMARIES: TurnDiffSummary[] = [];
const EMPTY_MESSAGE_MAP: Record<MessageId, ChatMessage> = {};
const EMPTY_ACTIVITY_MAP: Record<string, Thread["activities"][number]> = {};
const EMPTY_PROPOSED_PLAN_MAP: Record<string, ProposedPlan> = {};
const EMPTY_REVIEW_MAP: Record<CadReviewId, CadReviewReport> = {};
const EMPTY_TURN_DIFF_MAP: Record<TurnId, TurnDiffSummary> = {};

const collectedByIdsCache = new WeakMap<readonly string[], WeakMap<object, readonly unknown[]>>();
const threadCache = new WeakMap<
  ThreadShell,
  {
    session: ThreadSession | null;
    turnState: ThreadTurnState | undefined;
    messages: Thread["messages"];
    activities: Thread["activities"];
    proposedPlans: Thread["proposedPlans"];
    reviews: CadReviewReport[];
    turnDiffSummaries: Thread["turnDiffSummaries"];
    thread: Thread;
  }
>();

function collectByIds<TKey extends string, TValue>(
  ids: readonly TKey[] | undefined,
  byId: Record<TKey, TValue> | undefined,
  emptyValue: TValue[],
): TValue[] {
  if (!ids || ids.length === 0 || !byId) {
    return emptyValue;
  }

  const cachedByRecord = collectedByIdsCache.get(ids);
  const cached = cachedByRecord?.get(byId);
  if (cached) {
    return cached as TValue[];
  }

  const nextValues = ids.flatMap((id) => {
    const value = byId[id];
    return value ? [value] : [];
  });
  const nextCachedByRecord = cachedByRecord ?? new WeakMap<object, readonly unknown[]>();
  nextCachedByRecord.set(byId, nextValues);
  if (!cachedByRecord) {
    collectedByIdsCache.set(ids, nextCachedByRecord);
  }
  return nextValues;
}

function selectThreadMessages(state: EnvironmentState, threadId: ThreadId): Thread["messages"] {
  return collectByIds(
    state.messageIdsByThreadId[threadId],
    state.messageByThreadId[threadId] ?? EMPTY_MESSAGE_MAP,
    EMPTY_MESSAGES,
  );
}

function selectThreadActivities(state: EnvironmentState, threadId: ThreadId): Thread["activities"] {
  return collectByIds(
    state.activityIdsByThreadId[threadId],
    state.activityByThreadId[threadId] ?? EMPTY_ACTIVITY_MAP,
    EMPTY_ACTIVITIES,
  );
}

function selectThreadProposedPlans(
  state: EnvironmentState,
  threadId: ThreadId,
): Thread["proposedPlans"] {
  return collectByIds(
    state.proposedPlanIdsByThreadId[threadId],
    state.proposedPlanByThreadId[threadId] ?? EMPTY_PROPOSED_PLAN_MAP,
    EMPTY_PROPOSED_PLANS,
  );
}

function selectThreadReviews(state: EnvironmentState, threadId: ThreadId): CadReviewReport[] {
  return collectByIds(
    state.reviewIdsByThreadId?.[threadId],
    state.reviewByThreadId?.[threadId] ?? EMPTY_REVIEW_MAP,
    EMPTY_REVIEWS,
  );
}

function selectThreadTurnDiffSummaries(
  state: EnvironmentState,
  threadId: ThreadId,
): Thread["turnDiffSummaries"] {
  return collectByIds(
    state.turnDiffIdsByThreadId[threadId],
    state.turnDiffSummaryByThreadId[threadId] ?? EMPTY_TURN_DIFF_MAP,
    EMPTY_TURN_DIFF_SUMMARIES,
  );
}

export function getThreadFromEnvironmentState(
  state: EnvironmentState,
  threadId: ThreadId,
): Thread | undefined {
  const shell = state.threadShellById[threadId];
  if (!shell) {
    return undefined;
  }

  const session = state.threadSessionById[threadId] ?? null;
  const turnState = state.threadTurnStateById[threadId];
  const messages = selectThreadMessages(state, threadId);
  const activities = selectThreadActivities(state, threadId);
  const proposedPlans = selectThreadProposedPlans(state, threadId);
  const reviews = selectThreadReviews(state, threadId);
  const turnDiffSummaries = selectThreadTurnDiffSummaries(state, threadId);
  const cached = threadCache.get(shell);

  if (
    cached &&
    cached.session === session &&
    cached.turnState === turnState &&
    cached.messages === messages &&
    cached.activities === activities &&
    cached.proposedPlans === proposedPlans &&
    cached.reviews === reviews &&
    cached.turnDiffSummaries === turnDiffSummaries
  ) {
    return cached.thread;
  }

  const thread: Thread = {
    ...shell,
    session,
    latestTurn: turnState?.latestTurn ?? null,
    pendingTurnStartedAt: turnState?.pendingTurnStartedAt,
    pendingSourceProposedPlan: turnState?.pendingSourceProposedPlan,
    messages,
    activities,
    proposedPlans,
    reviews,
    turnDiffSummaries,
  };

  threadCache.set(shell, {
    session,
    turnState,
    messages,
    activities,
    proposedPlans,
    reviews,
    turnDiffSummaries,
    thread,
  });

  return thread;
}
