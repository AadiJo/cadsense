import {
  type CadReviewActionItem,
  type CadReviewPersonaReport,
  CommandId,
  EventId,
  MessageId,
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
  cadReviewChildHasFirstProgress,
  cadReviewChildPromptMessageId,
  CadReviewServiceLive,
  dedupeCadReviewActionItems,
  extractJsonObject,
  plainCadReviewActionTitle,
  plainCadReviewText,
  selectDeepDiveFindings,
} from "./CadReviewService.ts";
import {
  buildMechanismPlanningPrompt,
  buildReviewerPrompt,
  buildSynthesisPrompt,
} from "./CadReviewPrompts.ts";

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

  it("detects first progress from child review messages or tool activity", () => {
    expect(
      cadReviewChildHasFirstProgress({
        messages: [],
        activities: [],
      }),
    ).toBe(false);

    expect(
      cadReviewChildHasFirstProgress({
        messages: [
          {
            id: MessageId.make("assistant-message"),
            role: "assistant",
            text: "Inspecting the shooter now.",
            turnId: null,
            streaming: true,
            createdAt: now,
            updatedAt: now,
          },
        ],
        activities: [],
      }),
    ).toBe(true);

    expect(
      cadReviewChildHasFirstProgress({
        messages: [],
        activities: [
          {
            id: EventId.make("tool-activity"),
            tone: "tool",
            kind: "tool.started",
            summary: "Used Cad View started",
            payload: {},
            turnId: null,
            createdAt: now,
          },
        ],
      }),
    ).toBe(true);
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

  it("trusts complete reviewer selection even when a disabled reviewer notes uncertainty", () => {
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

    expect(plan?.reviewerSelection).toEqual([
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
    ]);
  });

  it("skips deep dive when reviewer findings are already concrete and actionable", () => {
    const reports: CadReviewPersonaReport[] = [
      {
        persona: "mechanical_robustness",
        status: "completed",
        summary: "Shooter review.",
        positiveSignals: [],
        topConcerns: [
          {
            id: `${reviewRunId}:mechanical_robustness:finding:1`,
            title: "Service access is trapped behind the side plate",
            description: "The shooter reduction is boxed in by the tall side plate.",
            evidenceArtifactIds: ["artifact-1"],
            confidence: "high",
            severity: "high",
            observedGeometry:
              "The right-side reduction is behind the trussed side plate and full-height guard.",
            specificCheck: "Confirm belt and bearing replacement path with the shooter installed.",
            recommendedFix: "Add a removable access cover or make the shooter a pull-out module.",
          },
        ],
        repeatedPatterns: [],
        likelyFailureModes: [],
        recommendedChanges: [],
        confidence: "high",
        evidenceArtifactIds: ["artifact-1"],
        toolCallIds: [],
        createdAt: now,
        updatedAt: now,
      },
    ];

    expect(selectDeepDiveFindings(reports)).toEqual([]);
  });

  it("keeps deep dive for high-risk findings that need more evidence or specificity", () => {
    const reports: CadReviewPersonaReport[] = [
      {
        persona: "systems_integration",
        status: "completed",
        summary: "Shooter review.",
        positiveSignals: [],
        topConcerns: [
          {
            id: `${reviewRunId}:systems_integration:finding:1`,
            title: "Compression continuity may break at the shooter handoff",
            description: "The note path appears to unload between staged rollers.",
            evidenceArtifactIds: ["artifact-1"],
            confidence: "high",
            severity: "high",
            observedGeometry: "The lower conveyor and upper shooter have an open transition.",
            missingEvidence: "Need a close-up of the throat and roller center distances.",
          },
          {
            id: `${reviewRunId}:systems_integration:finding:2`,
            title: "Middle roller access is unclear",
            description: "The center roller is buried in the module.",
            evidenceArtifactIds: ["artifact-2"],
            confidence: "medium",
            severity: "medium",
            observedGeometry: "The module has full side panels.",
            specificCheck: "Confirm the roller can be removed without pulling the shooter.",
          },
        ],
        repeatedPatterns: [],
        likelyFailureModes: [],
        recommendedChanges: [],
        confidence: "medium",
        evidenceArtifactIds: ["artifact-1", "artifact-2"],
        toolCallIds: [],
        createdAt: now,
        updatedAt: now,
      },
    ];

    expect(selectDeepDiveFindings(reports).map((finding) => finding.id)).toEqual([
      `${reviewRunId}:systems_integration:finding:1`,
    ]);
  });

  it("deduplicates overlapping CAD review action items across reviewers", () => {
    const actionItems: CadReviewActionItem[] = [
      {
        id: `${reviewRunId}:action:1`,
        title: "Add belt tension adjustment",
        description: "Slot the NEO mount so the 12T to 36T HTD belt can be tensioned.",
        priority: "medium",
        sourceFindingIds: ["systems:finding:1"],
        evidenceArtifactIds: ["artifact-1"],
        verificationSteps: ["Measure pulley center distance."],
      },
      {
        id: `${reviewRunId}:action:2`,
        title: "Add a real belt-tensioning feature",
        description:
          "Modify the belt stage so one shaft location can be tuned in assembly, or add a serviceable idler.",
        priority: "high",
        sourceFindingIds: ["program:finding:1"],
        evidenceArtifactIds: ["artifact-2"],
        verificationSteps: ["Confirm belt wrap and installed preload."],
      },
      {
        id: `${reviewRunId}:action:3`,
        title: "Support the output shaft",
        description: "Add an outboard bearing if the external load stays far from the plate.",
        priority: "medium",
        sourceFindingIds: ["mechanical:finding:1"],
        evidenceArtifactIds: ["artifact-3"],
      },
    ];

    const deduped = dedupeCadReviewActionItems(actionItems);

    expect(deduped).toHaveLength(2);
    expect(deduped[0]).toMatchObject({
      id: `${reviewRunId}:action:1`,
      priority: "high",
      sourceFindingIds: ["systems:finding:1", "program:finding:1"],
      evidenceArtifactIds: ["artifact-1", "artifact-2"],
      verificationSteps: [
        "Measure pulley center distance.",
        "Confirm belt wrap and installed preload.",
      ],
    });
    expect(deduped[1]?.title).toBe("Support the output shaft");
  });

  it("deduplicates equivalent output shaft overhang language", () => {
    const actionItems: CadReviewActionItem[] = [
      {
        id: `${reviewRunId}:action:1`,
        title: "Output shaft is heavily overhung relative to the gearbox support",
        description: "Shorten the shaft or add outboard support.",
        priority: "high",
        sourceFindingIds: ["systems:finding:1"],
        evidenceArtifactIds: ["artifact-1"],
      },
      {
        id: `${reviewRunId}:action:2`,
        title: "Output shaft appears to rely on a long external cantilever without support",
        description: "Add an outboard bearing block before attaching the downstream mechanism.",
        priority: "medium",
        sourceFindingIds: ["mechanical:finding:1"],
        evidenceArtifactIds: ["artifact-2"],
      },
      {
        id: `${reviewRunId}:action:3`,
        title: "Long unsupported outboard load path on the exposed output shaft",
        description: "Move the first loaded hub closer to the plate.",
        priority: "medium",
        sourceFindingIds: ["program:finding:1"],
        evidenceArtifactIds: ["artifact-3"],
      },
    ];

    const deduped = dedupeCadReviewActionItems(actionItems);

    expect(deduped).toHaveLength(1);
    expect(deduped[0]).toMatchObject({
      priority: "high",
      sourceFindingIds: ["systems:finding:1", "mechanical:finding:1", "program:finding:1"],
      evidenceArtifactIds: ["artifact-1", "artifact-2", "artifact-3"],
    });
  });

  it("rewrites output load-path shorthand into a concrete action title", () => {
    expect(plainCadReviewActionTitle("Close the output load path before driving")).toBe(
      "Support the output shaft close to the external load",
    );
    expect(plainCadReviewActionTitle("Support the output shaft")).toBe("Support the output shaft");
    expect(plainCadReviewText("The main risk is the output load path.")).toBe(
      "The main risk is the support for the output shaft.",
    );
  });

  it("keeps reviewer and synthesis prompts focused on observed geometry instead of generic warnings", () => {
    const reviewerPrompt = buildReviewerPrompt({
      persona: "mechanical_robustness",
      subject: "Assembly 1",
      reviewPrompt: "Do an in depth review of my CAD",
      baselineArtifacts: [],
      reviewPlan: undefined,
    });
    const synthesisPrompt = buildSynthesisPrompt({
      subject: "Assembly 1",
      reviewPrompt: "Do an in depth review of my CAD",
      reports: [],
      reviewPlan: undefined,
      deepDiveReports: [],
    });
    const planningPrompt = buildMechanismPlanningPrompt({
      subject: "Assembly 1",
      reviewPrompt: "Do an in depth review of my CAD",
      baselineArtifacts: [],
    });

    expect(reviewerPrompt).toContain("A topConcern must be a judgment about geometry");
    expect(reviewerPrompt).toContain("Separate checks from findings");
    expect(planningPrompt).toContain("Do not call request_user_input");
    expect(planningPrompt).toContain(
      "Do not treat the phrase 'in depth' as a request for broader scope",
    );
    expect(reviewerPrompt).toContain("Do not call request_user_input");
    expect(reviewerPrompt).toContain("calculate the combined ratio");
    expect(synthesisPrompt).toContain("Do not call request_user_input");
    expect(synthesisPrompt).toContain("Do not promote duplicate concerns");
    expect(synthesisPrompt).toContain("preserve the actual ratio judgment");
    expect(synthesisPrompt).toContain("plain language for FRC students");
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
