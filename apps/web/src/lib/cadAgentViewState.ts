import type {
  CadView,
  CadViewCommand,
  CadReviewStatus,
  CadReviewPersona,
  CadReviewReport,
  OrchestrationThreadActivity,
  ThreadId,
} from "@cadsense/contracts";

import type { EnvironmentState } from "../store";
import { getThreadFromEnvironmentState } from "../threadDerivation";
import type { ChatMessage, Thread } from "../types";
import type { CadAgentViewCommand, CadAgentViewState } from "../uiStateStore";

const CAD_REVIEW_CHILD_CREATED_KIND = "cad-review.child-thread.created";
const CAD_REVIEW_ACTIVE_STATUSES: ReadonlySet<CadReviewStatus> = new Set<CadReviewStatus>([
  "requested",
  "planning",
  "capturing-baseline",
  "reviewing",
  "deep-diving",
  "synthesizing",
  "failed",
]);

type CadReviewOutputTokenStep = keyof NonNullable<CadReviewReport["outputTokensByStep"]>;

type CadReviewChildPhase = "planning" | "reviewing" | "deep-dive" | "synthesis";

export interface CadReviewChildActivitySummary {
  readonly reviewRunId: string;
  readonly reviewer: string | null;
  readonly childThreadId: ThreadId;
  readonly latestActivityId: string;
  readonly latestActivityKind: string;
  readonly latestActivityLabel: string;
  readonly latestToolName: string | null;
  readonly latestToolTitle: string | null;
  readonly latestScreenshotAt: string | null;
  readonly latestRenderAt: string | null;
  readonly outputTokens: number | null;
  readonly outputTokensByStep: Readonly<Partial<Record<CadReviewOutputTokenStep, number>>>;
  readonly updatedAt: string;
}

function payloadRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function cadView(value: unknown): CadView | undefined {
  return typeof value === "string" && value.length > 0 ? (value as CadView) : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalNumberTuple(value: unknown): [number, number, number] | undefined {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  ) {
    return undefined;
  }
  return value as [number, number, number];
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function outputTokensFromActivity(activity: OrchestrationThreadActivity): number | null {
  if (activity.kind !== "context-window.updated") {
    return null;
  }
  const payload = payloadRecord(activity.payload);
  return finiteNumber(payload?.lastOutputTokens) ?? finiteNumber(payload?.outputTokens);
}

function estimateOutputTokensFromText(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

function latestAssistantMessage(messages: ReadonlyArray<ChatMessage>): ChatMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && message.text.trim().length > 0) {
      return message;
    }
  }
  return null;
}

function activeReviewId(thread: Thread): string | null {
  return (
    thread.reviews
      ?.filter((review) => CAD_REVIEW_ACTIVE_STATUSES.has(review.status))
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.id ?? null
  );
}

function childThreadIdsForReview(thread: Thread, reviewRunId: string): Set<ThreadId> {
  return new Set(childThreadMetadataForReview(thread, reviewRunId).keys());
}

export function cadReviewChildThreadIdsForActiveReviews(thread: Thread): ThreadId[] {
  const childThreadIds = new Set<ThreadId>();
  for (const review of thread.reviews ?? []) {
    if (!CAD_REVIEW_ACTIVE_STATUSES.has(review.status)) {
      continue;
    }
    for (const childThreadId of childThreadIdsForReview(thread, review.id)) {
      childThreadIds.add(childThreadId);
    }
  }
  return [...childThreadIds];
}

export function cadReviewChildThreadIdsForActiveReviewsInEnvironment(
  environmentState: EnvironmentState,
  thread: Thread,
): ThreadId[] {
  const activeReviewIds = new Set(
    (thread.reviews ?? [])
      .filter((review) => CAD_REVIEW_ACTIVE_STATUSES.has(review.status))
      .map((review) => review.id),
  );
  const childThreadIds = new Set(cadReviewChildThreadIdsForActiveReviews(thread));
  for (const threadId of environmentState.threadIds) {
    const child = environmentState.threadShellById[threadId];
    if (
      child?.purpose === "cad-review" &&
      child.parentThreadId === thread.id &&
      child.reviewRunId != null &&
      activeReviewIds.has(child.reviewRunId)
    ) {
      childThreadIds.add(threadId);
    }
  }
  return [...childThreadIds];
}

function childThreadMetadataForReview(
  thread: Thread,
  reviewRunId: string,
): Map<ThreadId, { reviewer: string | null; phase: CadReviewChildPhase | null }> {
  const childThreadIds = new Map<
    ThreadId,
    { reviewer: string | null; phase: CadReviewChildPhase | null }
  >();
  for (const activity of thread.activities) {
    if (activity.kind !== CAD_REVIEW_CHILD_CREATED_KIND) {
      continue;
    }
    const payload = payloadRecord(activity.payload);
    if (payload?.reviewRunId !== reviewRunId || typeof payload.childThreadId !== "string") {
      continue;
    }
    childThreadIds.set(payload.childThreadId as ThreadId, {
      reviewer: typeof payload.persona === "string" ? payload.persona : null,
      phase: cadReviewChildPhase(payload.phase),
    });
  }
  return childThreadIds;
}

function cadReviewChildPhase(value: unknown): CadReviewChildPhase | null {
  return value === "planning" ||
    value === "reviewing" ||
    value === "deep-dive" ||
    value === "synthesis"
    ? value
    : null;
}

function isCadReviewSpecialistPersona(
  value: string | null,
): value is Exclude<CadReviewPersona, "synthesis"> {
  return (
    value === "systems_integration" ||
    value === "program_readiness" ||
    value === "mechanical_robustness"
  );
}

function outputTokenStepForChild(input: {
  readonly reviewer: string | null;
  readonly phase: CadReviewChildPhase | null;
  readonly reviewStatus: CadReviewStatus;
}): CadReviewOutputTokenStep | null {
  switch (input.phase) {
    case "planning":
      return "planning";
    case "deep-dive":
      return "deep_diving";
    case "synthesis":
      return "synthesizing";
    case "reviewing":
      return isCadReviewSpecialistPersona(input.reviewer) ? input.reviewer : null;
    case null:
      break;
  }
  if (input.reviewer === "synthesis") {
    if (input.reviewStatus === "planning") {
      return "planning";
    }
    if (input.reviewStatus === "deep-diving") {
      return "deep_diving";
    }
    if (input.reviewStatus === "synthesizing") {
      return "synthesizing";
    }
    return null;
  }
  return isCadReviewSpecialistPersona(input.reviewer) ? input.reviewer : null;
}

function toolNameFromActivity(activity: OrchestrationThreadActivity): string | undefined {
  const payload = payloadRecord(activity.payload);
  return typeof payload?.detail === "string" ? payload.detail : undefined;
}

function toolTitleFromActivity(activity: OrchestrationThreadActivity): string | undefined {
  const payload = payloadRecord(activity.payload);
  return typeof payload?.title === "string" ? payload.title : undefined;
}

function toolArgumentsFromActivity(
  activity: OrchestrationThreadActivity,
): Record<string, unknown> | undefined {
  const payload = payloadRecord(activity.payload);
  const data = payloadRecord(payload?.data);
  const item = payloadRecord(data?.item);
  return payloadRecord(item?.arguments);
}

function viewCommandFromToolActivity(
  activity: OrchestrationThreadActivity,
): CadAgentViewCommand | undefined {
  const toolName = toolNameFromActivity(activity);
  const args = toolArgumentsFromActivity(activity);
  if (!toolName || !args) {
    return undefined;
  }
  if (toolName === "set_cad_view") {
    const view = cadView(args.view);
    if (!view) {
      return undefined;
    }
    return {
      commandId: `activity:${activity.id}`,
      type: "set-view",
      threadId: "" as ThreadId,
      view,
      fit: optionalBoolean(args.fit) ?? true,
      createdAt: activity.createdAt,
    };
  }
  if (toolName === "set_cad_camera") {
    const direction = optionalNumberTuple(args.direction);
    if (!direction) {
      return undefined;
    }
    const up = optionalNumberTuple(args.up);
    return {
      commandId: `activity:${activity.id}`,
      type: "set-camera",
      threadId: "" as ThreadId,
      direction,
      ...(up ? { up } : {}),
      fit: optionalBoolean(args.fit) ?? true,
      closeUp: optionalBoolean(args.closeUp) ?? false,
      createdAt: activity.createdAt,
    };
  }
  return undefined;
}

function explodedFromToolActivity(activity: OrchestrationThreadActivity): boolean | undefined {
  if (toolNameFromActivity(activity) !== "set_cad_exploded") {
    return undefined;
  }
  const args = toolArgumentsFromActivity(activity);
  if (!args) {
    return undefined;
  }
  return optionalBoolean(args.exploded) ?? optionalBoolean(args.enabled);
}

function newerState(
  current: CadAgentViewState | null,
  next: Partial<CadAgentViewState> & { readonly updatedAt: string },
): CadAgentViewState {
  if (!current) {
    return next as CadAgentViewState;
  }
  return {
    ...current,
    ...next,
    updatedAt: next.updatedAt,
  };
}

export function deriveCadAgentViewStateForThread(
  environmentState: EnvironmentState,
  thread: Thread,
): CadAgentViewState | null {
  const reviewRunId = activeReviewId(thread);
  if (!reviewRunId) {
    return null;
  }

  const childThreadIds = new Set(
    cadReviewChildThreadIdsForActiveReviewsInEnvironment(environmentState, thread),
  );
  const childPrefix = `${thread.id}:cad-review:${reviewRunId}:`;
  let derivedState: CadAgentViewState | null = null;

  for (const threadId of environmentState.threadIds) {
    if (!childThreadIds.has(threadId) && !threadId.startsWith(childPrefix)) {
      continue;
    }
    const childThread = getThreadFromEnvironmentState(environmentState, threadId);
    for (const activity of childThread?.activities ?? []) {
      const viewCommand = viewCommandFromToolActivity(activity);
      if (viewCommand) {
        derivedState = newerState(derivedState, {
          viewCommand: { ...viewCommand, threadId: thread.id },
          updatedAt: activity.createdAt,
        });
      }
      const exploded = explodedFromToolActivity(activity);
      if (exploded !== undefined) {
        derivedState = newerState(derivedState, {
          exploded,
          updatedAt: activity.createdAt,
        });
      }
    }
  }

  return derivedState;
}

export function deriveCadReviewChildActivitySummaries(
  environmentState: EnvironmentState,
  thread: Thread,
): Record<string, CadReviewChildActivitySummary> {
  const summaries: Record<string, CadReviewChildActivitySummary> = {};
  const activeReviews =
    thread.reviews?.filter((review) => CAD_REVIEW_ACTIVE_STATUSES.has(review.status)) ?? [];

  for (const review of activeReviews) {
    const childThreadMetadata = childThreadMetadataForReview(thread, review.id);
    const childPrefix = `${thread.id}:cad-review:${review.id}:`;
    let latest: CadReviewChildActivitySummary | null = null;
    const outputTokensByStep: Partial<Record<CadReviewOutputTokenStep, number>> = {};
    const recordOutputTokens = (
      step: CadReviewOutputTokenStep | null,
      outputTokens: number | null,
    ) => {
      if (step === null || outputTokens === null || outputTokens <= 0) {
        return;
      }
      outputTokensByStep[step] = Math.max(outputTokensByStep[step] ?? 0, outputTokens);
    };

    for (const threadId of environmentState.threadIds) {
      if (!childThreadMetadata.has(threadId) && !threadId.startsWith(childPrefix)) {
        continue;
      }
      const childThread = getThreadFromEnvironmentState(environmentState, threadId);
      const metadata = childThreadMetadata.get(threadId);
      const reviewer = metadata?.reviewer ?? reviewerFromChildThreadId(threadId);
      const outputTokenStep = outputTokenStepForChild({
        reviewer,
        phase: metadata?.phase ?? null,
        reviewStatus: review.status,
      });
      const assistantMessage = latestAssistantMessage(childThread?.messages ?? []);
      const assistantOutputTokens = assistantMessage
        ? estimateOutputTokensFromText(assistantMessage.text)
        : null;
      let latestScreenshotAtForThread: string | null = latest?.latestScreenshotAt ?? null;
      let latestRenderAtForThread: string | null = latest?.latestRenderAt ?? null;
      for (const activity of childThread?.activities ?? []) {
        if (activity.kind === CAD_REVIEW_CHILD_CREATED_KIND) {
          continue;
        }
        const activityOutputTokens = outputTokensFromActivity(activity);
        recordOutputTokens(outputTokenStep, activityOutputTokens);
        const toolName = toolNameFromActivity(activity) ?? null;
        const toolTitle = toolTitleFromActivity(activity) ?? null;
        if (activityLooksLike(activity, ["screenshot", "capture"])) {
          latestScreenshotAtForThread =
            latestScreenshotAtForThread === null || activity.createdAt > latestScreenshotAtForThread
              ? activity.createdAt
              : latestScreenshotAtForThread;
        }
        if (activityLooksLike(activity, ["render", "view"])) {
          latestRenderAtForThread =
            latestRenderAtForThread === null || activity.createdAt > latestRenderAtForThread
              ? activity.createdAt
              : latestRenderAtForThread;
        }
        const next: CadReviewChildActivitySummary = {
          reviewRunId: review.id,
          reviewer,
          childThreadId: threadId,
          latestActivityId: activity.id,
          latestActivityKind: activity.kind,
          latestActivityLabel: activity.summary,
          latestToolName: toolName,
          latestToolTitle: toolTitle,
          latestScreenshotAt: latestScreenshotAtForThread,
          latestRenderAt: latestRenderAtForThread,
          outputTokens:
            activityOutputTokens ?? latest?.outputTokens ?? assistantOutputTokens ?? null,
          outputTokensByStep: { ...outputTokensByStep },
          updatedAt: activity.createdAt,
        };
        if (!latest || next.updatedAt > latest.updatedAt) {
          latest = next;
        }
      }

      if (assistantMessage && assistantOutputTokens !== null) {
        recordOutputTokens(outputTokenStep, assistantOutputTokens);
        const messageUpdatedAt =
          assistantMessage.updatedAt ?? assistantMessage.completedAt ?? assistantMessage.createdAt;
        const next: CadReviewChildActivitySummary = {
          reviewRunId: review.id,
          reviewer,
          childThreadId: threadId,
          latestActivityId: assistantMessage.id,
          latestActivityKind: "assistant.message",
          latestActivityLabel: "Assistant output",
          latestToolName: null,
          latestToolTitle: null,
          latestScreenshotAt: latestScreenshotAtForThread,
          latestRenderAt: latestRenderAtForThread,
          outputTokens: Math.max(latest?.outputTokens ?? 0, assistantOutputTokens),
          outputTokensByStep: { ...outputTokensByStep },
          updatedAt: messageUpdatedAt,
        };
        if (!latest || next.updatedAt >= latest.updatedAt) {
          latest = next;
        } else if (latest.outputTokens === null || assistantOutputTokens > latest.outputTokens) {
          latest = { ...latest, outputTokens: assistantOutputTokens };
        }
      }
    }

    if (latest) {
      summaries[review.id] = { ...latest, outputTokensByStep };
    }
  }

  return summaries;
}

export function latestCadAgentViewState(
  left: CadAgentViewState | null,
  right: CadAgentViewState | null,
): CadAgentViewState | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return right.updatedAt > left.updatedAt ? right : left;
}

export function isAgentCadViewCommand(command: CadViewCommand): command is CadAgentViewCommand {
  return command.type === "set-view" || command.type === "set-camera";
}

export function isCadRelatedToolActivity(activity: OrchestrationThreadActivity): boolean {
  if (
    activity.kind !== "tool.started" &&
    activity.kind !== "tool.updated" &&
    activity.kind !== "tool.completed"
  ) {
    return false;
  }

  const toolName = toolNameFromActivity(activity)?.toLocaleLowerCase();
  if (toolName?.includes("cad") === true) {
    return true;
  }

  const title = toolTitleFromActivity(activity)?.toLocaleLowerCase();
  return title?.includes("cad") === true;
}

function reviewerFromChildThreadId(threadId: ThreadId): string | null {
  const parts = threadId.split(":cad-review:");
  const reviewSuffix = parts[1];
  if (!reviewSuffix) {
    return null;
  }
  const [, reviewer] = reviewSuffix.split(":");
  return reviewer || null;
}

function activityLooksLike(
  activity: OrchestrationThreadActivity,
  needles: ReadonlyArray<string>,
): boolean {
  const haystack = `${activity.kind} ${activity.summary} ${toolNameFromActivity(activity) ?? ""} ${
    toolTitleFromActivity(activity) ?? ""
  }`.toLowerCase();
  return needles.some((needle) => haystack.includes(needle));
}
