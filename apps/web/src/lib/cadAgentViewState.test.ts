import {
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationThreadActivity,
} from "@cadsense/contracts";
import { describe, expect, it } from "vitest";

import type { EnvironmentState } from "../store";
import type { Thread, ThreadShell } from "../types";
import {
  cadReviewChildThreadIdsForActiveReviews,
  deriveCadReviewChildActivitySummaries,
  deriveCadAgentViewStateForThread,
  isCadRelatedToolActivity,
  latestCadAgentViewState,
} from "./cadAgentViewState";

const parentThreadId = ThreadId.make("parent-thread");
const environmentId = EnvironmentId.make("env");
const projectId = ProjectId.make("project");
const reviewRunId = "cad-review-1";
const childThreadId = ThreadId.make(`${parentThreadId}:cad-review:${reviewRunId}:synthesis:child`);

function activity(
  id: string,
  createdAt: string,
  detail: string,
  args: Record<string, unknown>,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "tool",
    kind: "tool.completed",
    summary: "Used Cad View",
    payload: {
      itemType: "mcp_tool_call",
      detail,
      data: {
        item: {
          arguments: args,
          status: "completed",
        },
      },
    },
    turnId: null,
    createdAt,
  };
}

function makeEnvironmentState(
  childActivities: OrchestrationThreadActivity[],
  childMessages: Thread["messages"] = [],
): EnvironmentState {
  return makeEnvironmentStateForChildThreads([
    { id: childThreadId, activities: childActivities, messages: childMessages },
  ]);
}

function makeEnvironmentStateForChildThreads(
  children: ReadonlyArray<{
    readonly id: ThreadId;
    readonly activities: OrchestrationThreadActivity[];
    readonly messages?: Thread["messages"];
  }>,
): EnvironmentState {
  return {
    projectIds: [],
    projectById: {},
    threadIds: children.map((child) => child.id),
    threadIdsByProjectId: {},
    threadShellById: Object.fromEntries(
      children.map((child) => [
        child.id,
        {
          id: child.id,
          environmentId,
          codexThreadId: null,
          projectId,
          title: "child",
          modelSelection: { instanceId: "codex", model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          error: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          archivedAt: null,
          branch: null,
          worktreePath: null,
        } as ThreadShell,
      ]),
    ),
    threadSessionById: {},
    threadTurnStateById: {},
    messageIdsByThreadId: Object.fromEntries(
      children.map((child) => [child.id, (child.messages ?? []).map((message) => message.id)]),
    ),
    messageByThreadId: Object.fromEntries(
      children.map((child) => [
        child.id,
        Object.fromEntries((child.messages ?? []).map((message) => [message.id, message])),
      ]),
    ),
    activityIdsByThreadId: Object.fromEntries(
      children.map((child) => [child.id, child.activities.map((entry) => entry.id)]),
    ),
    activityByThreadId: Object.fromEntries(
      children.map((child) => [
        child.id,
        Object.fromEntries(child.activities.map((entry) => [entry.id, entry])),
      ]),
    ),
    proposedPlanIdsByThreadId: {},
    proposedPlanByThreadId: {},
    reviewIdsByThreadId: {},
    reviewByThreadId: {},
    turnDiffIdsByThreadId: {},
    turnDiffSummaryByThreadId: {},
    sidebarThreadSummaryById: {},
    bootstrapComplete: true,
  } as EnvironmentState;
}

function childCreatedActivity(
  id: string,
  childId: ThreadId,
  persona: string,
  phase?: string,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind: "cad-review.child-thread.created",
    summary: `${persona} reviewer thread created`,
    payload: {
      reviewRunId,
      persona,
      ...(phase ? { phase } : {}),
      childThreadId: childId,
    },
    turnId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function usageActivity(
  id: string,
  createdAt: string,
  outputTokens: number,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind: "context-window.updated",
    summary: "Context window updated",
    payload: {
      lastOutputTokens: outputTokens,
      outputTokens,
      usedTokens: outputTokens + 100,
    },
    turnId: null,
    createdAt,
  };
}

function makeParentThread(): Thread {
  return {
    id: parentThreadId,
    environmentId,
    codexThreadId: null,
    projectId,
    title: "parent",
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    reviews: [
      {
        id: reviewRunId,
        threadId: parentThreadId,
        title: "CAD Review",
        status: "reviewing",
        whatIsBeingReviewed: "assembly",
        commonThemes: [],
        positiveSignals: [],
        reviewerTraits: {},
        personaReports: [],
        deepDiveReports: [],
        mergedActionItems: [],
        evidenceArtifacts: [],
        toolCallsByReviewer: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    activities: [
      {
        id: EventId.make("child-created"),
        tone: "info",
        kind: "cad-review.child-thread.created",
        summary: "Synthesis reviewer thread created",
        payload: {
          reviewRunId,
          persona: "synthesis",
          childThreadId,
        },
        turnId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
  } as unknown as Thread;
}

describe("cadAgentViewState", () => {
  it("derives the latest agent CAD view and explode state from child tool activities", () => {
    const derived = deriveCadAgentViewStateForThread(
      makeEnvironmentState([
        activity("view-front", "2026-01-01T00:00:01.000Z", "set_cad_view", {
          view: "front",
          fit: true,
        }),
        activity("explode-on", "2026-01-01T00:00:02.000Z", "set_cad_exploded", {
          exploded: true,
        }),
        activity("view-right", "2026-01-01T00:00:03.000Z", "set_cad_view", {
          view: "right",
          fit: true,
        }),
      ]),
      makeParentThread(),
    );

    expect(derived?.viewCommand).toMatchObject({ type: "set-view", view: "right", fit: true });
    expect(derived?.exploded).toBe(true);
    expect(derived?.updatedAt).toBe("2026-01-01T00:00:03.000Z");
  });

  it("uses the newest state between derived activity state and live UI state", () => {
    const older = {
      viewCommand: {
        commandId: "older",
        type: "set-view" as const,
        threadId: parentThreadId,
        view: "front" as const,
        fit: true,
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      updatedAt: "2026-01-01T00:00:01.000Z",
    };
    const newer = {
      exploded: true,
      updatedAt: "2026-01-01T00:00:02.000Z",
    };

    expect(latestCadAgentViewState(older, newer)).toBe(newer);
  });

  it("does not promote screenshot captures into the live CAD view state", () => {
    const derived = deriveCadAgentViewStateForThread(
      makeEnvironmentState([
        activity("view-front", "2026-01-01T00:00:01.000Z", "set_cad_view", {
          view: "front",
          fit: true,
        }),
        activity("screenshot-right", "2026-01-01T00:00:02.000Z", "export_cad_screenshot", {
          view: "right",
          fit: true,
        }),
      ]),
      makeParentThread(),
    );

    expect(derived?.viewCommand).toMatchObject({ type: "set-view", view: "front", fit: true });
    expect(derived?.updatedAt).toBe("2026-01-01T00:00:01.000Z");
  });

  it("summarizes the latest child reviewer activity for an active review", () => {
    const summaries = deriveCadReviewChildActivitySummaries(
      makeEnvironmentState([
        activity("view-front", "2026-01-01T00:00:01.000Z", "set_cad_view", {
          view: "front",
        }),
        activity("screenshot", "2026-01-01T00:00:02.000Z", "export_cad_screenshot", {
          view: "front",
        }),
        activity("read-file", "2026-01-01T00:00:03.000Z", "read_file", {
          path: "notes.md",
        }),
      ]),
      makeParentThread(),
    );

    expect(summaries[reviewRunId]).toMatchObject({
      reviewer: "synthesis",
      childThreadId,
      latestActivityId: "read-file",
      latestToolName: "read_file",
      latestScreenshotAt: "2026-01-01T00:00:02.000Z",
      updatedAt: "2026-01-01T00:00:03.000Z",
    });
  });

  it("estimates live output tokens from streaming assistant messages", () => {
    const summaries = deriveCadReviewChildActivitySummaries(
      makeEnvironmentState(
        [],
        [
          {
            id: MessageId.make("assistant-streaming"),
            role: "assistant",
            text: "Planning review priorities from the CAD context.",
            turnId: null,
            createdAt: "2026-01-01T00:00:04.000Z",
            updatedAt: "2026-01-01T00:00:05.000Z",
            streaming: true,
          },
        ],
      ),
      makeParentThread(),
    );

    expect(summaries[reviewRunId]).toMatchObject({
      latestActivityId: "assistant-streaming",
      latestActivityKind: "assistant.message",
      outputTokens: 12,
      updatedAt: "2026-01-01T00:00:05.000Z",
    });
  });

  it("keeps screenshot progress visible when later assistant output streams", () => {
    const summaries = deriveCadReviewChildActivitySummaries(
      makeEnvironmentState(
        [
          activity("screenshot", "2026-01-01T00:00:02.000Z", "export_cad_screenshot", {
            view: "front",
          }),
        ],
        [
          {
            id: MessageId.make("assistant-after-screenshot"),
            role: "assistant",
            text: "Continuing the review after taking the capture.",
            turnId: null,
            createdAt: "2026-01-01T00:00:03.000Z",
            updatedAt: "2026-01-01T00:00:04.000Z",
            streaming: true,
          },
        ],
      ),
      makeParentThread(),
    );

    expect(summaries[reviewRunId]).toMatchObject({
      latestActivityId: "assistant-after-screenshot",
      latestActivityKind: "assistant.message",
      latestScreenshotAt: "2026-01-01T00:00:02.000Z",
      updatedAt: "2026-01-01T00:00:04.000Z",
    });
  });

  it("collects active CAD review child thread ids for detail subscriptions", () => {
    expect(cadReviewChildThreadIdsForActiveReviews(makeParentThread())).toEqual([childThreadId]);
    expect(
      cadReviewChildThreadIdsForActiveReviews({
        ...makeParentThread(),
        reviews: [
          {
            ...makeParentThread().reviews![0]!,
            status: "completed",
          },
        ],
      }),
    ).toEqual([]);
  });

  it("prefers usage output tokens over assistant text estimates", () => {
    const summaries = deriveCadReviewChildActivitySummaries(
      makeEnvironmentState(
        [
          {
            id: EventId.make("usage"),
            tone: "info",
            kind: "context-window.updated",
            summary: "Context window updated",
            payload: {
              lastOutputTokens: 32,
              outputTokens: 32,
              usedTokens: 100,
            },
            turnId: null,
            createdAt: "2026-01-01T00:00:03.000Z",
          },
        ],
        [
          {
            id: MessageId.make("assistant-streaming-short"),
            role: "assistant",
            text: "Short.",
            turnId: null,
            createdAt: "2026-01-01T00:00:02.000Z",
            streaming: true,
          },
        ],
      ),
      makeParentThread(),
    );

    expect(summaries[reviewRunId]?.outputTokens).toBe(32);
  });

  it("keeps live output tokens bucketed by CAD review step across child phases", () => {
    const planningChildId = ThreadId.make(
      `${parentThreadId}:cad-review:${reviewRunId}:synthesis:planning-child`,
    );
    const systemsChildId = ThreadId.make(
      `${parentThreadId}:cad-review:${reviewRunId}:systems_integration:systems-child`,
    );
    const synthesisChildId = ThreadId.make(
      `${parentThreadId}:cad-review:${reviewRunId}:synthesis:synthesis-child`,
    );
    const parent = {
      ...makeParentThread(),
      activities: [
        childCreatedActivity("planning-child-created", planningChildId, "synthesis", "planning"),
        childCreatedActivity(
          "systems-child-created",
          systemsChildId,
          "systems_integration",
          "reviewing",
        ),
        childCreatedActivity("synthesis-child-created", synthesisChildId, "synthesis", "synthesis"),
      ],
    } as Thread;

    const summaries = deriveCadReviewChildActivitySummaries(
      makeEnvironmentStateForChildThreads([
        {
          id: planningChildId,
          activities: [usageActivity("planning-usage", "2026-01-01T00:00:01.000Z", 12_000)],
        },
        {
          id: systemsChildId,
          activities: [usageActivity("systems-usage", "2026-01-01T00:00:02.000Z", 800)],
        },
        {
          id: synthesisChildId,
          activities: [usageActivity("synthesis-usage", "2026-01-01T00:00:03.000Z", 54)],
        },
      ]),
      parent,
    );

    expect(summaries[reviewRunId]?.outputTokensByStep).toEqual({
      planning: 12_000,
      systems_integration: 800,
      synthesizing: 54,
    });
  });

  it("detects CAD-related tool lifecycle activity without matching non-tool text", () => {
    expect(
      isCadRelatedToolActivity(
        activity("cad-tool", "2026-01-01T00:00:01.000Z", "export_cad_screenshot", {}),
      ),
    ).toBe(true);
    expect(
      isCadRelatedToolActivity({
        ...activity("non-cad-tool", "2026-01-01T00:00:02.000Z", "read_file", {}),
        payload: {
          title: "Read CAD notes",
        },
      }),
    ).toBe(true);
    expect(
      isCadRelatedToolActivity({
        ...activity("cad-info", "2026-01-01T00:00:03.000Z", "export_cad_screenshot", {}),
        kind: "turn.completed",
      }),
    ).toBe(false);
  });
});
