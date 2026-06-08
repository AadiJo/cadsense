import {
  EnvironmentId,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationThreadActivity,
} from "@cadsense/contracts";
import { describe, expect, it } from "vitest";

import type { EnvironmentState } from "../store";
import type { Thread, ThreadShell } from "../types";
import {
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

function makeEnvironmentState(childActivities: OrchestrationThreadActivity[]): EnvironmentState {
  return {
    projectIds: [],
    projectById: {},
    threadIds: [childThreadId],
    threadIdsByProjectId: {},
    threadShellById: {
      [childThreadId]: {
        id: childThreadId,
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
    },
    threadSessionById: {},
    threadTurnStateById: {},
    messageIdsByThreadId: {},
    messageByThreadId: {},
    activityIdsByThreadId: {
      [childThreadId]: childActivities.map((entry) => entry.id),
    },
    activityByThreadId: {
      [childThreadId]: Object.fromEntries(childActivities.map((entry) => [entry.id, entry])),
    },
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
