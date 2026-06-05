import {
  CommandId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
} from "@cadsense/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

import { CadViewScheduler } from "../../cad/CadViewScheduler.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { CadReviewService } from "../Services/CadReviewService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import {
  buildMechanismPlan,
  blockingProviderRetryWarning,
  cadReviewChildPromptMessageId,
  childThreadHasAfterAgentHookFailure,
  childThreadHasCompletedAssistantMessage,
  CadReviewServiceLive,
  deepDiveOutputIsReady,
  extractJsonObject,
  firstPendingInteractiveChildPrompt,
  isUnsupportedCodexCadScreenshotExportRootError,
  mechanismPlanOutputIsReady,
  outputTokensFromChildThread,
  personaReviewOutputIsReady,
  reviewerConcurrencyForThread,
  synthesisOutputIsReady,
  userVisibleErrorMessage,
} from "./CadReviewService.ts";
import { buildMechanismPlanningPrompt } from "./CadReviewPrompts.ts";

const parentThreadId = ThreadId.make("parent-thread");
const reviewRunId = "cad-review-1";
const childThreadId = ThreadId.make(`${parentThreadId}:cad-review:${reviewRunId}:synthesis:child`);
const now = "2026-01-01T00:00:00.000Z";
const staleUpdatedAt = "2000-01-01T00:00:00.000Z";
const freshUpdatedAt = "2999-01-01T00:00:00.000Z";

const emptyReadModel = {
  projects: [],
  threads: [],
  updatedAt: now,
  snapshotSequence: 0,
} as unknown as OrchestrationReadModel;
const emptyShellSnapshot = {
  projects: [],
  threads: [],
  updatedAt: now,
  snapshotSequence: 0,
} as unknown as OrchestrationShellSnapshot;

function makeParentThread(): OrchestrationThread {
  return {
    id: parentThreadId,
    title: "Parent",
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
        createdAt: now,
        updatedAt: now,
      },
    ],
    activities: [
      {
        id: "child-created",
        tone: "info",
        kind: "cad-review.child-thread.created",
        summary: "Synthesis reviewer thread created",
        payload: {
          reviewRunId,
          persona: "synthesis",
          childThreadId,
        },
        turnId: null,
        createdAt: now,
      },
    ],
  } as unknown as OrchestrationThread;
}

function makeFreshParentThreadWithoutChildren(): OrchestrationThread {
  return {
    ...makeParentThread(),
    reviews: [
      {
        id: reviewRunId,
        threadId: parentThreadId,
        title: "CAD Review",
        status: "planning",
        activePersona: "synthesis",
        whatIsBeingReviewed: "assembly",
        commonThemes: [],
        positiveSignals: [],
        reviewerTraits: {},
        personaReports: [],
        deepDiveReports: [],
        mergedActionItems: [],
        evidenceArtifacts: [],
        toolCallsByReviewer: {},
        createdAt: freshUpdatedAt,
        updatedAt: freshUpdatedAt,
      },
    ],
    activities: [],
  } as unknown as OrchestrationThread;
}

function makeFailedParentThread(): OrchestrationThread {
  return {
    ...makeParentThread(),
    reviews: [
      {
        id: reviewRunId,
        threadId: parentThreadId,
        title: "CAD Review",
        status: "failed",
        whatIsBeingReviewed: "assembly",
        commonThemes: [],
        positiveSignals: [],
        reviewerTraits: {},
        personaReports: [],
        deepDiveReports: [],
        mergedActionItems: [],
        evidenceArtifacts: [],
        toolCallsByReviewer: {},
        createdAt: now,
        updatedAt: now,
        error: "CAD review was interrupted before it completed.",
      },
    ],
  } as unknown as OrchestrationThread;
}

function makeRunningChildThread(
  sessionUpdatedAt = now,
  threadUpdatedAt = sessionUpdatedAt,
): OrchestrationThread {
  return {
    id: childThreadId,
    updatedAt: threadUpdatedAt,
    session: {
      threadId: childThreadId,
      status: "running",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: "turn-1",
      lastError: null,
      updatedAt: sessionUpdatedAt,
    },
    messages: [],
    activities: [],
  } as unknown as OrchestrationThread;
}

function makeProjectionSnapshotQuery(
  parentThread: OrchestrationThread,
  snapshotThreads: ReadonlyArray<OrchestrationThread> = [],
): ProjectionSnapshotQueryShape {
  return {
    getCommandReadModel: () => Effect.succeed(emptyReadModel),
    getSnapshot: () =>
      Effect.succeed({
        ...emptyReadModel,
        threads: snapshotThreads,
      } as OrchestrationReadModel),
    getShellSnapshot: () => Effect.succeed(emptyShellSnapshot),
    getArchivedShellSnapshot: () => Effect.succeed(emptyShellSnapshot),
    getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
    getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
    getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
    getProjectShellById: () => Effect.succeed(Option.none()),
    getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
    getThreadCheckpointContext: () => Effect.succeed(Option.none()),
    getFullThreadDiffContext: () => Effect.succeed(Option.none()),
    getThreadShellById: () => Effect.succeed(Option.none()),
    getThreadDetailById: (threadId) =>
      Effect.succeed(threadId === parentThreadId ? Option.some(parentThread) : Option.none()),
  };
}

describe("CadReviewService", () => {
  it("extracts the final JSON object after non-JSON fenced progress text", () => {
    const parsed = extractJsonObject(
      [
        "I found a local artifact:",
        "```",
        "current.3mf",
        "```",
        "Final report:",
        JSON.stringify({
          commonThemes: ["Shooter compression needs validation."],
          actionItems: [
            {
              title: "Check shooter compression",
              description: "Measure the note path through the shooter wheels.",
              priority: "high",
            },
          ],
        }),
      ].join("\n"),
    );

    expect(parsed?.actionItems).toEqual([
      {
        title: "Check shooter compression",
        description: "Measure the note path through the shooter wheels.",
        priority: "high",
      },
    ]);
  });

  it("repairs a truncated JSON object when the reviewer stalls after structured output", () => {
    const parsed = extractJsonObject(`{
      "summary": "Shooter review",
      "topConcerns": [
        {
          "title": "Belt tension access",
          "description": "The belt path is visible but the tensioning feature is not.",
          "severity": "high",
          "specificCheck": "Measure the belt center distance and service access"
        }
      ],
      "recommendedChanges": [
        "Model a dedicated tensioning slot"
    `);

    expect(parsed?.summary).toBe("Shooter review");
    expect(parsed?.topConcerns).toEqual([
      {
        title: "Belt tension access",
        description: "The belt path is visible but the tensioning feature is not.",
        severity: "high",
        specificCheck: "Measure the belt center distance and service access",
      },
    ]);
    expect(parsed?.recommendedChanges).toEqual(["Model a dedicated tensioning slot"]);
  });

  it("uses child-thread scoped CAD review prompt message ids", () => {
    const first = cadReviewChildPromptMessageId(
      ThreadId.make(`${parentThreadId}:cad-review:${reviewRunId}:synthesis:first`),
    );
    const second = cadReviewChildPromptMessageId(
      ThreadId.make(`${parentThreadId}:cad-review:${reviewRunId}:synthesis:second`),
    );

    expect(first).toBe(`user:${parentThreadId}:cad-review:${reviewRunId}:synthesis:first:prompt`);
    expect(second).not.toBe(first);
  });

  it("strips internal stack traces from user-visible CAD review errors", () => {
    expect(
      userVisibleErrorMessage(
        [
          "CadReviewRunError: Provider instance 'opencode' does not expose a Codex CAD screenshot export root.",
          "    at file:///internal/CadReviewService.ts:1281:15",
        ].join("\n"),
      ),
    ).toBe("Provider instance 'opencode' does not expose a Codex CAD screenshot export root.");
  });

  it("recognizes provider instances that cannot run automatic baseline screenshot export", () => {
    expect(
      isUnsupportedCodexCadScreenshotExportRootError(
        "Provider instance 'opencode' does not expose a Codex CAD screenshot export root.",
      ),
    ).toBe(true);
    expect(isUnsupportedCodexCadScreenshotExportRootError("Failed to capture iso view.")).toBe(
      false,
    );
  });

  it("estimates child output tokens from assistant text when provider token usage is absent", () => {
    const childThread = {
      messages: [
        {
          role: "assistant",
          text: "abcd ".repeat(200),
        },
      ],
      activities: [],
    } as unknown as OrchestrationThread;

    expect(outputTokensFromChildThread(childThread)).toBe(250);
  });

  it("treats a non-streaming assistant response as completed child output", () => {
    const childThread = {
      messages: [
        {
          role: "assistant",
          text: "Review plan complete.",
          streaming: false,
        },
      ],
    } as unknown as OrchestrationThread;

    expect(childThreadHasCompletedAssistantMessage(childThread)).toBe(true);
  });

  it("does not treat reviewer preambles as complete structured CAD review output", () => {
    const preamble = "Reviewing the provided baseline screenshots first.";

    expect(mechanismPlanOutputIsReady(preamble)).toBe(false);
    expect(personaReviewOutputIsReady(preamble)).toBe(false);
    expect(deepDiveOutputIsReady(preamble)).toBe(false);
    expect(synthesisOutputIsReady(preamble)).toBe(false);
  });

  it("recognizes structured CAD review outputs for each child phase", () => {
    expect(
      mechanismPlanOutputIsReady(
        JSON.stringify({
          summary: "Scope the shooter.",
          reviewScope: "Shooter mechanism",
          baselineRequired: false,
          baselineReason: "The target is specific.",
          mechanisms: [],
          reviewerSelection: [],
        }),
      ),
    ).toBe(true);
    expect(
      personaReviewOutputIsReady(
        JSON.stringify({
          summary: "Shooter review complete.",
          positiveSignals: [],
          topConcerns: [],
          repeatedPatterns: [],
          likelyFailureModes: [],
          recommendedChanges: [],
          confidence: "medium",
          missingEvidence: "No additional evidence captured.",
        }),
      ),
    ).toBe(true);
    expect(
      deepDiveOutputIsReady(
        JSON.stringify({
          focus: "Shooter wheel support",
          sourceFindingIds: [],
          summary: "No deep-dive blocker found.",
          observations: [],
          specificChecks: [],
          recommendedChanges: [],
          confidence: "medium",
        }),
      ),
    ).toBe(true);
    expect(
      synthesisOutputIsReady(
        JSON.stringify({
          commonThemes: [],
          positiveSignals: [],
          blockingIssues: [],
          actionItems: [],
          suggestedBuildOrder: [],
          unresolvedQuestions: [],
        }),
      ),
    ).toBe(true);
  });

  it("detects Codex after-agent hook failure warnings in child output", () => {
    const childThread = {
      activities: [
        {
          kind: "runtime.warning",
          payload: {
            message:
              '{"fields":{"message":"after_agent hook failed; continuing","hook_name":"after_agent"}}',
          },
        },
      ],
    } as unknown as OrchestrationThread;

    expect(childThreadHasAfterAgentHookFailure(childThread)).toBe(true);
  });

  it("detects provider quota retries that would block hidden child reviewers", () => {
    expect(
      blockingProviderRetryWarning({
        nowMs: 1000,
        activities: [
          {
            kind: "runtime.warning",
            payload: {
              message: "Too Many Requests: quota exceeded",
              detail: {
                type: "retry",
                attempt: 1,
                next: 1000 + 5 * 60 * 1000,
              },
            },
          },
        ] as unknown as OrchestrationThread["activities"],
      }),
    ).toBe("Too Many Requests: quota exceeded");
  });

  it("runs CAD review personas with the shared reviewer concurrency limit", () => {
    expect(
      reviewerConcurrencyForThread(
        {
          modelSelection: {
            instanceId: "opencode",
            model: "github-copilot/gemini-3-flash-preview",
            options: [{ id: "agent", value: "build" }],
          },
        } as unknown as OrchestrationThread,
        3,
      ),
    ).toBe(3);
    expect(
      reviewerConcurrencyForThread(
        {
          modelSelection: {
            instanceId: "codex",
            model: "gpt-5.5",
            options: [],
          },
        } as unknown as OrchestrationThread,
        3,
      ),
    ).toBe(3);
    expect(reviewerConcurrencyForThread({} as unknown as OrchestrationThread, 5)).toBe(3);
  });

  it("uses the larger child output token signal when activity counts are stale", () => {
    const childThread = {
      messages: [
        {
          role: "assistant",
          text: "abcd ".repeat(200),
        },
      ],
      activities: [
        {
          kind: "context-window.updated",
          payload: {
            lastOutputTokens: 123,
          },
        },
      ],
    } as unknown as OrchestrationThread;

    expect(outputTokensFromChildThread(childThread)).toBe(250);
  });

  it("detects unresolved interactive prompts in hidden child review threads", () => {
    expect(
      firstPendingInteractiveChildPrompt([
        {
          id: "approval-open",
          tone: "approval",
          kind: "approval.requested",
          summary: "Approval requested",
          payload: {
            requestId: "approval-1",
            detail: "grep",
          },
          turnId: null,
          sequence: 1,
          createdAt: now,
        },
      ] as unknown as OrchestrationThread["activities"]),
    ).toEqual({
      kind: "approval",
      requestId: "approval-1",
      detail: "grep",
    });
  });

  it("clears resolved interactive prompts in hidden child review threads", () => {
    expect(
      firstPendingInteractiveChildPrompt([
        {
          id: "user-input-open",
          tone: "approval",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "input-1",
            detail: "Need a decision",
          },
          turnId: null,
          sequence: 1,
          createdAt: now,
        },
        {
          id: "user-input-resolved",
          tone: "approval",
          kind: "user-input.resolved",
          summary: "User input resolved",
          payload: {
            requestId: "input-1",
          },
          turnId: null,
          sequence: 2,
          createdAt: now,
        },
      ] as unknown as OrchestrationThread["activities"]),
    ).toBeUndefined();
  });

  it("parses reviewer selection from the mechanism planning pass", () => {
    const plan = buildMechanismPlan(
      JSON.stringify({
        summary: "Focus on the flywheel mounting.",
        reviewScope: "Flywheel mounting robustness.",
        baselineRequired: false,
        baselineReason: "The scoped prompt can be routed before standard screenshots.",
        mechanisms: [],
        reviewerSelection: [
          {
            persona: "mechanical_robustness",
            enabled: true,
            reason: "Mounting stiffness and fatigue are physical failure risks.",
          },
          {
            persona: "systems_integration",
            enabled: false,
            reason: "The prompt is scoped to the local mount.",
          },
          {
            persona: "program_readiness",
            enabled: false,
            reason: "No schedule or scope decision was requested.",
          },
        ],
      }),
    );

    expect(plan?.baselineRequired).toBe(false);
    expect(plan?.baselineReason).toBe(
      "The scoped prompt can be routed before standard screenshots.",
    );
    expect(plan?.reviewerSelection).toEqual([
      {
        persona: "systems_integration",
        enabled: false,
        reason: "The prompt is scoped to the local mount.",
      },
      {
        persona: "program_readiness",
        enabled: false,
        reason: "No schedule or scope decision was requested.",
      },
      {
        persona: "mechanical_robustness",
        enabled: true,
        reason: "Mounting stiffness and fatigue are physical failure risks.",
      },
    ]);
  });

  it("keeps mechanism planning prompts on the exploratory review plan", () => {
    const prompt = buildMechanismPlanningPrompt({
      subject: "1678 Rapid React Shooter",
      reviewPrompt: "Review my CAD from all angles",
      baselineArtifacts: [],
    });

    expect(prompt).toContain("identify what the reviewers must inspect deeply");
    expect(prompt).toContain("use at most two high-signal searches");
    expect(prompt).toContain("Include calculatorNeeds");
    expect(prompt).toContain("mechanisms must be objects with name");
  });

  it("preserves verbose mechanism plans before passing them to reviewers", () => {
    const longText = "long detail ".repeat(80);
    const plan = buildMechanismPlan(
      JSON.stringify({
        summary: longText,
        reviewScope: longText,
        baselineRequired: false,
        baselineReason: longText,
        mechanisms: [0, 1, 2].map((index) => ({
          name: `Mechanism ${index}`,
          role: longText,
          visibleEvidence: [longText, longText, longText, longText],
          suspiciousRegions: [longText, longText, longText, longText],
          specificChecks: [longText, longText, longText, longText],
          precedentQueries: [longText, longText, longText, longText],
        })),
        reviewPriorities: [longText, longText, longText, longText, longText],
        missingContext: [longText, longText, longText, longText],
        calculatorNeeds: [longText, longText, longText, longText],
        reviewerSelection: [
          { persona: "systems_integration", enabled: true, reason: longText },
          { persona: "program_readiness", enabled: true, reason: longText },
          { persona: "mechanical_robustness", enabled: true, reason: longText },
        ],
      }),
    );

    expect(plan?.mechanisms).toHaveLength(3);
    expect(plan?.mechanisms[0]?.specificChecks).toHaveLength(4);
    expect(plan?.reviewPriorities).toHaveLength(5);
    expect(plan?.missingContext).toHaveLength(4);
    expect(plan?.calculatorNeeds).toHaveLength(4);
    expect(plan?.summary).toBe(longText.trim());
    expect(plan?.mechanisms[0]?.role).toBe(longText.trim());
    expect(plan?.reviewerSelection[0]?.reason).toBe(longText.trim());
  });

  it("falls back to all reviewers when planner selection is incomplete", () => {
    const plan = buildMechanismPlan(
      JSON.stringify({
        summary: "Planner omitted reviewers.",
        mechanisms: [],
        reviewerSelection: [
          {
            persona: "mechanical_robustness",
            enabled: false,
            reason: "Missing the other reviewers.",
          },
        ],
      }),
    );

    expect(plan?.reviewerSelection.every((selection) => selection.enabled)).toBe(true);
  });

  it("falls back to all reviewers when planner selection expresses uncertainty", () => {
    const plan = buildMechanismPlan(
      JSON.stringify({
        summary: "Planner was unsure.",
        mechanisms: [],
        reviewerSelection: [
          {
            persona: "systems_integration",
            enabled: false,
            reason: "Unclear whether this affects adjacent assemblies.",
          },
          {
            persona: "program_readiness",
            enabled: false,
            reason: "No program signal was requested.",
          },
          {
            persona: "mechanical_robustness",
            enabled: true,
            reason: "Physical mounting risk is in scope.",
          },
        ],
      }),
    );

    expect(plan?.reviewerSelection.every((selection) => selection.enabled)).toBe(true);
  });

  it("marks the review stopped before stopping persisted CAD review child sessions", async () => {
    const dispatchedCommands: OrchestrationCommand[] = [];
    const parentThread = makeParentThread();
    const layer = CadReviewServiceLive.pipe(
      Layer.provide(
        Layer.succeed(OrchestrationEngineService, {
          readEvents: () => Stream.empty,
          dispatch: (command) =>
            Effect.sync(() => {
              dispatchedCommands.push(command);
              return { sequence: dispatchedCommands.length };
            }),
          streamDomainEvents: Stream.empty,
        }),
      ),
      Layer.provide(
        Layer.succeed(ProjectionSnapshotQuery, makeProjectionSnapshotQuery(parentThread)),
      ),
      Layer.provide(
        Layer.succeed(CadViewScheduler, {
          enqueue: (_threadId, _operationId, operation) => operation,
        }),
      ),
      Layer.provide(ServerSettingsService.layerTest()),
      Layer.provide(NodeServices.layer),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CadReviewService;
        yield* service.stopReview({
          type: "thread.review-stop-requested",
          commandId: CommandId.make("cmd-stop-review"),
          payload: {
            threadId: parentThreadId,
            reviewRunId,
            createdAt: now,
          },
        } as Parameters<typeof service.stopReview>[0]);
      }).pipe(Effect.provide(layer)),
    );

    const sessionStopCommands = dispatchedCommands.filter(
      (command) => command.type === "thread.session.stop",
    );
    expect(sessionStopCommands).toHaveLength(1);
    expect(sessionStopCommands[0]).toMatchObject({
      type: "thread.session.stop",
      threadId: childThreadId,
    });
    expect(dispatchedCommands.map((command) => command.type)).toEqual([
      "thread.review.upsert",
      "thread.session.stop",
      "thread.activity.append",
    ]);
  });

  it("stops persisted CAD review child sessions when recovering interrupted reviews", async () => {
    const dispatchedCommands: OrchestrationCommand[] = [];
    const parentThread = makeParentThread();
    const layer = CadReviewServiceLive.pipe(
      Layer.provide(
        Layer.succeed(OrchestrationEngineService, {
          readEvents: () => Stream.empty,
          dispatch: (command) =>
            Effect.sync(() => {
              dispatchedCommands.push(command);
              return { sequence: dispatchedCommands.length };
            }),
          streamDomainEvents: Stream.empty,
        }),
      ),
      Layer.provide(
        Layer.succeed(
          ProjectionSnapshotQuery,
          makeProjectionSnapshotQuery(parentThread, [parentThread]),
        ),
      ),
      Layer.provide(
        Layer.succeed(CadViewScheduler, {
          enqueue: (_threadId, _operationId, operation) => operation,
        }),
      ),
      Layer.provide(ServerSettingsService.layerTest()),
      Layer.provide(NodeServices.layer),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CadReviewService;
        yield* service.recoverInterruptedReviews();
      }).pipe(Effect.provide(layer)),
    );

    const sessionStopCommands = dispatchedCommands.filter(
      (command) => command.type === "thread.session.stop",
    );
    expect(sessionStopCommands).toHaveLength(1);
    expect(sessionStopCommands[0]).toMatchObject({
      type: "thread.session.stop",
      threadId: childThreadId,
    });
    const recoveredActivity = dispatchedCommands.find(
      (command) =>
        command.type === "thread.activity.append" &&
        command.activity.kind === "cad-review.interrupted-recovered",
    );
    expect(recoveredActivity).toMatchObject({
      type: "thread.activity.append",
      activity: {
        payload: {
          reviewRunId,
          interruptedChildThreadCount: 1,
        },
      },
    });
  });

  it("does not recover a newly active CAD review before child sessions exist", async () => {
    const dispatchedCommands: OrchestrationCommand[] = [];
    const parentThread = makeFreshParentThreadWithoutChildren();
    const layer = CadReviewServiceLive.pipe(
      Layer.provide(
        Layer.succeed(OrchestrationEngineService, {
          readEvents: () => Stream.empty,
          dispatch: (command) =>
            Effect.sync(() => {
              dispatchedCommands.push(command);
              return { sequence: dispatchedCommands.length };
            }),
          streamDomainEvents: Stream.empty,
        }),
      ),
      Layer.provide(
        Layer.succeed(
          ProjectionSnapshotQuery,
          makeProjectionSnapshotQuery(parentThread, [parentThread]),
        ),
      ),
      Layer.provide(
        Layer.succeed(CadViewScheduler, {
          enqueue: (_threadId, _operationId, operation) => operation,
        }),
      ),
      Layer.provide(ServerSettingsService.layerTest()),
      Layer.provide(NodeServices.layer),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CadReviewService;
        yield* service.recoverInterruptedReviews();
      }).pipe(Effect.provide(layer)),
    );

    expect(dispatchedCommands).toEqual([]);
  });

  it("does not recover an active CAD review with recently updated child sessions", async () => {
    const dispatchedCommands: OrchestrationCommand[] = [];
    const parentThread = makeParentThread();
    const childThread = makeRunningChildThread(freshUpdatedAt);
    const layer = CadReviewServiceLive.pipe(
      Layer.provide(
        Layer.succeed(OrchestrationEngineService, {
          readEvents: () => Stream.empty,
          dispatch: (command) =>
            Effect.sync(() => {
              dispatchedCommands.push(command);
              return { sequence: dispatchedCommands.length };
            }),
          streamDomainEvents: Stream.empty,
        }),
      ),
      Layer.provide(
        Layer.succeed(
          ProjectionSnapshotQuery,
          makeProjectionSnapshotQuery(parentThread, [parentThread, childThread]),
        ),
      ),
      Layer.provide(
        Layer.succeed(CadViewScheduler, {
          enqueue: (_threadId, _operationId, operation) => operation,
        }),
      ),
      Layer.provide(ServerSettingsService.layerTest()),
      Layer.provide(NodeServices.layer),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CadReviewService;
        yield* service.recoverInterruptedReviews();
      }).pipe(Effect.provide(layer)),
    );

    expect(dispatchedCommands).toEqual([]);
  });

  it("does not recover an active CAD review with recently updated child thread messages", async () => {
    const dispatchedCommands: OrchestrationCommand[] = [];
    const parentThread = makeParentThread();
    const childThread = makeRunningChildThread(staleUpdatedAt, freshUpdatedAt);
    const layer = CadReviewServiceLive.pipe(
      Layer.provide(
        Layer.succeed(OrchestrationEngineService, {
          readEvents: () => Stream.empty,
          dispatch: (command) =>
            Effect.sync(() => {
              dispatchedCommands.push(command);
              return { sequence: dispatchedCommands.length };
            }),
          streamDomainEvents: Stream.empty,
        }),
      ),
      Layer.provide(
        Layer.succeed(
          ProjectionSnapshotQuery,
          makeProjectionSnapshotQuery(parentThread, [parentThread, childThread]),
        ),
      ),
      Layer.provide(
        Layer.succeed(CadViewScheduler, {
          enqueue: (_threadId, _operationId, operation) => operation,
        }),
      ),
      Layer.provide(ServerSettingsService.layerTest()),
      Layer.provide(NodeServices.layer),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CadReviewService;
        yield* service.recoverInterruptedReviews();
      }).pipe(Effect.provide(layer)),
    );

    expect(dispatchedCommands).toEqual([]);
  });

  it("recovers an active CAD review when a child session stalls after output", async () => {
    const dispatchedCommands: OrchestrationCommand[] = [];
    const parentThread = makeParentThread();
    const childThread = {
      ...makeRunningChildThread(freshUpdatedAt, freshUpdatedAt),
      messages: [
        {
          id: "assistant-stale",
          role: "assistant",
          text: "Partial planner output",
          attachments: [],
          turnId: null,
          streaming: true,
          createdAt: staleUpdatedAt,
          updatedAt: staleUpdatedAt,
        },
      ],
      activities: [],
    } as unknown as OrchestrationThread;
    const layer = CadReviewServiceLive.pipe(
      Layer.provide(
        Layer.succeed(OrchestrationEngineService, {
          readEvents: () => Stream.empty,
          dispatch: (command) =>
            Effect.sync(() => {
              dispatchedCommands.push(command);
              return { sequence: dispatchedCommands.length };
            }),
          streamDomainEvents: Stream.empty,
        }),
      ),
      Layer.provide(
        Layer.succeed(
          ProjectionSnapshotQuery,
          makeProjectionSnapshotQuery(parentThread, [parentThread, childThread]),
        ),
      ),
      Layer.provide(
        Layer.succeed(CadViewScheduler, {
          enqueue: (_threadId, _operationId, operation) => operation,
        }),
      ),
      Layer.provide(ServerSettingsService.layerTest()),
      Layer.provide(NodeServices.layer),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CadReviewService;
        yield* service.recoverInterruptedReviews();
      }).pipe(Effect.provide(layer)),
    );

    const recoveredActivity = dispatchedCommands.find(
      (command) =>
        command.type === "thread.activity.append" &&
        command.activity.kind === "cad-review.interrupted-recovered",
    );
    expect(recoveredActivity).toMatchObject({
      type: "thread.activity.append",
      activity: {
        payload: {
          reviewRunId,
          interruptedChildThreadCount: 1,
        },
      },
    });
  });

  it("stops stale child sessions for failed CAD reviews during recovery", async () => {
    const dispatchedCommands: OrchestrationCommand[] = [];
    const parentThread = makeFailedParentThread();
    const childThread = makeRunningChildThread();
    const layer = CadReviewServiceLive.pipe(
      Layer.provide(
        Layer.succeed(OrchestrationEngineService, {
          readEvents: () => Stream.empty,
          dispatch: (command) =>
            Effect.sync(() => {
              dispatchedCommands.push(command);
              return { sequence: dispatchedCommands.length };
            }),
          streamDomainEvents: Stream.empty,
        }),
      ),
      Layer.provide(
        Layer.succeed(
          ProjectionSnapshotQuery,
          makeProjectionSnapshotQuery(parentThread, [parentThread, childThread]),
        ),
      ),
      Layer.provide(
        Layer.succeed(CadViewScheduler, {
          enqueue: (_threadId, _operationId, operation) => operation,
        }),
      ),
      Layer.provide(ServerSettingsService.layerTest()),
      Layer.provide(NodeServices.layer),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CadReviewService;
        yield* service.recoverInterruptedReviews();
      }).pipe(Effect.provide(layer)),
    );

    const sessionStopCommands = dispatchedCommands.filter(
      (command) => command.type === "thread.session.stop",
    );
    expect(sessionStopCommands).toHaveLength(1);
    expect(sessionStopCommands[0]).toMatchObject({
      type: "thread.session.stop",
      threadId: childThreadId,
    });
    const recoveredActivity = dispatchedCommands.find(
      (command) =>
        command.type === "thread.activity.append" &&
        command.activity.kind === "cad-review.child-sessions-recovered",
    );
    expect(recoveredActivity).toMatchObject({
      type: "thread.activity.append",
      activity: {
        payload: {
          reviewRunId,
          status: "failed",
          interruptedChildThreadCount: 1,
        },
      },
    });
  });
});
