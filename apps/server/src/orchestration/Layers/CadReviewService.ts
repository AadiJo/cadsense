import {
  CadReviewReport,
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  type CadReviewActionItem,
  type CadReviewEvidenceArtifact,
  type CadReviewFinding,
  type CadReviewPersona,
  type CadReviewPersonaReport,
  type CadReviewToolCall,
  type OrchestrationMessage,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@cadsense/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { CadViewScheduler } from "../../cad/CadViewScheduler.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { CadReviewService, type CadReviewServiceShape } from "../Services/CadReviewService.ts";
import {
  PERSONAS,
  REVIEWER_TRAIT_SUMMARIES,
  buildBaselinePrompt,
  buildReviewerPrompt,
  buildSynthesisPrompt,
  personaLabel,
} from "./CadReviewPrompts.ts";

const CAD_REVIEW_CHILD_LINK_KIND = "cad-review.child-thread.linked";
const REVIEWER_TURN_TIMEOUT = Duration.minutes(10);

class CadReviewRunError extends Data.TaggedError("CadReviewRunError")<{
  readonly message: string;
}> {}

type ChildRunResult =
  | { readonly ok: true; readonly childThread: OrchestrationThread }
  | { readonly ok: false; readonly error: string };

const serverCommandId = (tag: string): CommandId =>
  CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function reviewSubject(thread: OrchestrationThread, projectTitle: string | undefined): string {
  return projectTitle && projectTitle !== thread.title
    ? `${projectTitle} / ${thread.title}`
    : thread.title;
}

function reviewTitle(thread: OrchestrationThread, projectTitle: string | undefined): string {
  return `${reviewSubject(thread, projectTitle)} CAD Review`;
}

function trimText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function truncate(value: string, limit = 420): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

function assistantText(messages: ReadonlyArray<OrchestrationMessage>): string {
  return messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.text.trim())
    .filter((text) => text.length > 0)
    .join("\n\n")
    .trim();
}

function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (!candidate || candidate.trim().length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(trimText).filter((entry): entry is string => entry !== undefined)
    : [];
}

function objectArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          entry !== null && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
}

function evidenceIdsForPersona(
  artifacts: ReadonlyArray<CadReviewEvidenceArtifact>,
  persona: CadReviewPersona,
): string[] {
  return artifacts
    .filter((artifact) => artifact.scope === "baseline" || artifact.persona === persona)
    .map((artifact) => artifact.id);
}

function collectTextValues(value: unknown, values: string[] = []): string[] {
  if (typeof value === "string") {
    values.push(value);
    return values;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectTextValues(entry, values);
    }
    return values;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) {
      collectTextValues(entry, values);
    }
  }
  return values;
}

function screenshotTextValues(activity: OrchestrationThreadActivity): string[] {
  return collectTextValues({
    summary: activity.summary,
    payload: activity.payload,
  });
}

function extractSavedCadScreenshotPaths(text: string): string[] {
  const paths = new Set<string>();
  for (const match of text.matchAll(/Saved CAD screenshot to (.+?\.png)(?=\s+\(|$)/g)) {
    const path = match[1]?.trim();
    if (path) paths.add(path);
  }
  return [...paths];
}

function extractExportedScreenshotPaths(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): string[] {
  const paths = new Set<string>();
  for (const activity of activities) {
    for (const text of screenshotTextValues(activity)) {
      for (const path of extractSavedCadScreenshotPaths(text)) {
        paths.add(path);
      }
    }
  }
  return [...paths];
}

function extractReferencedScreenshotPaths(activity: OrchestrationThreadActivity): string[] {
  const paths = new Set<string>();
  for (const text of screenshotTextValues(activity)) {
    for (const path of extractSavedCadScreenshotPaths(text)) {
      paths.add(path);
    }
    for (const match of text.matchAll(/[A-Za-z]:\\[^"'\n\r]+?\.png/g)) {
      paths.add(match[0]);
    }
  }
  return [...paths];
}

function payloadRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function viewNameFromPath(path: string): string {
  const lower = path.toLowerCase().replace(/[_\s]+/g, "-");
  for (const view of [
    "isometric-close-up",
    "isometric",
    "front-close-up",
    "front",
    "back-close-up",
    "back",
    "left-close-up",
    "left",
    "right-close-up",
    "right",
    "top-close-up",
    "top",
    "bottom-close-up",
    "bottom",
  ]) {
    if (lower.includes(view)) return view;
  }
  return "captured view";
}

function toolLifecycleStatus(activity: OrchestrationThreadActivity): CadReviewToolCall["status"] {
  const payload = payloadRecord(activity.payload);
  if (activity.kind.includes("failed") || payload?.status === "failed") {
    return "failed";
  }
  return activity.kind.includes("completed") ? "completed" : "started";
}

function extractNestedToolPayload(activity: OrchestrationThreadActivity): {
  readonly payload: Record<string, unknown>;
  readonly data: Record<string, unknown> | undefined;
  readonly item: Record<string, unknown> | undefined;
} {
  const payload = payloadRecord(activity.payload) ?? {};
  const data = payloadRecord(payload.data);
  const item = payloadRecord(data?.item);
  return { payload, data, item };
}

function summarizeToolArguments(item: Record<string, unknown> | undefined): string | undefined {
  const args = payloadRecord(item?.arguments);
  return args ? truncate(JSON.stringify(args), 260) : undefined;
}

function summarizeToolResult(item: Record<string, unknown> | undefined): string | undefined {
  const error = trimText(item?.error);
  if (error) {
    return error;
  }
  const result = payloadRecord(item?.result);
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .map((entry) => trimText(payloadRecord(entry)?.text))
    .filter((entry): entry is string => entry !== undefined)
    .join("\n");
  return text ? truncate(text, 420) : undefined;
}

function artifactIdsForActivity(
  activity: OrchestrationThreadActivity,
  artifacts: ReadonlyArray<CadReviewEvidenceArtifact>,
): string[] {
  const paths = new Set(
    extractReferencedScreenshotPaths(activity).map((path) => path.toLowerCase()),
  );
  if (paths.size === 0) {
    return [];
  }
  return artifacts
    .filter((artifact) => {
      const uri = artifact.artifactUri?.toLowerCase();
      return uri !== undefined && paths.has(uri);
    })
    .map((artifact) => artifact.id);
}

function dedupeToolCalls(toolCalls: ReadonlyArray<CadReviewToolCall>): CadReviewToolCall[] {
  const byKey = new Map<string, CadReviewToolCall>();
  for (const toolCall of toolCalls) {
    const key = [
      toolCall.persona,
      toolCall.phase,
      toolCall.toolName,
      toolCall.argumentsSummary ?? "",
      toolCall.resultSummary ?? "",
      toolCall.evidenceArtifactIds.join("|"),
    ].join("\u0000");
    const previous = byKey.get(key);
    if (!previous || previous.status === "started") {
      byKey.set(key, toolCall);
    }
  }
  return [...byKey.values()];
}

function toolCallsFromActivities(input: {
  readonly reviewRunId: string;
  readonly persona: CadReviewPersona;
  readonly phase: string;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly artifacts: ReadonlyArray<CadReviewEvidenceArtifact>;
}): CadReviewToolCall[] {
  const toolCalls = input.activities
    .filter((activity) => activity.tone === "tool" || activity.kind.startsWith("tool."))
    .flatMap((activity, index) => {
      const status = toolLifecycleStatus(activity);
      if (status === "started") {
        return [];
      }
      const { payload, data, item } = extractNestedToolPayload(activity);
      const toolCall: CadReviewToolCall = {
        id: `${input.reviewRunId}:${input.persona}:tool:${activity.id}:${index}`,
        persona: input.persona,
        phase: input.phase,
        toolName:
          trimText(item?.name) ??
          trimText(item?.toolName) ??
          trimText(item?.tool) ??
          trimText(payload.lastToolName) ??
          trimText(payload.toolName) ??
          trimText(data?.itemType) ??
          trimText(payload.itemType) ??
          activity.summary,
        argumentsSummary:
          summarizeToolArguments(item) ?? trimText(payload.detail) ?? trimText(payload.summary),
        resultSummary:
          summarizeToolResult(item) ?? trimText(payload.message) ?? trimText(payload.detail),
        evidenceArtifactIds: artifactIdsForActivity(activity, input.artifacts),
        status,
        createdAt: activity.createdAt,
        completedAt: activity.createdAt,
      };
      return [toolCall];
    });
  return dedupeToolCalls(toolCalls);
}

function buildPersonaReport(input: {
  readonly reviewRunId: string;
  readonly persona: Exclude<CadReviewPersona, "synthesis">;
  readonly text: string;
  readonly artifacts: ReadonlyArray<CadReviewEvidenceArtifact>;
  readonly toolCalls: ReadonlyArray<CadReviewToolCall>;
  readonly createdAt: string;
}): CadReviewPersonaReport {
  const parsed = extractJsonObject(input.text);
  const evidenceArtifactIds = evidenceIdsForPersona(input.artifacts, input.persona);
  const topConcernsRaw = objectArray(parsed?.topConcerns ?? parsed?.findings ?? parsed?.concerns);
  const topConcerns =
    topConcernsRaw.length > 0
      ? topConcernsRaw.map((entry, index): CadReviewFinding => {
          const confidence = trimText(entry.confidence);
          const missingEvidence = trimText(entry.missingEvidence);
          const finding: CadReviewFinding = {
            id: `${input.reviewRunId}:${input.persona}:finding:${index + 1}`,
            title: trimText(entry.title) ?? `Finding ${index + 1}`,
            description:
              trimText(entry.description) ??
              trimText(entry.detail) ??
              trimText(entry.summary) ??
              "Reviewer reported this concern without a separate description.",
            evidenceArtifactIds,
            confidence:
              confidence === "high" || confidence === "medium" || confidence === "low"
                ? confidence
                : "medium",
          };
          if (missingEvidence) {
            return Object.assign(finding, { missingEvidence });
          }
          return finding;
        })
      : (() => {
          const finding: CadReviewFinding = {
            id: `${input.reviewRunId}:${input.persona}:finding:1`,
            title: "Reviewer finding",
            description: truncate(input.text || "Reviewer completed without assistant text."),
            evidenceArtifactIds,
            confidence: "low",
          };
          return input.text
            ? [finding]
            : [{ ...finding, missingEvidence: "No assistant review text was captured." }];
        })();
  const parsedConfidence = trimText(parsed?.confidence);

  return {
    persona: input.persona,
    status: "completed",
    summary: trimText(parsed?.summary) ?? truncate(input.text || "Reviewer completed."),
    topConcerns,
    repeatedPatterns: stringArray(parsed?.repeatedPatterns),
    likelyFailureModes: stringArray(parsed?.likelyFailureModes),
    recommendedChanges: stringArray(parsed?.recommendedChanges),
    confidence:
      parsedConfidence === "high" || parsedConfidence === "medium" || parsedConfidence === "low"
        ? parsedConfidence
        : topConcerns.some((finding) => finding.confidence === "low")
          ? "low"
          : "medium",
    ...(trimText(parsed?.missingEvidence)
      ? { missingEvidence: trimText(parsed?.missingEvidence) }
      : {}),
    evidenceArtifactIds,
    toolCallIds: input.toolCalls.map((toolCall) => toolCall.id),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

function failedPersonaReport(input: {
  readonly reviewRunId: string;
  readonly persona: Exclude<CadReviewPersona, "synthesis">;
  readonly error: string;
  readonly createdAt: string;
}): CadReviewPersonaReport {
  return {
    persona: input.persona,
    status: "failed",
    summary: `${personaLabel(input.persona)} reviewer failed before producing a complete report.`,
    topConcerns: [],
    repeatedPatterns: [],
    likelyFailureModes: [],
    recommendedChanges: [],
    confidence: "low",
    missingEvidence: "Reviewer run failed.",
    evidenceArtifactIds: [],
    toolCallIds: [],
    error: input.error,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

function synthesizeServerSide(input: {
  readonly reviewRunId: string;
  readonly subject: string;
  readonly reports: ReadonlyArray<CadReviewPersonaReport>;
  readonly synthesisText: string;
}): {
  readonly commonThemes: string[];
  readonly actionItems: CadReviewActionItem[];
} {
  const parsed = extractJsonObject(input.synthesisText);
  const commonThemes =
    stringArray(parsed?.commonThemes).length > 0
      ? stringArray(parsed?.commonThemes)
      : [
          ...new Set(
            input.reports.flatMap((report) => [
              ...report.repeatedPatterns,
              ...report.likelyFailureModes,
            ]),
          ),
        ].slice(0, 6);
  const parsedActionItems = objectArray(parsed?.actionItems);
  const actionItems =
    parsedActionItems.length > 0
      ? parsedActionItems.map((entry, index): CadReviewActionItem => {
          const priority = trimText(entry.priority);
          const actionItem: CadReviewActionItem = {
            id: `${input.reviewRunId}:action:${index + 1}`,
            title: trimText(entry.title) ?? `Action item ${index + 1}`,
            description:
              trimText(entry.description) ??
              trimText(entry.detail) ??
              "Follow up on the linked CAD review findings.",
            priority:
              priority === "critical" ||
              priority === "high" ||
              priority === "medium" ||
              priority === "low"
                ? priority
                : "medium",
            sourceFindingIds: stringArray(entry.sourceFindingIds),
          };
          const subsystem = trimText(entry.subsystem);
          const issueType = trimText(entry.issueType);
          return Object.assign(
            actionItem,
            subsystem ? { subsystem } : {},
            issueType ? { issueType } : {},
          );
        })
      : input.reports
          .flatMap((report) => report.topConcerns.map((finding) => ({ report, finding })))
          .slice(0, 8)
          .map(
            ({ report, finding }, index): CadReviewActionItem => ({
              id: `${input.reviewRunId}:action:${index + 1}`,
              title: finding.title,
              description: finding.description,
              subsystem: input.subject,
              issueType: `${personaLabel(report.persona)} finding`,
              priority: finding.confidence === "high" ? "high" : "medium",
              sourceFindingIds: [finding.id],
            }),
          );
  return { commonThemes, actionItems };
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const cadViewScheduler = yield* CadViewScheduler;

  const appendActivity = (input: {
    readonly threadId: OrchestrationThread["id"];
    readonly tone: "info" | "tool" | "approval" | "error";
    readonly kind: string;
    readonly summary: string;
    readonly payload: Record<string, unknown>;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId(input.kind),
      threadId: input.threadId,
      activity: {
        id: EventId.make(crypto.randomUUID()),
        tone: input.tone,
        kind: input.kind,
        summary: input.summary,
        payload: input.payload,
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const upsertReview = (threadId: OrchestrationThread["id"], review: CadReviewReport) =>
    orchestrationEngine.dispatch({
      type: "thread.review.upsert",
      commandId: serverCommandId("cad-review-upsert"),
      threadId,
      review,
      createdAt: review.updatedAt,
    });

  const createChildThread = (input: {
    readonly parentThread: OrchestrationThread;
    readonly reviewRunId: string;
    readonly persona: CadReviewPersona;
    readonly title: string;
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      const childThreadId = ThreadId.make(
        `${input.parentThread.id}:cad-review:${input.reviewRunId}:${input.persona}:${crypto.randomUUID()}`,
      );
      yield* orchestrationEngine.dispatch({
        type: "thread.create",
        commandId: serverCommandId("cad-review-child-create"),
        threadId: childThreadId,
        projectId: input.parentThread.projectId,
        title: `[hidden] ${input.title}`,
        ...(input.parentThread.externalContext !== null
          ? { externalContext: input.parentThread.externalContext }
          : {}),
        modelSelection: input.parentThread.modelSelection,
        runtimeMode: input.parentThread.runtimeMode,
        interactionMode: input.parentThread.interactionMode,
        branch: input.parentThread.branch,
        worktreePath: input.parentThread.worktreePath,
        createdAt: input.createdAt,
      });
      yield* appendActivity({
        threadId: childThreadId,
        tone: "info",
        kind: CAD_REVIEW_CHILD_LINK_KIND,
        summary: `Linked to CAD review ${input.reviewRunId}`,
        payload: {
          parentThreadId: input.parentThread.id,
          reviewRunId: input.reviewRunId,
          persona: input.persona,
        },
        createdAt: input.createdAt,
      });
      yield* appendActivity({
        threadId: input.parentThread.id,
        tone: "info",
        kind: "cad-review.child-thread.created",
        summary: `${personaLabel(input.persona)} reviewer thread created`,
        payload: {
          reviewRunId: input.reviewRunId,
          persona: input.persona,
          childThreadId,
        },
        createdAt: input.createdAt,
      });
      return childThreadId;
    });

  const waitForChildTurn = (
    childThreadId: ThreadId,
  ): Effect.Effect<OrchestrationThread, CadReviewRunError> =>
    Effect.gen(function* () {
      const threadOption = yield* projectionSnapshotQuery.getThreadDetailById(childThreadId).pipe(
        Effect.mapError(
          (cause) =>
            new CadReviewRunError({
              message: `Failed to read child thread '${childThreadId}': ${String(cause)}`,
            }),
        ),
      );
      if (Option.isNone(threadOption)) {
        return yield* new CadReviewRunError({
          message: `Child thread '${childThreadId}' was not found.`,
        });
      }
      const childThread = threadOption.value;
      const hasAssistantMessage = childThread.messages.some(
        (message) => message.role === "assistant" && !message.streaming,
      );
      const sessionStatus = childThread.session?.status;
      if (
        hasAssistantMessage &&
        (sessionStatus === "ready" || sessionStatus === "stopped" || sessionStatus === "error")
      ) {
        return childThread;
      }
      if (sessionStatus === "error" && childThread.session?.lastError) {
        return yield* new CadReviewRunError({ message: childThread.session.lastError });
      }
      yield* Effect.sleep(Duration.seconds(1));
      return yield* waitForChildTurn(childThreadId);
    });

  const runChildReviewer = (input: {
    readonly parentThread: OrchestrationThread;
    readonly reviewRunId: string;
    readonly persona: CadReviewPersona;
    readonly title: string;
    readonly prompt: string;
    readonly createdAt: string;
  }) =>
    cadViewScheduler.enqueue(
      input.parentThread.id,
      `${input.reviewRunId}:${input.persona}`,
      Effect.gen(function* () {
        const childThreadId = yield* createChildThread(input);
        yield* orchestrationEngine.dispatch({
          type: "thread.turn.start",
          commandId: serverCommandId("cad-review-child-turn"),
          threadId: childThreadId,
          message: {
            messageId: MessageId.make(`user:${input.reviewRunId}:${input.persona}`),
            role: "user",
            text: input.prompt,
            attachments: [],
          },
          modelSelection: input.parentThread.modelSelection,
          runtimeMode: input.parentThread.runtimeMode,
          interactionMode: input.parentThread.interactionMode,
          createdAt: input.createdAt,
        });
        const completed = yield* waitForChildTurn(childThreadId).pipe(
          Effect.timeoutOption(REVIEWER_TURN_TIMEOUT),
          Effect.flatMap((option) =>
            Option.match(option, {
              onNone: () =>
                Effect.fail(
                  new CadReviewRunError({
                    message: `Timed out waiting for '${childThreadId}'.`,
                  }),
                ),
              onSome: (childThread) => Effect.succeed(childThread),
            }),
          ),
        );
        return { ok: true, childThread: completed } satisfies ChildRunResult;
      }).pipe(
        Effect.matchCauseEffect({
          onFailure: (cause) =>
            Effect.succeed({
              ok: false,
              error: Cause.pretty(cause),
            } satisfies ChildRunResult),
          onSuccess: (result) => Effect.succeed(result),
        }),
      ),
    );

  const artifactsFromChild = (input: {
    readonly reviewRunId: string;
    readonly childThread: OrchestrationThread;
    readonly scope: "baseline" | "persona";
    readonly persona?: CadReviewPersona;
    readonly createdAt: string;
  }): CadReviewEvidenceArtifact[] => {
    const paths = extractExportedScreenshotPaths(input.childThread.activities);
    return paths.map((path, index) => {
      const artifact: CadReviewEvidenceArtifact = {
        id: `${input.reviewRunId}:${input.scope}:${input.persona ?? "baseline"}:${index + 1}`,
        scope: input.scope,
        viewName: viewNameFromPath(path),
        artifactUri: path,
        mimeType: "image/png",
        status: "captured",
        createdAt: input.createdAt,
      };
      if (input.persona !== undefined) {
        return Object.assign(artifact, { persona: input.persona });
      }
      return artifact;
    });
  };

  const generateReview: CadReviewServiceShape["generateReview"] = (event) =>
    Effect.gen(function* () {
      const threadOption = yield* projectionSnapshotQuery.getThreadDetailById(
        event.payload.threadId,
      );
      if (Option.isNone(threadOption)) {
        return;
      }
      const thread = threadOption.value;
      const snapshot = yield* projectionSnapshotQuery.getCommandReadModel();
      const projectTitle = snapshot.projects.find(
        (project) => project.id === thread.projectId,
      )?.title;
      const subject = reviewSubject(thread, projectTitle);
      const createdAt = event.payload.createdAt;
      let updatedAt = yield* nowIso;

      let review: CadReviewReport = {
        id: event.payload.reviewRunId,
        threadId: thread.id,
        title: reviewTitle(thread, projectTitle),
        status: "capturing-baseline",
        activePersona: "synthesis",
        whatIsBeingReviewed: subject,
        commonThemes: [],
        reviewerTraits: REVIEWER_TRAIT_SUMMARIES,
        personaReports: [],
        mergedActionItems: [],
        evidenceArtifacts: [],
        toolCallsByReviewer: {
          systems_integration: [],
          program_readiness: [],
          mechanical_robustness: [],
          synthesis: [],
        },
        createdAt,
        updatedAt,
      };

      yield* appendActivity({
        threadId: thread.id,
        tone: "info",
        kind: "cad-review.requested",
        summary: `CAD review requested for ${subject}`,
        payload: { reviewRunId: review.id, phase: "requested" },
        createdAt,
      });
      yield* upsertReview(thread.id, review);

      const baselineStartedAt = yield* nowIso;
      const baselineChild = yield* runChildReviewer({
        parentThread: thread,
        reviewRunId: review.id,
        persona: "synthesis",
        title: `${review.title} - baseline capture`,
        prompt: buildBaselinePrompt(subject),
        createdAt: baselineStartedAt,
      });
      updatedAt = yield* nowIso;
      if (baselineChild.ok) {
        const baselineArtifacts = artifactsFromChild({
          reviewRunId: review.id,
          childThread: baselineChild.childThread,
          scope: "baseline",
          createdAt: updatedAt,
        });
        const baselineToolCalls = toolCallsFromActivities({
          reviewRunId: review.id,
          persona: "synthesis",
          phase: "baseline",
          activities: baselineChild.childThread.activities,
          artifacts: baselineArtifacts,
        });
        Object.assign(review, {
          evidenceArtifacts: [...review.evidenceArtifacts, ...baselineArtifacts],
          toolCallsByReviewer: {
            ...review.toolCallsByReviewer,
            synthesis: [...review.toolCallsByReviewer.synthesis, ...baselineToolCalls],
          },
          updatedAt,
        });
        yield* appendActivity({
          threadId: thread.id,
          tone: "info",
          kind: "cad-review.baseline.completed",
          summary:
            baselineArtifacts.length > 0
              ? "Baseline CAD views captured"
              : "Baseline capture completed without screenshot artifacts",
          payload: {
            reviewRunId: review.id,
            phase: "baseline",
            agent: "Baseline capture",
            childThreadId: baselineChild.childThread.id,
            artifactCount: baselineArtifacts.length,
          },
          createdAt: updatedAt,
        });
      } else {
        Object.assign(review, {
          error: `Baseline capture failed: ${baselineChild.error}`,
          updatedAt,
        });
        yield* appendActivity({
          threadId: thread.id,
          tone: "error",
          kind: "cad-review.baseline.failed",
          summary: "Baseline CAD capture failed",
          payload: {
            reviewRunId: review.id,
            phase: "baseline",
            detail: baselineChild.error,
          },
          createdAt: updatedAt,
        });
      }
      yield* upsertReview(thread.id, review);

      for (const persona of PERSONAS) {
        updatedAt = yield* nowIso;
        Object.assign(review, { status: "reviewing", activePersona: persona, updatedAt });
        yield* upsertReview(thread.id, review);
        yield* appendActivity({
          threadId: thread.id,
          tone: "info",
          kind: "cad-review.persona.started",
          summary: `${persona} reviewer running`,
          payload: {
            reviewRunId: review.id,
            phase: "reviewing",
            agent: `${persona} reviewer`,
            persona,
          },
          createdAt: updatedAt,
        });

        const personaChild = yield* runChildReviewer({
          parentThread: thread,
          reviewRunId: review.id,
          persona,
          title: `${review.title} - ${personaLabel(persona)}`,
          prompt: buildReviewerPrompt({
            persona,
            subject,
            baselineArtifacts: review.evidenceArtifacts.filter(
              (artifact) => artifact.scope === "baseline",
            ),
          }),
          createdAt: updatedAt,
        });
        const reportAt = yield* nowIso;
        if (personaChild.ok) {
          const personaArtifacts = artifactsFromChild({
            reviewRunId: review.id,
            childThread: personaChild.childThread,
            scope: "persona",
            persona,
            createdAt: reportAt,
          });
          const nextArtifacts = [...review.evidenceArtifacts, ...personaArtifacts];
          const toolCalls = toolCallsFromActivities({
            reviewRunId: review.id,
            persona,
            phase: "reviewing",
            activities: personaChild.childThread.activities,
            artifacts: nextArtifacts,
          });
          const report = buildPersonaReport({
            reviewRunId: review.id,
            persona,
            text: assistantText(personaChild.childThread.messages),
            artifacts: nextArtifacts,
            toolCalls,
            createdAt: reportAt,
          });
          Object.assign(review, {
            evidenceArtifacts: nextArtifacts,
            toolCallsByReviewer: {
              ...review.toolCallsByReviewer,
              [persona]: [...review.toolCallsByReviewer[persona], ...toolCalls],
            },
            personaReports: [...review.personaReports, report],
            updatedAt: reportAt,
          });
        } else {
          Object.assign(review, {
            status: "partial",
            personaReports: [
              ...review.personaReports,
              failedPersonaReport({
                reviewRunId: review.id,
                persona,
                error: personaChild.error,
                createdAt: reportAt,
              }),
            ],
            updatedAt: reportAt,
          });
        }
        yield* appendActivity({
          threadId: thread.id,
          tone: personaChild.ok ? "info" : "error",
          kind: personaChild.ok ? "cad-review.persona.completed" : "cad-review.persona.failed",
          summary: personaChild.ok ? `${persona} reviewer completed` : `${persona} reviewer failed`,
          payload: {
            reviewRunId: review.id,
            phase: "reviewing",
            agent: `${persona} reviewer`,
            persona,
            ...(personaChild.ok
              ? { childThreadId: personaChild.childThread.id }
              : { detail: personaChild.error }),
          },
          createdAt: reportAt,
        });
        yield* upsertReview(thread.id, review);
      }

      updatedAt = yield* nowIso;
      Object.assign(review, { status: "synthesizing", activePersona: "synthesis", updatedAt });
      yield* upsertReview(thread.id, review);
      const completedReports = review.personaReports.filter(
        (report) => report.status === "completed",
      );
      const synthesisChild =
        completedReports.length > 0
          ? yield* runChildReviewer({
              parentThread: thread,
              reviewRunId: review.id,
              persona: "synthesis",
              title: `${review.title} - synthesis`,
              prompt: buildSynthesisPrompt({ subject, reports: review.personaReports }),
              createdAt: updatedAt,
            })
          : null;
      const synthesisText = synthesisChild?.ok
        ? assistantText(synthesisChild.childThread.messages)
        : "";
      const synthesisArtifacts = synthesisChild?.ok
        ? artifactsFromChild({
            reviewRunId: review.id,
            childThread: synthesisChild.childThread,
            scope: "persona",
            persona: "synthesis",
            createdAt: updatedAt,
          })
        : [];
      const synthesisToolCalls = synthesisChild?.ok
        ? toolCallsFromActivities({
            reviewRunId: review.id,
            persona: "synthesis",
            phase: "synthesis",
            activities: synthesisChild.childThread.activities,
            artifacts: [...review.evidenceArtifacts, ...synthesisArtifacts],
          })
        : [];
      const synthesized = synthesizeServerSide({
        reviewRunId: review.id,
        subject,
        reports: review.personaReports,
        synthesisText,
      });
      const failedReports = review.personaReports.filter((report) => report.status === "failed");
      updatedAt = yield* nowIso;
      Object.assign(review, {
        status:
          completedReports.length === 0
            ? "failed"
            : failedReports.length > 0 || synthesisChild?.ok === false
              ? "partial"
              : "completed",
        activePersona: undefined,
        commonThemes: synthesized.commonThemes,
        mergedActionItems: synthesized.actionItems,
        evidenceArtifacts: [...review.evidenceArtifacts, ...synthesisArtifacts],
        toolCallsByReviewer: {
          ...review.toolCallsByReviewer,
          synthesis: [...review.toolCallsByReviewer.synthesis, ...synthesisToolCalls],
        },
        ...(synthesisChild?.ok === false
          ? { error: `Synthesis failed: ${synthesisChild.error}` }
          : {}),
        updatedAt,
      });
      yield* appendActivity({
        threadId: thread.id,
        tone: synthesisChild?.ok === false ? "error" : "info",
        kind:
          synthesisChild?.ok === false
            ? "cad-review.synthesis.failed"
            : "cad-review.synthesis.completed",
        summary:
          synthesisChild?.ok === false
            ? "CAD review synthesis failed; server fallback used"
            : "CAD review synthesis completed",
        payload: {
          reviewRunId: review.id,
          phase: "synthesis",
          agent: "synthesis",
          status: review.status,
          failedReviewers: failedReports.map((report) => report.persona),
          ...(synthesisChild?.ok ? { childThreadId: synthesisChild.childThread.id } : {}),
          ...(synthesisChild?.ok === false ? { detail: synthesisChild.error } : {}),
        },
        createdAt: updatedAt,
      });
      yield* upsertReview(thread.id, review);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("cad review generation failed", { cause: String(cause) }),
      ),
    );

  return { generateReview } satisfies CadReviewServiceShape;
});

export const CadReviewServiceLive = Layer.effect(CadReviewService, make);
