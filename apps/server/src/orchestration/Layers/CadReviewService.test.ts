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
  cadReviewChildPromptMessageId,
  CadReviewServiceLive,
  extractJsonObject,
} from "./CadReviewService.ts";

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
