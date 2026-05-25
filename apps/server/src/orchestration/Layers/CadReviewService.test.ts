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
import { CadReviewServiceLive } from "./CadReviewService.ts";

const parentThreadId = ThreadId.make("parent-thread");
const reviewRunId = "cad-review-1";
const childThreadId = ThreadId.make(`${parentThreadId}:cad-review:${reviewRunId}:synthesis:child`);
const now = "2026-01-01T00:00:00.000Z";

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

function makeRunningChildThread(): OrchestrationThread {
  return {
    id: childThreadId,
    session: {
      threadId: childThreadId,
      status: "running",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: "turn-1",
      lastError: null,
      updatedAt: now,
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
  it("stops persisted CAD review child sessions before marking the review stopped", async () => {
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
      "thread.session.stop",
      "thread.review.upsert",
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
