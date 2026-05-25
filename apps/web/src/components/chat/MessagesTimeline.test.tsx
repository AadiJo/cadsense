import { EnvironmentId, MessageId, ThreadId, type CadReviewReport } from "@cadsense/contracts";
import { createRef, type ReactNode, type Ref } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { LegendListRef } from "@legendapp/list/react";

vi.mock("@legendapp/list/react", async () => {
  const legendListTestId = "legend-list";

  const LegendList = (props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string } }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
    ref?: Ref<LegendListRef>;
  }) => (
    <div data-testid={legendListTestId}>
      {props.ListHeaderComponent}
      {props.data.map((item) => (
        <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
      ))}
      {props.ListFooterComponent}
    </div>
  );

  return { LegendList };
});

function matchMedia() {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

beforeAll(() => {
  const classList = {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  };

  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("window", {
    matchMedia,
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList,
      offsetHeight: 0,
    },
  });
});

const ACTIVE_THREAD_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const MESSAGE_CREATED_AT = "2026-03-17T19:12:28.000Z";

function buildProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnId: null,
    activeTurnStartedAt: null,
    listRef: createRef<LegendListRef | null>(),
    completionDividerBeforeEntryId: null,
    completionSummary: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    routeThreadKey: "environment-local:thread-1",
    onOpenTurnDiff: () => {},
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ACTIVE_THREAD_ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
    onIsAtEndChange: () => {},
  };
}

function buildLongUserMessageText(tail = "deep hidden detail only after expand") {
  return Array.from({ length: 9 }, (_, index) =>
    index === 8 ? tail : `Line ${index + 1}: ${"verbose prompt content ".repeat(8).trim()}`,
  ).join("\n");
}

function buildUserTimelineEntry(text: string) {
  return {
    id: "entry-1",
    kind: "message" as const,
    createdAt: MESSAGE_CREATED_AT,
    message: {
      id: MessageId.make("message-1"),
      role: "user" as const,
      text,
      createdAt: MESSAGE_CREATED_AT,
      streaming: false,
    },
  };
}

function buildCadReviewTimelineEntry() {
  const review: CadReviewReport = {
    id: "review-1",
    threadId: ThreadId.make("thread-1"),
    title: "Intake CAD Review",
    status: "completed",
    whatIsBeingReviewed: "Intake subsystem",
    commonThemes: ["Roller path needs measurable checks."],
    reviewerTraits: {
      systems_integration: "Integration",
      program_readiness: "Readiness",
      mechanical_robustness: "Robustness",
      synthesis: "Synthesis",
    },
    reviewPlan: {
      summary: "Inspect intake rollers and frame interface.",
      mechanisms: [
        {
          name: "Intake roller path",
          role: "Acquire game pieces from the floor.",
          visibleEvidence: ["Top view shows two rollers."],
          suspiciousRegions: ["Roller-to-floor transition"],
          specificChecks: ["Measure roller compression progression."],
          precedentQueries: ["FRC intake roller compression technical binder"],
        },
      ],
      reviewPriorities: ["Compression path"],
      missingContext: ["Game piece diameter"],
      calculatorNeeds: ["Shaft deflection from unsupported span"],
    },
    personaReports: [
      {
        persona: "mechanical_robustness",
        status: "completed",
        summary: "Roller span needs a deflection check.",
        topConcerns: [
          {
            id: "finding-1",
            title: "Unsupported roller span",
            description: "The roller appears end-supported across the intake width.",
            evidenceArtifactIds: ["artifact-1"],
            confidence: "medium",
            severity: "high",
            observedGeometry: "Long roller supported at side plates.",
            specificCheck: "Measure shaft span and calculate deflection.",
            recommendedFix: "Add support or increase shaft/tube stiffness.",
          },
        ],
        repeatedPatterns: [],
        likelyFailureModes: [],
        recommendedChanges: [],
        confidence: "medium",
        evidenceArtifactIds: ["artifact-1"],
        toolCallIds: [],
        createdAt: MESSAGE_CREATED_AT,
        updatedAt: MESSAGE_CREATED_AT,
      },
    ],
    deepDiveReports: [
      {
        id: "deep-1",
        sourceFindingIds: ["finding-1"],
        focus: "Unsupported roller span",
        summary: "Close the concern with a shaft deflection calculation.",
        inspectedEvidenceArtifactIds: ["artifact-1"],
        observations: ["No mid-span support is visible."],
        specificChecks: ["Measure span, shaft OD, material, and compression load."],
        recommendedChanges: ["Add mid-span support if deflection is too high."],
        confidence: "medium",
        createdAt: MESSAGE_CREATED_AT,
      },
    ],
    mergedActionItems: [
      {
        id: "action-1",
        title: "Run roller span deflection check",
        description: "Measure the roller span and calculate deflection before release.",
        priority: "high",
        sourceFindingIds: ["finding-1"],
        targetGeometry: "Upper intake roller",
        verificationSteps: ["Measure span", "Calculate deflection"],
      },
    ],
    evidenceArtifacts: [
      {
        id: "artifact-1",
        scope: "baseline",
        viewName: "isometric",
        artifactUri: "C:/tmp/intake.png",
        status: "captured",
        createdAt: MESSAGE_CREATED_AT,
      },
    ],
    toolCallsByReviewer: {
      systems_integration: [],
      program_readiness: [],
      mechanical_robustness: [],
      synthesis: [],
    },
    createdAt: MESSAGE_CREATED_AT,
    updatedAt: MESSAGE_CREATED_AT,
  };
  return {
    id: "review-entry-1",
    kind: "cad-review" as const,
    createdAt: MESSAGE_CREATED_AT,
    review,
  };
}

describe("MessagesTimeline", () => {
  it("renders collapse controls for long user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    expect(markup).toContain("Show full message");
    expect(markup).toContain('data-user-message-collapsed="true"');
    expect(markup).toContain('data-user-message-fade="true"');
    expect(markup).toContain('data-user-message-footer="true"');
  });

  it("does not render collapse controls for short user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry("Short prompt.")]}
      />,
    );

    expect(markup).not.toContain("Show full message");
    expect(markup).toContain('data-user-message-collapsible="false"');
  });

  it("renders inline terminal labels with the composer chip UI", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              buildLongUserMessageText("yoo what's @terminal-1:1-5 mean"),
              "",
              "<terminal_context>",
              "- Terminal 1 lines 1-5:",
              "  1 | julius@mac effect-http-ws-cli % bun i",
              "  2 | bun install v1.3.9 (cf6cdbbb)",
              "</terminal_context>",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain("Terminal 1 lines 1-5");
    expect(markup).toContain("lucide-terminal");
    expect(markup).toContain("yoo what&#x27;s ");
    expect(markup).toContain("Show full message");
  }, 20_000);

  it("keeps the copy button for collapsed long user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    expect(markup).toContain('aria-label="Copy link"');
    expect(markup).toContain('data-user-message-collapsed="true"');
    expect(markup).toContain('data-user-message-footer="true"');
  });

  it("renders context compaction entries in the normal work log", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Context compacted",
              tone: "info",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Context compacted");
    expect(markup).toContain("Work log");
  });

  it("renders mechanism plans, deep dives, and rich CAD finding fields", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} timelineEntries={[buildCadReviewTimelineEntry()]} />,
    );

    expect(markup).toContain("Mechanism plan");
    expect(markup).toContain("Intake roller path");
    expect(markup).toContain("Calculator needs");
    expect(markup).toContain("Geometry:");
    expect(markup).toContain("Check:");
    expect(markup).toContain("Focused deep dives");
    expect(markup).toContain("Target:");
    expect(markup).toContain("Calculate deflection");
  });

  it("formats changed file paths from the workspace root", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Updated files",
              tone: "tool",
              changedFiles: ["C:/Users/mike/dev-stuff/cadsense/apps/web/src/session-logic.ts"],
            },
          },
        ]}
        workspaceRoot="C:/Users/mike/dev-stuff/cadsense"
      />,
    );

    expect(markup).toContain("cadsense/apps/web/src/session-logic.ts");
    expect(markup).not.toContain("C:/Users/mike/dev-stuff/cadsense/apps/web/src/session-logic.ts");
  });
});
