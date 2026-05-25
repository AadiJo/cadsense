import type {
  CadView,
  CadViewCommand,
  CadReviewStatus,
  OrchestrationThreadActivity,
  ThreadId,
} from "@cadsense/contracts";

import type { EnvironmentState } from "../store";
import { getThreadFromEnvironmentState } from "../threadDerivation";
import type { Thread } from "../types";
import type { CadAgentViewCommand, CadAgentViewState } from "../uiStateStore";

const CAD_REVIEW_CHILD_CREATED_KIND = "cad-review.child-thread.created";
const CAD_REVIEW_ACTIVE_STATUSES: ReadonlySet<CadReviewStatus> = new Set<CadReviewStatus>([
  "requested",
  "planning",
  "capturing-baseline",
  "reviewing",
  "deep-diving",
  "synthesizing",
]);

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

function activeReviewId(thread: Thread): string | null {
  return (
    thread.reviews
      ?.filter((review) => CAD_REVIEW_ACTIVE_STATUSES.has(review.status))
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.id ?? null
  );
}

function childThreadIdsForReview(thread: Thread, reviewRunId: string): Set<ThreadId> {
  const childThreadIds = new Set<ThreadId>();
  for (const activity of thread.activities) {
    if (activity.kind !== CAD_REVIEW_CHILD_CREATED_KIND) {
      continue;
    }
    const payload = payloadRecord(activity.payload);
    if (payload?.reviewRunId !== reviewRunId || typeof payload.childThreadId !== "string") {
      continue;
    }
    childThreadIds.add(payload.childThreadId as ThreadId);
  }
  return childThreadIds;
}

function toolNameFromActivity(activity: OrchestrationThreadActivity): string | undefined {
  const payload = payloadRecord(activity.payload);
  return typeof payload?.detail === "string" ? payload.detail : undefined;
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
  if (toolName === "set_cad_view" || toolName === "export_cad_screenshot") {
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

  const childThreadIds = childThreadIdsForReview(thread, reviewRunId);
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
