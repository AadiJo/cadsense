import {
  CadReviewReport,
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  type CadScreenshotCaptureHttpResult,
  type CadView,
  type CadReviewActionItem,
  type CadReviewDeepDiveReport,
  type CadReviewEvidenceArtifact,
  type CadReviewFinding,
  type CadReviewMechanismPlan,
  type CadReviewPersona,
  type CadReviewPersonaReport,
  type CadReviewSpecialistPersona,
  type CadReviewStatus,
  type CadReviewToolCall,
  type OrchestrationMessage,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@cadsense/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { captureCadScreenshot } from "../../cad/CadScreenshotClient.ts";
import { rejectCadScreenshotPendingForThread } from "../../cad/CadScreenshotCapture.ts";
import { resolveCadViewExportRootForInstance } from "../../cad/CadViewExportRoot.ts";
import { CadViewScheduler } from "../../cad/CadViewScheduler.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { CadReviewService, type CadReviewServiceShape } from "../Services/CadReviewService.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import {
  PERSONAS,
  REVIEWER_TRAIT_SUMMARIES,
  buildDeepDivePrompt,
  buildMechanismPlanningPrompt,
  buildReviewerPrompt,
  buildSynthesisPrompt,
  personaLabel,
} from "./CadReviewPrompts.ts";

const CAD_REVIEW_CHILD_LINK_KIND = "cad-review.child-thread.linked";
const CAD_REVIEW_CHILD_BOOKKEEPING_ACTIVITY_KINDS = new Set([
  CAD_REVIEW_CHILD_LINK_KIND,
  "cad-review.child-thread.created",
]);
const REVIEWER_TURN_TIMEOUT = Duration.minutes(20);
const CHILD_TURN_STARTUP_NO_PROGRESS_TIMEOUT = Duration.minutes(5);
const CHILD_TURN_STARTUP_NO_PROGRESS_TIMEOUT_MS = Duration.toMillis(
  CHILD_TURN_STARTUP_NO_PROGRESS_TIMEOUT,
);
const CHILD_TURN_STALLED_PROGRESS_TIMEOUT = Duration.minutes(3);
const CHILD_TURN_STALLED_PROGRESS_TIMEOUT_MS = Duration.toMillis(
  CHILD_TURN_STALLED_PROGRESS_TIMEOUT,
);
const CHILD_TURN_BLOCKING_RETRY_THRESHOLD_MS = Duration.toMillis(Duration.minutes(1));
const ACTIVE_CHILD_RECOVERY_GRACE_MS = Duration.toMillis(REVIEWER_TURN_TIMEOUT);
const CAD_REVIEW_REVIEWER_CONCURRENCY = 3;
// Keep baseline capture fast: reviewers can request extra angles, but the automatic pass should
// avoid monopolizing the CAD viewer before agent reasoning even starts.
const BASELINE_CAPTURE_SPECS = [
  { view: "isometric", suggestedBaseName: "cad-review-baseline-isometric" },
  { view: "front", suggestedBaseName: "cad-review-baseline-front" },
  { view: "right", suggestedBaseName: "cad-review-baseline-right" },
  { view: "top", suggestedBaseName: "cad-review-baseline-top" },
  {
    view: "isometric-close-up",
    suggestedBaseName: "cad-review-baseline-isometric-close-up",
  },
  { view: "right-close-up", suggestedBaseName: "cad-review-baseline-right-close-up" },
] as const satisfies ReadonlyArray<{
  readonly view: CadView;
  readonly suggestedBaseName: string;
}>;
const CAD_REVIEW_ACTIVE_STATUSES = new Set<CadReviewStatus>([
  "requested",
  "planning",
  "capturing-baseline",
  "reviewing",
  "deep-diving",
  "synthesizing",
]);
const SCREENSHOT_TIMEOUT_RE = /\btimed out\b/i;

class CadReviewRunError extends Data.TaggedError("CadReviewRunError")<{
  readonly message: string;
}> {}

type ChildRunResult =
  | { readonly ok: true; readonly childThread: OrchestrationThread }
  | { readonly ok: false; readonly error: string; readonly childThread?: OrchestrationThread };

type ChildTurnCompletion = {
  readonly label: string;
  readonly isComplete: (childThread: OrchestrationThread) => boolean;
};

type CadReviewChildPhase = "planning" | "reviewing" | "deep-dive" | "synthesis";

interface BaselineCaptureRecord {
  readonly result: CadScreenshotCaptureHttpResult;
  readonly view: CadView;
  readonly createdAt: string;
  readonly activity: OrchestrationThreadActivity;
}

type BaselineCaptureOperationResult = {
  readonly artifacts: CadReviewEvidenceArtifact[];
  readonly toolCalls: CadReviewToolCall[];
};

type BaselineCaptureResult =
  | ({
      readonly ok: true;
      readonly skipped: false;
    } & BaselineCaptureOperationResult)
  | ({
      readonly ok: true;
      readonly skipped: true;
      readonly skipReason: string;
    } & BaselineCaptureOperationResult)
  | { readonly ok: false; readonly error: string };

function isCadReviewActive(status: CadReviewStatus): boolean {
  return CAD_REVIEW_ACTIVE_STATUSES.has(status);
}

const reviewKey = (threadId: ThreadId, reviewRunId: string) => `${threadId}\0${reviewRunId}`;

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

function childReviewThreadInitialTitle(title: string): string {
  return `[hidden] ${title}`;
}

function trimText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function truncate(value: string, limit = 420): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

export function userVisibleErrorMessage(error: string): string {
  const trimmed = error.trim();
  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim();
  return (firstLine && firstLine.length > 0 ? firstLine : trimmed).replace(
    /^CadReviewRunError:\s*/,
    "",
  );
}

function userVisibleCauseMessage(cause: Cause.Cause<unknown>): string {
  return userVisibleErrorMessage(Cause.pretty(cause));
}

export function isUnsupportedCodexCadScreenshotExportRootError(error: string): boolean {
  return error.toLowerCase().includes("does not expose a codex cad screenshot export root");
}

function assistantText(messages: ReadonlyArray<OrchestrationMessage>): string {
  return messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.text.trim())
    .filter((text) => text.length > 0)
    .join("\n\n")
    .trim();
}

function parseJsonObjectCandidate(candidate: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function findBalancedJsonObjectEnd(text: string, startIndex: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char !== "}") {
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return index + 1;
    }
  }
  return undefined;
}

function repairIncompleteJsonObjectCandidate(candidate: string): string | undefined {
  const stack: Array<"}" | "]"> = [];
  let inString = false;
  let escaped = false;
  for (const char of candidate) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      stack.push("}");
      continue;
    }
    if (char === "[") {
      stack.push("]");
      continue;
    }
    if (char !== "}" && char !== "]") {
      continue;
    }
    const expected = stack.at(-1);
    if (expected !== char) {
      return undefined;
    }
    stack.pop();
  }

  if (stack.length === 0 && !inString) {
    return undefined;
  }

  let repaired = candidate.trimEnd();
  if (inString) {
    if (escaped) {
      repaired = repaired.slice(0, -1);
    }
    repaired += '"';
  }
  repaired = repaired.replace(/,\s*$/, "");
  return `${repaired}${stack.toReversed().join("")}`;
}

export function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const parsedCandidates: Array<Record<string, unknown>> = [];
  for (const match of text.matchAll(/```(?:json)?[^\S\r\n]*\r?\n([\s\S]*?)```/gi)) {
    const candidate = match[1]?.trim();
    if (!candidate?.startsWith("{")) {
      continue;
    }
    const parsed = parseJsonObjectCandidate(candidate);
    if (parsed) {
      parsedCandidates.push(parsed);
    }
  }
  let index = text.indexOf("{");
  while (index !== -1) {
    const endIndex = findBalancedJsonObjectEnd(text, index);
    if (endIndex === undefined) {
      index = text.indexOf("{", index + 1);
      continue;
    }
    const parsed = parseJsonObjectCandidate(text.slice(index, endIndex));
    if (parsed) {
      parsedCandidates.push(parsed);
      index = text.indexOf("{", endIndex);
      continue;
    }
    index = text.indexOf("{", index + 1);
  }
  const firstObjectStart = text.indexOf("{");
  if (firstObjectStart !== -1) {
    const repaired = repairIncompleteJsonObjectCandidate(text.slice(firstObjectStart));
    const parsed = repaired ? parseJsonObjectCandidate(repaired) : undefined;
    if (parsed) {
      parsedCandidates.push(parsed);
    }
  }
  return parsedCandidates.at(-1);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(trimText).filter((entry): entry is string => entry !== undefined)
    : [];
}

function stringArrayFromUnknown(value: unknown): string[] {
  const direct = stringArray(value);
  if (direct.length > 0) {
    return direct;
  }
  const single = trimText(value);
  return single ? [single] : [];
}

function priorityValue(value: unknown): "critical" | "high" | "medium" | "low" | undefined {
  const priority = trimText(value);
  return priority === "critical" ||
    priority === "high" ||
    priority === "medium" ||
    priority === "low"
    ? priority
    : undefined;
}

function confidenceValue(value: unknown): "high" | "medium" | "low" | undefined {
  const confidence = trimText(value);
  return confidence === "high" || confidence === "medium" || confidence === "low"
    ? confidence
    : undefined;
}

function objectArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          entry !== null && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
}

function isSpecialistPersona(value: unknown): value is CadReviewSpecialistPersona {
  return (
    value === "systems_integration" ||
    value === "program_readiness" ||
    value === "mechanical_robustness"
  );
}

function allReviewerSelection(reason: string): CadReviewMechanismPlan["reviewerSelection"] {
  return PERSONAS.map((persona) => ({ persona, enabled: true, reason }));
}

function isUncertainReviewerSelectionReason(reason: string): boolean {
  return /\b(uncertain|unsure|unknown|unclear|ambiguous|not sure|cannot determine|can't determine)\b/i.test(
    reason,
  );
}

function normalizeReviewerSelection(value: unknown): CadReviewMechanismPlan["reviewerSelection"] {
  const entries = objectArray(value).flatMap((entry) => {
    if (!isSpecialistPersona(entry.persona)) {
      return [];
    }
    return [
      {
        persona: entry.persona,
        enabled: entry.enabled === true,
        reason: trimText(entry.reason) ?? "Planner did not provide a reason.",
      },
    ];
  });
  const byPersona = new Map(entries.map((entry) => [entry.persona, entry]));
  const complete = PERSONAS.every((persona) => byPersona.has(persona));
  const uncertain = entries.some((entry) => isUncertainReviewerSelectionReason(entry.reason));
  if (!complete || !entries.some((entry) => entry.enabled) || uncertain) {
    return allReviewerSelection(
      "Planner selection was missing, incomplete, disabled every reviewer, or expressed uncertainty, so CadSense ran all reviewers.",
    );
  }
  return PERSONAS.map((persona) => byPersona.get(persona)!);
}

function planRequiresBaseline(plan: CadReviewMechanismPlan | undefined): boolean {
  return plan?.baselineRequired ?? true;
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
    for (const path of extractReferencedScreenshotPaths(activity)) {
      paths.add(path);
    }
  }
  return [...paths];
}

function extractFetchedMechbaseArtifactUrls(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): string[] {
  const urls = new Set<string>();
  for (const activity of activities) {
    for (const url of extractReferencedMechbaseArtifactUrls(activity)) {
      urls.add(url);
    }
  }
  return [...urls];
}

function extractReferencedMechbaseArtifactUrls(activity: OrchestrationThreadActivity): string[] {
  const urls = new Set<string>();
  for (const text of screenshotTextValues(activity)) {
    for (const match of text.matchAll(/"artifactUrl"\s*:\s*"([^"]+)"/g)) {
      const url = match[1]?.trim();
      if (url?.startsWith("https://api-frcrag-v2.johari-dev.com/")) {
        urls.add(url);
      }
    }
  }
  return [...urls];
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

export function firstPendingInteractiveChildPrompt(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
):
  | {
      readonly kind: "approval" | "user-input";
      readonly requestId: string;
      readonly detail: string | undefined;
    }
  | undefined {
  const openByRequestId = new Map<
    string,
    {
      readonly kind: "approval" | "user-input";
      readonly requestId: string;
      readonly detail: string | undefined;
    }
  >();
  const orderedActivities = [...activities].toSorted((left, right) => {
    const leftSequence = left.sequence ?? Number.MAX_SAFE_INTEGER;
    const rightSequence = right.sequence ?? Number.MAX_SAFE_INTEGER;
    if (leftSequence !== rightSequence) {
      return leftSequence - rightSequence;
    }
    return left.createdAt.localeCompare(right.createdAt);
  });

  for (const activity of orderedActivities) {
    const payload = payloadRecord(activity.payload);
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : undefined;
    if (!requestId) {
      continue;
    }
    const detail = trimText(payload?.detail);

    if (activity.kind === "approval.requested") {
      openByRequestId.set(requestId, { kind: "approval", requestId, detail });
      continue;
    }
    if (activity.kind === "user-input.requested") {
      openByRequestId.set(requestId, { kind: "user-input", requestId, detail });
      continue;
    }
    if (
      activity.kind === "approval.resolved" ||
      activity.kind === "user-input.resolved" ||
      activity.kind === "provider.approval.respond.failed" ||
      activity.kind === "provider.user-input.respond.failed"
    ) {
      openByRequestId.delete(requestId);
    }
  }

  return openByRequestId.values().next().value;
}

function dateMs(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function maxDateMs(values: ReadonlyArray<string | null | undefined>): number | undefined {
  const parsedValues = values
    .map((value) => dateMs(value))
    .filter((value): value is number => value !== undefined);
  return parsedValues.length > 0 ? Math.max(...parsedValues) : undefined;
}

function childThreadHasReviewerProgress(childThread: OrchestrationThread): boolean {
  return (
    (childThread.messages ?? []).some(
      (message) =>
        message.role === "assistant" || (message.role !== "user" && message.text.trim().length > 0),
    ) ||
    (childThread.activities ?? []).some(
      (activity) => !CAD_REVIEW_CHILD_BOOKKEEPING_ACTIVITY_KINDS.has(activity.kind),
    )
  );
}

export function childThreadHasCompletedAssistantMessage(childThread: OrchestrationThread): boolean {
  return (childThread.messages ?? []).some(
    (message) =>
      message.role === "assistant" && !message.streaming && message.text.trim().length > 0,
  );
}

function childThreadHasAssistantOutput(childThread: OrchestrationThread): boolean {
  return (childThread.messages ?? []).some(
    (message) => message.role === "assistant" && message.text.trim().length > 0,
  );
}

export function childThreadHasAfterAgentHookFailure(childThread: OrchestrationThread): boolean {
  return (childThread.activities ?? []).some((activity) => {
    if (activity.kind !== "runtime.warning") {
      return false;
    }
    const payload = payloadRecord(activity.payload);
    const message =
      typeof payload?.message === "string"
        ? payload.message
        : payload
          ? JSON.stringify(payload)
          : "";
    return message.includes("after_agent hook failed; continuing");
  });
}

function expectedStructuredKey(parsed: Record<string, unknown>, keys: ReadonlyArray<string>) {
  return keys.some((key) => Object.hasOwn(parsed, key));
}

export function mechanismPlanOutputIsReady(text: string): boolean {
  const parsed = extractJsonObject(text);
  if (!parsed) {
    return false;
  }
  return (
    (trimText(parsed.summary) !== undefined || trimText(parsed.reviewScope) !== undefined) &&
    expectedStructuredKey(parsed, [
      "baselineRequired",
      "baselineReason",
      "mechanisms",
      "reviewPriorities",
      "reviewerSelection",
    ])
  );
}

export function personaReviewOutputIsReady(text: string): boolean {
  const parsed = extractJsonObject(text);
  if (!parsed) {
    return false;
  }
  return (
    trimText(parsed.summary) !== undefined &&
    expectedStructuredKey(parsed, [
      "positiveSignals",
      "topConcerns",
      "findings",
      "concerns",
      "repeatedPatterns",
      "likelyFailureModes",
      "recommendedChanges",
      "missingEvidence",
    ])
  );
}

export function deepDiveOutputIsReady(text: string): boolean {
  const parsed = extractJsonObject(text);
  if (!parsed) {
    return false;
  }
  return (
    (trimText(parsed.summary) !== undefined || trimText(parsed.focus) !== undefined) &&
    expectedStructuredKey(parsed, [
      "sourceFindingIds",
      "observations",
      "specificChecks",
      "recommendedChanges",
      "missingEvidence",
    ])
  );
}

export function synthesisOutputIsReady(text: string): boolean {
  const parsed = extractJsonObject(text);
  if (!parsed) {
    return false;
  }
  return expectedStructuredKey(parsed, [
    "commonThemes",
    "positiveSignals",
    "blockingIssues",
    "actionItems",
    "suggestedBuildOrder",
    "unresolvedQuestions",
  ]);
}

function assistantOutputIsReady(
  childThread: OrchestrationThread,
  isReady: (text: string) => boolean,
): boolean {
  return (childThread.messages ?? []).some(
    (message) => message.role === "assistant" && !message.streaming && isReady(message.text),
  );
}

function providerRetryWarningMessage(activity: OrchestrationThreadActivity): string | undefined {
  if (activity.kind !== "runtime.warning") {
    return undefined;
  }
  const payload = payloadRecord(activity.payload);
  const message =
    typeof payload?.message === "string" ? payload.message : payload ? JSON.stringify(payload) : "";
  return /\b(too many requests|quota exceeded|rate limit)\b/i.test(message) ? message : undefined;
}

export function blockingProviderRetryWarning(input: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly nowMs: number;
}): string | undefined {
  for (const activity of input.activities) {
    const message = providerRetryWarningMessage(activity);
    if (!message) {
      continue;
    }
    const payload = payloadRecord(activity.payload);
    const detail = payloadRecord(payload?.detail);
    const next = typeof detail?.next === "number" ? detail.next : undefined;
    if (next === undefined || next - input.nowMs >= CHILD_TURN_BLOCKING_RETRY_THRESHOLD_MS) {
      return message;
    }
  }
  return undefined;
}

function childThreadVisibleProgressUpdatedAtMs(
  childThread: OrchestrationThread,
): number | undefined {
  return maxDateMs([
    ...(childThread.messages ?? []).flatMap((message) =>
      message.role === "assistant" || (message.role !== "user" && message.text.trim().length > 0)
        ? [message.updatedAt, message.createdAt]
        : [],
    ),
    ...(childThread.activities ?? []).flatMap((activity) =>
      CAD_REVIEW_CHILD_BOOKKEEPING_ACTIVITY_KINDS.has(activity.kind) ? [] : [activity.createdAt],
    ),
  ]);
}

function childThreadStartupStartedAtMs(childThread: OrchestrationThread): number | undefined {
  return maxDateMs([
    childThread.latestTurn?.startedAt,
    childThread.latestTurn?.requestedAt,
    childThread.session?.updatedAt,
    childThread.updatedAt,
    childThread.createdAt,
  ]);
}

function childThreadStartupNoProgressTimedOut(input: {
  readonly childThread: OrchestrationThread;
  readonly nowMs: number;
}): boolean {
  if (childThreadHasReviewerProgress(input.childThread)) {
    return false;
  }
  const startedAtMs = childThreadStartupStartedAtMs(input.childThread);
  return (
    startedAtMs !== undefined &&
    input.nowMs - startedAtMs >= CHILD_TURN_STARTUP_NO_PROGRESS_TIMEOUT_MS
  );
}

function childThreadProgressStalledTimedOut(input: {
  readonly childThread: OrchestrationThread;
  readonly nowMs: number;
}): boolean {
  const progressUpdatedAtMs = childThreadVisibleProgressUpdatedAtMs(input.childThread);
  return (
    progressUpdatedAtMs !== undefined &&
    input.nowMs - progressUpdatedAtMs >= CHILD_TURN_STALLED_PROGRESS_TIMEOUT_MS
  );
}

export function reviewerConcurrencyForThread(
  _thread: OrchestrationThread,
  reviewerCount: number,
): number {
  if (reviewerCount <= 0) {
    return 0;
  }
  return Math.min(CAD_REVIEW_REVIEWER_CONCURRENCY, reviewerCount);
}

function reviewChildThreadIdsFromActivities(
  thread: OrchestrationThread,
  reviewRunId: string,
): ThreadId[] {
  const childThreadIds = new Set<string>();
  for (const activity of thread.activities) {
    if (activity.kind !== "cad-review.child-thread.created") {
      continue;
    }
    const payload = payloadRecord(activity.payload);
    if (payload?.reviewRunId !== reviewRunId || typeof payload.childThreadId !== "string") {
      continue;
    }
    childThreadIds.add(payload.childThreadId);
  }
  return [...childThreadIds].map((childThreadId) => ThreadId.make(childThreadId));
}

function hasInterruptedRecoveryActivity(thread: OrchestrationThread, reviewRunId: string): boolean {
  return thread.activities.some((activity) => {
    if (activity.kind !== "cad-review.interrupted-recovered") {
      return false;
    }
    const payload = payloadRecord(activity.payload);
    return payload?.reviewRunId === reviewRunId;
  });
}

function isFreshLiveChildSession(input: {
  readonly childThread: OrchestrationThread | undefined;
  readonly nowMs: number;
}): boolean {
  const childThread = input.childThread;
  const session = childThread?.session;
  if (!childThread || !session || session.status === "stopped" || session.status === "error") {
    return false;
  }
  if (
    childThreadStartupNoProgressTimedOut({
      childThread,
      nowMs: input.nowMs,
    })
  ) {
    return false;
  }
  if (
    childThreadProgressStalledTimedOut({
      childThread,
      nowMs: input.nowMs,
    })
  ) {
    return false;
  }
  if (
    blockingProviderRetryWarning({
      activities: childThread.activities,
      nowMs: input.nowMs,
    })
  ) {
    return false;
  }
  const updatedAtMs = maxDateMs([session.updatedAt, childThread.updatedAt]);
  return updatedAtMs !== undefined && input.nowMs - updatedAtMs <= ACTIVE_CHILD_RECOVERY_GRACE_MS;
}

function isFreshActiveReview(
  review: CadReviewReport,
  nowMs: number,
  maxAgeMs = ACTIVE_CHILD_RECOVERY_GRACE_MS,
): boolean {
  const updatedAtMs = maxDateMs([review.updatedAt, review.createdAt]);
  return updatedAtMs !== undefined && nowMs - updatedAtMs <= maxAgeMs;
}

function hasFreshLiveChildSessionForReview(input: {
  readonly thread: OrchestrationThread;
  readonly reviewRunId: string;
  readonly threadById: ReadonlyMap<ThreadId, OrchestrationThread>;
  readonly now: string;
}): boolean {
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs)) {
    return false;
  }
  return reviewChildThreadIdsFromActivities(input.thread, input.reviewRunId).some((childThreadId) =>
    isFreshLiveChildSession({
      childThread: input.threadById.get(childThreadId),
      nowMs,
    }),
  );
}

export function cadReviewChildPromptMessageId(childThreadId: ThreadId): MessageId {
  return MessageId.make(`user:${childThreadId}:prompt`);
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
  const references = new Set(
    extractReferencedScreenshotPaths(activity).map((path) => path.toLowerCase()),
  );
  for (const url of extractReferencedMechbaseArtifactUrls(activity)) {
    references.add(url.toLowerCase());
  }
  if (references.size === 0) {
    return [];
  }
  return artifacts
    .filter((artifact) => {
      const uri = artifact.artifactUri?.toLowerCase();
      return uri !== undefined && references.has(uri);
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

function activityPayloadRecord(
  activity: OrchestrationThreadActivity,
): Record<string, unknown> | undefined {
  return activity.payload &&
    typeof activity.payload === "object" &&
    !Array.isArray(activity.payload)
    ? (activity.payload as Record<string, unknown>)
    : undefined;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function outputTokensFromActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): number | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "context-window.updated") {
      continue;
    }
    const payload = activityPayloadRecord(activity);
    const tokens = finiteNumber(payload?.lastOutputTokens) ?? finiteNumber(payload?.outputTokens);
    if (tokens !== null) {
      return Math.round(tokens);
    }
  }
  return null;
}

function estimateOutputTokensFromText(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

export function outputTokensFromChildThread(childThread: OrchestrationThread): number | null {
  const activityTokens = outputTokensFromActivities(childThread.activities);
  const estimatedTokens = estimateOutputTokensFromText(assistantText(childThread.messages));
  if (activityTokens === null) {
    return estimatedTokens;
  }
  if (estimatedTokens === null) {
    return activityTokens;
  }
  return Math.max(activityTokens, estimatedTokens);
}

function withChildOutputTokens(
  review: CadReviewReport,
  step: keyof NonNullable<CadReviewReport["outputTokensByStep"]>,
  childThread: OrchestrationThread,
): Pick<CadReviewReport, "outputTokensByStep"> {
  const outputTokens = outputTokensFromChildThread(childThread);
  if (outputTokens === null || outputTokens <= 0) {
    return { outputTokensByStep: review.outputTokensByStep ?? {} };
  }
  const previousOutputTokens = review.outputTokensByStep ?? {};
  return {
    outputTokensByStep: {
      ...previousOutputTokens,
      [step]: outputTokens,
    },
  };
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

function baselineArtifactFromCapture(input: {
  readonly reviewRunId: string;
  readonly index: number;
  readonly view: CadView;
  readonly absolutePath: string;
  readonly createdAt: string;
}): CadReviewEvidenceArtifact {
  return {
    id: `${input.reviewRunId}:baseline:baseline:${input.index + 1}`,
    scope: "baseline",
    viewName: input.view,
    artifactUri: input.absolutePath,
    mimeType: "image/png",
    status: "captured",
    createdAt: input.createdAt,
  };
}

function baselineToolActivity(input: {
  readonly threadId: ThreadId;
  readonly view: CadView;
  readonly suggestedBaseName: string;
  readonly result: CadScreenshotCaptureHttpResult;
  readonly createdAt: string;
}): OrchestrationThreadActivity {
  const toolResultText = `Saved CAD screenshot to ${input.result.absolutePath} (under export root: ${input.result.relativePath}).`;
  return {
    id: EventId.make(crypto.randomUUID()),
    tone: "tool",
    kind: "tool.completed",
    summary: `Captured baseline CAD screenshot for ${input.view}`,
    payload: {
      toolName: "export_cad_screenshot",
      message: toolResultText,
      data: {
        item: {
          name: "export_cad_screenshot",
          arguments: {
            threadId: input.threadId,
            view: input.view,
            fit: true,
            suggestedBaseName: input.suggestedBaseName,
          },
          result: {
            content: [
              {
                type: "text",
                text: toolResultText,
              },
            ],
          },
        },
      },
      absolutePath: input.result.absolutePath,
      relativePath: input.result.relativePath,
      status: "completed",
    },
    turnId: null,
    createdAt: input.createdAt,
  };
}

export function buildMechanismPlan(text: string): CadReviewMechanismPlan | undefined {
  const parsed = extractJsonObject(text);
  if (!parsed) {
    return undefined;
  }
  const mechanisms = objectArray(parsed.mechanisms).map((entry) => ({
    name: trimText(entry.name) ?? "Unspecified mechanism",
    role: trimText(entry.role) ?? "Review this mechanism's role in the subsystem.",
    visibleEvidence: stringArrayFromUnknown(entry.visibleEvidence),
    suspiciousRegions: stringArrayFromUnknown(entry.suspiciousRegions),
    specificChecks: stringArrayFromUnknown(entry.specificChecks),
    precedentQueries: stringArrayFromUnknown(entry.precedentQueries),
  }));
  return {
    summary: trimText(parsed.summary) ?? truncate(text || "Mechanism plan completed."),
    reviewScope: trimText(parsed.reviewScope) ?? "CAD review",
    baselineRequired: typeof parsed.baselineRequired === "boolean" ? parsed.baselineRequired : true,
    baselineReason:
      trimText(parsed.baselineReason) ??
      "Planner did not specify whether baseline capture is required.",
    mechanisms,
    reviewPriorities: stringArrayFromUnknown(parsed.reviewPriorities),
    missingContext: stringArrayFromUnknown(parsed.missingContext),
    calculatorNeeds: stringArrayFromUnknown(parsed.calculatorNeeds),
    reviewerSelection: normalizeReviewerSelection(parsed.reviewerSelection),
  };
}

function artifactIdsFromEvidenceText(input: {
  readonly evidenceText: ReadonlyArray<string>;
  readonly fallback: ReadonlyArray<string>;
  readonly artifacts: ReadonlyArray<CadReviewEvidenceArtifact>;
}): string[] {
  const matched = new Set<string>();
  const evidenceLower = input.evidenceText.map((entry) => entry.toLowerCase());
  for (const artifact of input.artifacts) {
    const haystacks = [
      artifact.id.toLowerCase(),
      artifact.viewName.toLowerCase(),
      artifact.artifactUri.toLowerCase(),
    ];
    if (evidenceLower.some((entry) => haystacks.some((candidate) => entry.includes(candidate)))) {
      matched.add(artifact.id);
    }
  }
  return matched.size > 0 ? [...matched] : [...input.fallback];
}

function representativeArtifactIds(
  artifacts: ReadonlyArray<CadReviewEvidenceArtifact>,
  maxCount = 3,
): string[] {
  const selected: string[] = [];
  const seenViewNames = new Set<string>();
  for (const artifact of artifacts) {
    const viewName = artifact.viewName.toLowerCase();
    if (seenViewNames.has(viewName) && selected.length < maxCount) {
      continue;
    }
    selected.push(artifact.id);
    seenViewNames.add(viewName);
    if (selected.length >= maxCount) {
      return selected;
    }
  }
  return selected;
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
  const personaEvidenceArtifactIds = evidenceIdsForPersona(input.artifacts, input.persona);
  const fallbackEvidenceArtifactIds = representativeArtifactIds(
    input.artifacts.filter((artifact) => artifact.persona === input.persona),
  );
  const topConcernsRaw = objectArray(parsed?.topConcerns ?? parsed?.findings ?? parsed?.concerns);
  const topConcerns =
    topConcernsRaw.length > 0
      ? topConcernsRaw.map((entry, index): CadReviewFinding => {
          const evidenceText = stringArrayFromUnknown(entry.evidence);
          const reasoning = trimText(entry.reasoning);
          const observedGeometry = trimText(entry.observedGeometry);
          const assumption = trimText(entry.assumption);
          const specificCheck = trimText(entry.specificCheck);
          const recommendedFix = trimText(entry.recommendedFix);
          const missingEvidence = trimText(entry.missingEvidence);
          const finding: CadReviewFinding = {
            id: `${input.reviewRunId}:${input.persona}:finding:${index + 1}`,
            title: trimText(entry.title) ?? `Finding ${index + 1}`,
            description:
              trimText(entry.description) ??
              trimText(entry.detail) ??
              trimText(entry.summary) ??
              "Reviewer reported this concern without a separate description.",
            evidenceArtifactIds: artifactIdsFromEvidenceText({
              evidenceText,
              fallback: fallbackEvidenceArtifactIds,
              artifacts: input.artifacts,
            }),
            confidence: confidenceValue(entry.confidence) ?? "medium",
          };
          const severity = priorityValue(entry.severity);
          if (severity) {
            Object.assign(finding, { severity });
          }
          if (evidenceText.length > 0) {
            Object.assign(finding, { evidence: evidenceText });
          }
          if (reasoning) {
            Object.assign(finding, { reasoning });
          }
          if (observedGeometry) {
            Object.assign(finding, { observedGeometry });
          }
          if (assumption) {
            Object.assign(finding, { assumption });
          }
          if (specificCheck) {
            Object.assign(finding, { specificCheck });
          }
          if (recommendedFix) {
            Object.assign(finding, { recommendedFix });
          }
          if (missingEvidence) {
            return Object.assign(finding, { missingEvidence });
          }
          return finding;
        })
      : [];
  const parsedConfidence = confidenceValue(parsed?.confidence);
  const missingEvidence =
    trimText(parsed?.missingEvidence) ??
    (!parsed
      ? "Reviewer did not return parseable structured JSON, so CadSense did not promote free-form text into action items."
      : undefined);

  return {
    persona: input.persona,
    status: "completed",
    summary: trimText(parsed?.summary) ?? truncate(input.text || "Reviewer completed."),
    topConcerns,
    positiveSignals: stringArrayFromUnknown(parsed?.positiveSignals),
    repeatedPatterns: stringArray(parsed?.repeatedPatterns),
    likelyFailureModes: stringArray(parsed?.likelyFailureModes),
    recommendedChanges: stringArray(parsed?.recommendedChanges),
    confidence:
      parsedConfidence ??
      (topConcerns.some((finding) => finding.confidence === "low") ? "low" : "medium"),
    ...(missingEvidence ? { missingEvidence } : {}),
    evidenceArtifactIds: personaEvidenceArtifactIds,
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
    positiveSignals: [],
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

function buildDeepDiveReport(input: {
  readonly reviewRunId: string;
  readonly text: string;
  readonly findings: ReadonlyArray<CadReviewFinding>;
  readonly artifacts: ReadonlyArray<CadReviewEvidenceArtifact>;
  readonly toolCalls: ReadonlyArray<CadReviewToolCall>;
  readonly createdAt: string;
}): CadReviewDeepDiveReport {
  const parsed = extractJsonObject(input.text);
  const sourceFindingIds = stringArrayFromUnknown(parsed?.sourceFindingIds);
  const fallbackSourceIds = input.findings.map((finding) => finding.id);
  const observations = stringArrayFromUnknown(parsed?.observations);
  const evidenceArtifactIds = [
    ...new Set([
      ...input.toolCalls.flatMap((toolCall) => toolCall.evidenceArtifactIds),
      ...input.findings.flatMap((finding) => finding.evidenceArtifactIds),
    ]),
  ];
  return {
    id: `${input.reviewRunId}:deep-dive:${crypto.randomUUID()}`,
    sourceFindingIds: sourceFindingIds.length > 0 ? sourceFindingIds : fallbackSourceIds,
    focus:
      trimText(parsed?.focus) ??
      input.findings
        .map((finding) => finding.title)
        .filter((title) => title.length > 0)
        .slice(0, 3)
        .join("; ") ??
      "Focused CAD review",
    summary: trimText(parsed?.summary) ?? truncate(input.text || "Deep dive completed."),
    inspectedEvidenceArtifactIds:
      evidenceArtifactIds.length > 0
        ? evidenceArtifactIds
        : input.artifacts.map((artifact) => artifact.id),
    observations,
    specificChecks: stringArrayFromUnknown(parsed?.specificChecks),
    recommendedChanges: stringArrayFromUnknown(parsed?.recommendedChanges),
    confidence: confidenceValue(parsed?.confidence) ?? "medium",
    ...(trimText(parsed?.missingEvidence)
      ? { missingEvidence: trimText(parsed?.missingEvidence) }
      : {}),
    createdAt: input.createdAt,
  };
}

function deepDiveFindingScore(finding: CadReviewFinding): number {
  const severityScore =
    finding.severity === "critical"
      ? 6
      : finding.severity === "high"
        ? 5
        : finding.severity === "medium"
          ? 3
          : finding.severity === "low"
            ? 1
            : 0;
  const confidenceScore =
    finding.confidence === "high" ? 2 : finding.confidence === "medium" ? 1 : 0;
  const missingEvidenceScore = finding.missingEvidence ? 1 : 0;
  const specificityGapScore = finding.specificCheck || finding.recommendedFix ? 0 : 2;
  return severityScore + confidenceScore + missingEvidenceScore + specificityGapScore;
}

function selectDeepDiveFindings(
  reports: ReadonlyArray<CadReviewPersonaReport>,
): CadReviewFinding[] {
  return reports
    .flatMap((report) => report.topConcerns)
    .toSorted((left, right) => deepDiveFindingScore(right) - deepDiveFindingScore(left))
    .slice(0, 4);
}

function synthesizeServerSide(input: {
  readonly reviewRunId: string;
  readonly subject: string;
  readonly reports: ReadonlyArray<CadReviewPersonaReport>;
  readonly deepDiveReports: ReadonlyArray<CadReviewDeepDiveReport>;
  readonly synthesisText: string;
}): {
  readonly commonThemes: string[];
  readonly positiveSignals: string[];
  readonly actionItems: CadReviewActionItem[];
} {
  const parsed = extractJsonObject(input.synthesisText);
  const findingById = new Map(
    input.reports.flatMap((report) => report.topConcerns.map((finding) => [finding.id, finding])),
  );
  const evidenceArtifactIdsForFindings = (findingIds: ReadonlyArray<string>): string[] => [
    ...new Set(
      findingIds.flatMap((findingId) => findingById.get(findingId)?.evidenceArtifactIds ?? []),
    ),
  ];
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
  const positiveSignals =
    stringArrayFromUnknown(parsed?.positiveSignals).length > 0
      ? stringArrayFromUnknown(parsed?.positiveSignals)
      : [
          ...new Set(
            input.reports.flatMap((report) => report.positiveSignals).filter((entry) => entry),
          ),
        ].slice(0, 6);
  const parsedActionItems = objectArray(parsed?.actionItems);
  const actionItems =
    parsedActionItems.length > 0
      ? parsedActionItems.map((entry, index): CadReviewActionItem => {
          const sourceFindingIds = stringArray(entry.sourceFindingIds);
          const explicitEvidenceArtifactIds = stringArrayFromUnknown(entry.evidenceArtifactIds);
          const actionItem: CadReviewActionItem = {
            id: `${input.reviewRunId}:action:${index + 1}`,
            title: trimText(entry.title) ?? `Action item ${index + 1}`,
            description:
              trimText(entry.description) ??
              trimText(entry.detail) ??
              "Follow up on the linked CAD review findings.",
            priority: priorityValue(entry.priority) ?? "medium",
            sourceFindingIds,
            evidenceArtifactIds:
              explicitEvidenceArtifactIds.length > 0
                ? explicitEvidenceArtifactIds
                : evidenceArtifactIdsForFindings(sourceFindingIds),
          };
          const subsystem = trimText(entry.subsystem);
          const issueType = trimText(entry.issueType);
          const rationale = trimText(entry.rationale);
          const targetGeometry = trimText(entry.targetGeometry);
          const verificationSteps = stringArrayFromUnknown(entry.verificationSteps);
          return Object.assign(
            actionItem,
            subsystem ? { subsystem } : {},
            issueType ? { issueType } : {},
            rationale ? { rationale } : {},
            targetGeometry ? { targetGeometry } : {},
            verificationSteps.length > 0 ? { verificationSteps } : {},
          );
        })
      : [
          ...input.deepDiveReports.map((deepDive) => ({ deepDive })),
          ...input.reports.flatMap((report) =>
            report.topConcerns.map((finding) => ({ report, finding })),
          ),
        ]
          .slice(0, 8)
          .map((entry, index): CadReviewActionItem => {
            if ("deepDive" in entry) {
              return {
                id: `${input.reviewRunId}:action:${index + 1}`,
                title: entry.deepDive.focus,
                description:
                  entry.deepDive.recommendedChanges[0] ??
                  entry.deepDive.summary ??
                  "Follow up on the focused CAD review.",
                subsystem: input.subject,
                issueType: "focused deep dive",
                priority: entry.deepDive.confidence === "high" ? "high" : "medium",
                sourceFindingIds: entry.deepDive.sourceFindingIds,
                evidenceArtifactIds: entry.deepDive.inspectedEvidenceArtifactIds,
                rationale: entry.deepDive.summary,
                verificationSteps: entry.deepDive.specificChecks,
              };
            }
            const { report, finding } = entry;
            const actionItem: CadReviewActionItem = {
              id: `${input.reviewRunId}:action:${index + 1}`,
              title: finding.title,
              description: finding.recommendedFix ?? finding.description,
              subsystem: input.subject,
              issueType: `${personaLabel(report.persona)} finding`,
              priority: finding.severity ?? (finding.confidence === "high" ? "high" : "medium"),
              sourceFindingIds: [finding.id],
              evidenceArtifactIds: finding.evidenceArtifactIds,
            };
            if (finding.reasoning) {
              Object.assign(actionItem, { rationale: finding.reasoning });
            }
            if (finding.observedGeometry) {
              Object.assign(actionItem, { targetGeometry: finding.observedGeometry });
            }
            if (finding.specificCheck) {
              Object.assign(actionItem, { verificationSteps: [finding.specificCheck] });
            }
            return actionItem;
          });
  return { commonThemes, positiveSignals, actionItems };
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const cadViewScheduler = yield* CadViewScheduler;
  const pathService = yield* Path.Path;
  const serverSettingsService = yield* ServerSettingsService;
  const activeReviews = new Map<
    string,
    { readonly childThreadIds: Set<ThreadId>; stopped: boolean }
  >();

  const getActiveReview = (threadId: ThreadId, reviewRunId: string) => {
    const key = reviewKey(threadId, reviewRunId);
    const existing = activeReviews.get(key);
    if (existing) {
      return existing;
    }
    const state = { childThreadIds: new Set<ThreadId>(), stopped: false };
    activeReviews.set(key, state);
    return state;
  };

  const failIfReviewStopped = (threadId: ThreadId, reviewRunId: string) =>
    Effect.sync(() => activeReviews.get(reviewKey(threadId, reviewRunId))?.stopped === true).pipe(
      Effect.flatMap((stopped) =>
        stopped
          ? Effect.fail(
              new CadReviewRunError({
                message: "CAD review stopped by user.",
              }),
            )
          : Effect.void,
      ),
    );

  const isReviewStopped = (threadId: ThreadId, reviewRunId: string) =>
    activeReviews.get(reviewKey(threadId, reviewRunId))?.stopped === true;

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

  const captureBaselineEvidence = (input: {
    readonly thread: OrchestrationThread;
    readonly reviewRunId: string;
  }): Effect.Effect<BaselineCaptureResult, never, never> => {
    const operation: Effect.Effect<
      BaselineCaptureOperationResult,
      CadReviewRunError | OrchestrationDispatchError,
      never
    > = Effect.gen(function* () {
      const exportRoot = yield* resolveCadViewExportRootForInstance(
        input.thread.modelSelection.instanceId,
      ).pipe(
        Effect.provideService(Path.Path, pathService),
        Effect.provideService(ServerSettingsService, serverSettingsService),
        Effect.mapError(
          (error) =>
            new CadReviewRunError({
              message: error.message,
            }),
        ),
      );
      const captures: BaselineCaptureRecord[] = [];
      const failureDetails: string[] = [];
      for (const spec of BASELINE_CAPTURE_SPECS) {
        yield* failIfReviewStopped(input.thread.id, input.reviewRunId);
        const createdAt = yield* nowIso;
        const captureExit = yield* Effect.exit(
          captureCadScreenshot({
            threadId: input.thread.id,
            exportRoot,
            suggestedBaseName: spec.suggestedBaseName,
            view: spec.view,
            fit: true,
          }).pipe(
            Effect.mapError(
              (error) =>
                new CadReviewRunError({
                  message: `Failed to capture baseline view '${spec.view}': ${error.message}`,
                }),
            ),
          ),
        );
        yield* failIfReviewStopped(input.thread.id, input.reviewRunId);
        if (Exit.isFailure(captureExit)) {
          const detail = userVisibleCauseMessage(captureExit.cause);
          failureDetails.push(`${spec.view}: ${detail}`);
          yield* appendActivity({
            threadId: input.thread.id,
            tone: "error",
            kind: "cad-review.baseline.capture-failed",
            summary: `Baseline CAD view '${spec.view}' failed`,
            payload: {
              reviewRunId: input.reviewRunId,
              phase: "baseline",
              view: spec.view,
              detail,
            },
            createdAt,
          });
          if (captures.length === 0 && SCREENSHOT_TIMEOUT_RE.test(detail)) {
            break;
          }
          continue;
        }
        const result = captureExit.value;
        const activity = baselineToolActivity({
          threadId: input.thread.id,
          view: spec.view,
          suggestedBaseName: spec.suggestedBaseName,
          result,
          createdAt,
        });
        yield* appendActivity({
          threadId: input.thread.id,
          tone: activity.tone,
          kind: activity.kind,
          summary: activity.summary,
          payload: activity.payload as Record<string, unknown>,
          createdAt,
        });
        captures.push({ result, view: spec.view, createdAt, activity });
      }
      if (captures.length === 0) {
        return yield* new CadReviewRunError({
          message:
            failureDetails.length > 0
              ? `No baseline CAD screenshots were captured. ${failureDetails.join("; ")}`
              : "No baseline CAD screenshots were captured.",
        });
      }
      const artifacts = captures.map((capture, index) =>
        baselineArtifactFromCapture({
          reviewRunId: input.reviewRunId,
          index,
          view: capture.view,
          absolutePath: capture.result.absolutePath,
          createdAt: capture.createdAt,
        }),
      );
      const toolCalls = toolCallsFromActivities({
        reviewRunId: input.reviewRunId,
        persona: "synthesis",
        phase: "baseline",
        activities: captures.map((capture) => capture.activity),
        artifacts,
      });
      return { artifacts, toolCalls };
    });

    return cadViewScheduler.enqueue(
      input.thread.id,
      `${input.reviewRunId}:baseline-capture`,
      Effect.exit(operation).pipe(
        Effect.map((exit): BaselineCaptureResult => {
          if (Exit.isFailure(exit)) {
            const error = userVisibleCauseMessage(exit.cause);
            if (isUnsupportedCodexCadScreenshotExportRootError(error)) {
              return {
                ok: true,
                skipped: true,
                skipReason: error,
                artifacts: [],
                toolCalls: [],
              };
            }
            return {
              ok: false,
              error,
            };
          }
          return {
            ok: true,
            skipped: false,
            ...exit.value,
          };
        }),
      ),
    );
  };

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
    readonly phase: CadReviewChildPhase;
    readonly title: string;
    readonly interactionMode?: OrchestrationThread["interactionMode"];
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
        title: childReviewThreadInitialTitle(input.title),
        ...(input.parentThread.externalContext !== null
          ? { externalContext: input.parentThread.externalContext }
          : {}),
        modelSelection: input.parentThread.modelSelection,
        runtimeMode: input.parentThread.runtimeMode,
        interactionMode: input.interactionMode ?? input.parentThread.interactionMode,
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
          phase: input.phase,
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
          phase: input.phase,
          childThreadId,
        },
        createdAt: input.createdAt,
      });
      return childThreadId;
    });

  const stopChildSessions = (input: {
    readonly childThreadIds: ReadonlySet<ThreadId>;
    readonly reviewRunId: string;
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      for (const childThreadId of input.childThreadIds) {
        yield* orchestrationEngine
          .dispatch({
            type: "thread.session.stop",
            commandId: serverCommandId("cad-review-stop-child-session"),
            threadId: childThreadId,
            createdAt: input.createdAt,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to stop CAD review child thread", {
                threadId: childThreadId,
                reviewRunId: input.reviewRunId,
                cause: Cause.pretty(cause),
              }),
            ),
          );
      }
      return input.childThreadIds.size;
    });

  const stopChildSessionsForReview = (input: {
    readonly thread: OrchestrationThread;
    readonly reviewRunId: string;
    readonly createdAt: string;
    readonly activeChildThreadIds?: ReadonlySet<ThreadId>;
  }) => {
    const childThreadIds = new Set(input.activeChildThreadIds ?? []);
    for (const childThreadId of reviewChildThreadIdsFromActivities(
      input.thread,
      input.reviewRunId,
    )) {
      childThreadIds.add(childThreadId);
    }
    return stopChildSessions({
      childThreadIds,
      reviewRunId: input.reviewRunId,
      createdAt: input.createdAt,
    });
  };

  const stopLiveChildSessionsForInactiveReview = (input: {
    readonly thread: OrchestrationThread;
    readonly reviewRunId: string;
    readonly liveThreadIds: ReadonlySet<ThreadId>;
    readonly createdAt: string;
  }) => {
    const childThreadIds = new Set<ThreadId>();
    for (const childThreadId of reviewChildThreadIdsFromActivities(
      input.thread,
      input.reviewRunId,
    )) {
      if (input.liveThreadIds.has(childThreadId)) {
        childThreadIds.add(childThreadId);
      }
    }
    return stopChildSessions({
      childThreadIds,
      reviewRunId: input.reviewRunId,
      createdAt: input.createdAt,
    });
  };

  const waitForChildTurn = (
    childThreadId: ThreadId,
    completion: ChildTurnCompletion,
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
      const hasCompleteStructuredOutput = completion.isComplete(childThread);
      const hasAssistantMessage = childThreadHasCompletedAssistantMessage(childThread);
      const hasAssistantOutput = childThreadHasAssistantOutput(childThread);
      const sessionStatus = childThread.session?.status;
      const pendingInteractivePrompt = firstPendingInteractiveChildPrompt(childThread.activities);
      if (pendingInteractivePrompt) {
        return yield* new CadReviewRunError({
          message: `Child reviewer '${childThreadId}' requested ${pendingInteractivePrompt.kind} '${pendingInteractivePrompt.requestId}'${
            pendingInteractivePrompt.detail ? ` (${pendingInteractivePrompt.detail})` : ""
          }. Hidden CAD review child threads cannot wait for interactive prompts.`,
        });
      }
      if (hasCompleteStructuredOutput) {
        return childThread;
      }
      if (sessionStatus === "error" && childThread.session?.lastError) {
        return yield* new CadReviewRunError({ message: childThread.session.lastError });
      }
      if (sessionStatus === "ready" && hasAssistantMessage) {
        return yield* new CadReviewRunError({
          message: `Child reviewer '${childThreadId}' finished without complete ${completion.label} structured output.`,
        });
      }
      if (
        sessionStatus === "error" ||
        sessionStatus === "interrupted" ||
        sessionStatus === "stopped"
      ) {
        return yield* new CadReviewRunError({
          message: `Child reviewer '${childThreadId}' was ${sessionStatus}.`,
        });
      }
      const nowMs = yield* Clock.currentTimeMillis;
      const blockingRetry = blockingProviderRetryWarning({
        activities: childThread.activities,
        nowMs,
      });
      if (!hasAssistantOutput && blockingRetry) {
        return yield* new CadReviewRunError({
          message: `Child reviewer '${childThreadId}' is blocked by provider retry: ${blockingRetry}`,
        });
      }
      if (
        childThreadStartupNoProgressTimedOut({
          childThread,
          nowMs,
        })
      ) {
        return yield* new CadReviewRunError({
          message: `Child reviewer '${childThreadId}' produced no visible output or tool activity within 5 minutes.`,
        });
      }
      if (
        childThreadProgressStalledTimedOut({
          childThread,
          nowMs,
        })
      ) {
        return yield* new CadReviewRunError({
          message: `Child reviewer '${childThreadId}' stopped producing output or tool activity for 3 minutes.`,
        });
      }
      yield* Effect.sleep(Duration.seconds(1));
      return yield* waitForChildTurn(childThreadId, completion);
    });

  const runChildReviewer = (input: {
    readonly parentThread: OrchestrationThread;
    readonly reviewRunId: string;
    readonly persona: CadReviewPersona;
    readonly phase: CadReviewChildPhase;
    readonly title: string;
    readonly prompt: string;
    readonly interactionMode?: OrchestrationThread["interactionMode"];
    readonly completion: ChildTurnCompletion;
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      const activeReview = getActiveReview(input.parentThread.id, input.reviewRunId);
      yield* failIfReviewStopped(input.parentThread.id, input.reviewRunId);
      const childThreadId = yield* createChildThread(input);
      activeReview.childThreadIds.add(childThreadId);
      return yield* Effect.gen(function* () {
        yield* failIfReviewStopped(input.parentThread.id, input.reviewRunId);
        yield* orchestrationEngine.dispatch({
          type: "thread.turn.start",
          commandId: serverCommandId("cad-review-child-turn"),
          threadId: childThreadId,
          message: {
            messageId: cadReviewChildPromptMessageId(childThreadId),
            role: "user",
            text: input.prompt,
            attachments: [],
          },
          modelSelection: input.parentThread.modelSelection,
          runtimeMode: input.parentThread.runtimeMode,
          interactionMode: input.interactionMode ?? input.parentThread.interactionMode,
          titleSeed: childReviewThreadInitialTitle(input.title),
          createdAt: input.createdAt,
        });
        const completedExit = yield* waitForChildTurn(childThreadId, input.completion).pipe(
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
          Effect.exit,
        );
        if (Exit.isFailure(completedExit)) {
          const childThreadOption = yield* projectionSnapshotQuery
            .getThreadDetailById(childThreadId)
            .pipe(Effect.exit);
          return {
            ok: false,
            error: userVisibleCauseMessage(completedExit.cause),
            ...(Exit.isSuccess(childThreadOption) && Option.isSome(childThreadOption.value)
              ? { childThread: childThreadOption.value.value }
              : {}),
          } satisfies ChildRunResult;
        }
        const completed = completedExit.value;
        if (completed.session?.status === "running") {
          yield* orchestrationEngine
            .dispatch({
              type: "thread.session.stop",
              commandId: serverCommandId("cad-review-completed-child-stop"),
              threadId: childThreadId,
              createdAt: yield* nowIso,
            })
            .pipe(Effect.ignore);
        }
        yield* failIfReviewStopped(input.parentThread.id, input.reviewRunId);
        return { ok: true, childThread: completed } satisfies ChildRunResult;
      }).pipe(
        Effect.ensuring(Effect.sync(() => activeReview.childThreadIds.delete(childThreadId))),
      );
    }).pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          Effect.succeed({
            ok: false,
            error: userVisibleCauseMessage(cause),
          } satisfies ChildRunResult),
        onSuccess: (result) => Effect.succeed(result),
      }),
    );

  const artifactsFromChild = (input: {
    readonly reviewRunId: string;
    readonly childThread: OrchestrationThread;
    readonly scope: "baseline" | "persona";
    readonly persona?: CadReviewPersona;
    readonly createdAt: string;
  }): CadReviewEvidenceArtifact[] => {
    const paths = extractExportedScreenshotPaths(input.childThread.activities);
    const pathArtifacts = paths.map((path, index) => {
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
    const mechbaseArtifacts = extractFetchedMechbaseArtifactUrls(input.childThread.activities).map(
      (url, index) => {
        const artifact: CadReviewEvidenceArtifact = {
          id: `${input.reviewRunId}:${input.scope}:${input.persona ?? "baseline"}:mechbase:${
            index + 1
          }`,
          scope: input.scope,
          viewName: "Mechbase precedent image",
          artifactUri: url,
          status: "captured",
          createdAt: input.createdAt,
        };
        if (input.persona !== undefined) {
          return Object.assign(artifact, { persona: input.persona });
        }
        return artifact;
      },
    );
    return [...pathArtifacts, ...mechbaseArtifacts];
  };

  const generateReview: CadReviewServiceShape["generateReview"] = (event) => {
    let activeThreadForFailure: OrchestrationThread | undefined;
    let activeReviewForFailure: CadReviewReport | undefined;

    const failActiveReview = (cause: Cause.Cause<unknown>) =>
      Effect.gen(function* () {
        if (!activeThreadForFailure || !activeReviewForFailure) {
          return;
        }
        const detail = userVisibleCauseMessage(cause);
        const failedAt = yield* nowIso;
        const failedReview: CadReviewReport = {
          ...activeReviewForFailure,
          status: "failed",
          activePersona: undefined,
          error: `CAD review failed: ${detail}`,
          updatedAt: failedAt,
        };
        yield* appendActivity({
          threadId: activeThreadForFailure.id,
          tone: "error",
          kind: "cad-review.failed",
          summary: "CAD review failed",
          payload: {
            reviewRunId: failedReview.id,
            phase: failedReview.status,
            detail,
          },
          createdAt: failedAt,
        });
        yield* upsertReview(activeThreadForFailure.id, failedReview);
      });

    return Effect.gen(function* () {
      const threadOption = yield* projectionSnapshotQuery.getThreadDetailById(
        event.payload.threadId,
      );
      if (Option.isNone(threadOption)) {
        return;
      }
      const thread = event.payload.modelSelection
        ? { ...threadOption.value, modelSelection: event.payload.modelSelection }
        : threadOption.value;
      activeThreadForFailure = thread;
      getActiveReview(thread.id, event.payload.reviewRunId).stopped = false;
      const snapshot = yield* projectionSnapshotQuery.getCommandReadModel();
      const projectTitle = snapshot.projects.find(
        (project) => project.id === thread.projectId,
      )?.title;
      const subject = reviewSubject(thread, projectTitle);
      const reviewPrompt = trimText(event.payload.reviewPrompt);
      const createdAt = event.payload.createdAt;
      let updatedAt = yield* nowIso;

      let review: CadReviewReport = {
        id: event.payload.reviewRunId,
        threadId: thread.id,
        title: reviewTitle(thread, projectTitle),
        status: "planning",
        activePersona: "synthesis",
        whatIsBeingReviewed: subject,
        ...(reviewPrompt ? { reviewPrompt } : {}),
        commonThemes: [],
        positiveSignals: [],
        reviewerTraits: REVIEWER_TRAIT_SUMMARIES,
        personaReports: [],
        deepDiveReports: [],
        mergedActionItems: [],
        evidenceArtifacts: [],
        toolCallsByReviewer: {
          systems_integration: [],
          program_readiness: [],
          mechanical_robustness: [],
          synthesis: [],
        },
        outputTokensByStep: {},
        createdAt,
        updatedAt,
      };
      activeReviewForFailure = review;

      yield* appendActivity({
        threadId: thread.id,
        tone: "info",
        kind: "cad-review.requested",
        summary: `CAD review requested for ${subject}`,
        payload: {
          reviewRunId: review.id,
          phase: "requested",
          ...(reviewPrompt ? { reviewPrompt } : {}),
        },
        createdAt,
      });
      yield* upsertReview(thread.id, review);
      yield* failIfReviewStopped(thread.id, review.id);

      updatedAt = yield* nowIso;
      Object.assign(review, { updatedAt });
      yield* upsertReview(thread.id, review);
      yield* appendActivity({
        threadId: thread.id,
        tone: "info",
        kind: "cad-review.planning.started",
        summary: "CAD review mechanism planning started",
        payload: {
          reviewRunId: review.id,
          phase: "planning",
          agent: "mechanism planning",
        },
        createdAt: updatedAt,
      });

      const baselineArtifacts = review.evidenceArtifacts.filter(
        (artifact) => artifact.scope === "baseline",
      );
      const planningChild = yield* runChildReviewer({
        parentThread: thread,
        reviewRunId: review.id,
        persona: "synthesis",
        phase: "planning",
        title: `${review.title} - mechanism planning`,
        interactionMode: "plan",
        prompt: buildMechanismPlanningPrompt({
          subject,
          reviewPrompt,
          baselineArtifacts,
        }),
        completion: {
          label: "mechanism planning JSON",
          isComplete: (childThread) =>
            assistantOutputIsReady(childThread, mechanismPlanOutputIsReady),
        },
        createdAt: updatedAt,
      });
      const planningAt = yield* nowIso;
      yield* failIfReviewStopped(thread.id, review.id);
      if (planningChild.ok) {
        const planningArtifacts = artifactsFromChild({
          reviewRunId: review.id,
          childThread: planningChild.childThread,
          scope: "persona",
          persona: "synthesis",
          createdAt: planningAt,
        });
        const planningToolCalls = toolCallsFromActivities({
          reviewRunId: review.id,
          persona: "synthesis",
          phase: "planning",
          activities: planningChild.childThread.activities,
          artifacts: [...review.evidenceArtifacts, ...planningArtifacts],
        });
        Object.assign(review, {
          reviewPlan: buildMechanismPlan(assistantText(planningChild.childThread.messages)),
          evidenceArtifacts: [...review.evidenceArtifacts, ...planningArtifacts],
          toolCallsByReviewer: {
            ...review.toolCallsByReviewer,
            synthesis: [...review.toolCallsByReviewer.synthesis, ...planningToolCalls],
          },
          ...withChildOutputTokens(review, "planning", planningChild.childThread),
          updatedAt: planningAt,
        });
      }
      yield* appendActivity({
        threadId: thread.id,
        tone: planningChild.ok ? "info" : "error",
        kind: planningChild.ok ? "cad-review.planning.completed" : "cad-review.planning.failed",
        summary: planningChild.ok
          ? "CAD review mechanism planning completed"
          : "CAD review mechanism planning failed; continuing with persona passes",
        payload: {
          reviewRunId: review.id,
          phase: "planning",
          agent: "mechanism planning",
          ...(planningChild.ok ? { childThreadId: planningChild.childThread.id } : {}),
          ...(planningChild.ok ? {} : { detail: planningChild.error }),
        },
        createdAt: planningAt,
      });
      yield* upsertReview(thread.id, review);
      yield* failIfReviewStopped(thread.id, review.id);

      if (planRequiresBaseline(review.reviewPlan)) {
        updatedAt = yield* nowIso;
        Object.assign(review, {
          status: "capturing-baseline",
          activePersona: "synthesis",
          updatedAt,
        });
        yield* upsertReview(thread.id, review);
        const baselineCapture = yield* captureBaselineEvidence({
          thread,
          reviewRunId: review.id,
        });
        yield* failIfReviewStopped(thread.id, review.id);
        updatedAt = yield* nowIso;
        if (baselineCapture.ok) {
          Object.assign(review, {
            evidenceArtifacts: [...review.evidenceArtifacts, ...baselineCapture.artifacts],
            toolCallsByReviewer: {
              ...review.toolCallsByReviewer,
              synthesis: [...review.toolCallsByReviewer.synthesis, ...baselineCapture.toolCalls],
            },
            updatedAt,
          });
          const baselineSkipped = baselineCapture.skipped;
          const baselineSummary = baselineSkipped
            ? "Baseline CAD capture skipped"
            : baselineCapture.artifacts.length > 0
              ? "Baseline CAD views captured"
              : "Baseline capture completed without screenshot artifacts";
          yield* appendActivity({
            threadId: thread.id,
            tone: "info",
            kind: baselineSkipped ? "cad-review.baseline.skipped" : "cad-review.baseline.completed",
            summary: baselineSummary,
            payload: {
              reviewRunId: review.id,
              phase: "baseline",
              agent: "Server baseline capture",
              artifactCount: baselineCapture.artifacts.length,
              ...(baselineSkipped ? { reason: baselineCapture.skipReason } : {}),
            },
            createdAt: updatedAt,
          });
        } else {
          Object.assign(review, {
            status: "failed",
            activePersona: undefined,
            error: `Baseline capture failed: ${baselineCapture.error}`,
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
              detail: baselineCapture.error,
            },
            createdAt: updatedAt,
          });
          yield* upsertReview(thread.id, review);
          return;
        }
        yield* upsertReview(thread.id, review);
        yield* failIfReviewStopped(thread.id, review.id);
      } else {
        updatedAt = yield* nowIso;
        yield* appendActivity({
          threadId: thread.id,
          tone: "info",
          kind: "cad-review.baseline.skipped",
          summary: "Baseline CAD capture skipped by planning",
          payload: {
            reviewRunId: review.id,
            phase: "baseline",
            agent: "mechanism planning",
            reason:
              review.reviewPlan?.baselineReason ||
              "Planner determined the standard baseline screenshot pass was not required.",
          },
          createdAt: updatedAt,
        });
      }

      updatedAt = yield* nowIso;
      Object.assign(review, { status: "reviewing", activePersona: undefined, updatedAt });
      yield* upsertReview(thread.id, review);
      const reviewerStarts = [];
      for (const persona of PERSONAS) {
        const selection = (
          review.reviewPlan?.reviewerSelection ??
          allReviewerSelection(
            "Planner did not produce a reviewer selection, so CadSense ran all reviewers.",
          )
        ).find((entry) => entry.persona === persona);
        if (selection && !selection.enabled) {
          yield* appendActivity({
            threadId: thread.id,
            tone: "info",
            kind: "cad-review.persona.skipped",
            summary: `${persona} reviewer skipped by planning`,
            payload: {
              reviewRunId: review.id,
              phase: "reviewing",
              agent: `${persona} reviewer`,
              persona,
              reason: selection.reason,
            },
            createdAt: updatedAt,
          });
          continue;
        }
        updatedAt = yield* nowIso;
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
        reviewerStarts.push({ persona, startedAt: updatedAt });
      }

      const reviewerBaselineArtifacts = review.evidenceArtifacts.filter(
        (artifact) => artifact.scope === "baseline",
      );
      const personaRuns = yield* Effect.forEach(
        reviewerStarts,
        ({ persona, startedAt }) =>
          runChildReviewer({
            parentThread: thread,
            reviewRunId: review.id,
            persona,
            phase: "reviewing",
            title: `${review.title} - ${personaLabel(persona)}`,
            prompt: buildReviewerPrompt({
              persona,
              subject,
              reviewPrompt,
              baselineArtifacts: reviewerBaselineArtifacts,
              reviewPlan: review.reviewPlan,
            }),
            completion: {
              label: `${personaLabel(persona)} reviewer JSON`,
              isComplete: (childThread) =>
                assistantOutputIsReady(childThread, personaReviewOutputIsReady),
            },
            createdAt: startedAt,
          }).pipe(Effect.map((personaChild) => ({ persona, personaChild }))),
        { concurrency: reviewerConcurrencyForThread(thread, reviewerStarts.length) },
      );
      yield* failIfReviewStopped(thread.id, review.id);

      for (const { persona, personaChild } of personaRuns) {
        yield* failIfReviewStopped(thread.id, review.id);
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
            ...withChildOutputTokens(review, persona, personaChild.childThread),
            updatedAt: reportAt,
          });
        } else {
          const failedChildThread =
            "childThread" in personaChild ? personaChild.childThread : undefined;
          if (failedChildThread && extractJsonObject(assistantText(failedChildThread.messages))) {
            const personaArtifacts = artifactsFromChild({
              reviewRunId: review.id,
              childThread: failedChildThread,
              scope: "persona",
              persona,
              createdAt: reportAt,
            });
            const nextArtifacts = [...review.evidenceArtifacts, ...personaArtifacts];
            const toolCalls = toolCallsFromActivities({
              reviewRunId: review.id,
              persona,
              phase: "reviewing",
              activities: failedChildThread.activities,
              artifacts: nextArtifacts,
            });
            const report = buildPersonaReport({
              reviewRunId: review.id,
              persona,
              text: assistantText(failedChildThread.messages),
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
              ...withChildOutputTokens(review, persona, failedChildThread),
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
      yield* failIfReviewStopped(thread.id, review.id);

      const deepDiveFindings = selectDeepDiveFindings(
        review.personaReports.filter((report) => report.status === "completed"),
      );
      if (deepDiveFindings.length > 0) {
        updatedAt = yield* nowIso;
        Object.assign(review, { status: "deep-diving", activePersona: "synthesis", updatedAt });
        yield* upsertReview(thread.id, review);
        yield* appendActivity({
          threadId: thread.id,
          tone: "info",
          kind: "cad-review.deep-dive.started",
          summary: "CAD review focused deep dive started",
          payload: {
            reviewRunId: review.id,
            phase: "deep-dive",
            agent: "focused deep dive",
            findingIds: deepDiveFindings.map((finding) => finding.id),
          },
          createdAt: updatedAt,
        });
        const deepDiveChild = yield* runChildReviewer({
          parentThread: thread,
          reviewRunId: review.id,
          persona: "synthesis",
          phase: "deep-dive",
          title: `${review.title} - focused deep dive`,
          prompt: buildDeepDivePrompt({
            subject,
            reviewPrompt,
            reviewPlan: review.reviewPlan,
            findings: deepDiveFindings,
            baselineArtifacts: review.evidenceArtifacts.filter(
              (artifact) => artifact.scope === "baseline",
            ),
          }),
          completion: {
            label: "focused deep-dive JSON",
            isComplete: (childThread) => assistantOutputIsReady(childThread, deepDiveOutputIsReady),
          },
          createdAt: updatedAt,
        });
        const deepDiveAt = yield* nowIso;
        yield* failIfReviewStopped(thread.id, review.id);
        if (deepDiveChild.ok) {
          const deepDiveArtifacts = artifactsFromChild({
            reviewRunId: review.id,
            childThread: deepDiveChild.childThread,
            scope: "persona",
            persona: "synthesis",
            createdAt: deepDiveAt,
          });
          const deepDiveToolCalls = toolCallsFromActivities({
            reviewRunId: review.id,
            persona: "synthesis",
            phase: "deep-dive",
            activities: deepDiveChild.childThread.activities,
            artifacts: [...review.evidenceArtifacts, ...deepDiveArtifacts],
          });
          const nextArtifacts = [...review.evidenceArtifacts, ...deepDiveArtifacts];
          const deepDiveReport = buildDeepDiveReport({
            reviewRunId: review.id,
            text: assistantText(deepDiveChild.childThread.messages),
            findings: deepDiveFindings,
            artifacts: nextArtifacts,
            toolCalls: deepDiveToolCalls,
            createdAt: deepDiveAt,
          });
          Object.assign(review, {
            evidenceArtifacts: nextArtifacts,
            deepDiveReports: [...(review.deepDiveReports ?? []), deepDiveReport],
            toolCallsByReviewer: {
              ...review.toolCallsByReviewer,
              synthesis: [...review.toolCallsByReviewer.synthesis, ...deepDiveToolCalls],
            },
            ...withChildOutputTokens(review, "deep_diving", deepDiveChild.childThread),
            updatedAt: deepDiveAt,
          });
        } else if ("childThread" in deepDiveChild && deepDiveChild.childThread) {
          Object.assign(review, {
            ...withChildOutputTokens(review, "deep_diving", deepDiveChild.childThread),
            updatedAt: deepDiveAt,
          });
        }
        yield* appendActivity({
          threadId: thread.id,
          tone: deepDiveChild.ok ? "info" : "error",
          kind: deepDiveChild.ok ? "cad-review.deep-dive.completed" : "cad-review.deep-dive.failed",
          summary: deepDiveChild.ok
            ? "CAD review focused deep dive completed"
            : "CAD review focused deep dive failed; continuing to synthesis",
          payload: {
            reviewRunId: review.id,
            phase: "deep-dive",
            agent: "focused deep dive",
            ...(deepDiveChild.ok ? { childThreadId: deepDiveChild.childThread.id } : {}),
            ...(deepDiveChild.ok ? {} : { detail: deepDiveChild.error }),
          },
          createdAt: deepDiveAt,
        });
        yield* upsertReview(thread.id, review);
      }
      yield* failIfReviewStopped(thread.id, review.id);

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
              phase: "synthesis",
              title: `${review.title} - synthesis`,
              prompt: buildSynthesisPrompt({
                subject,
                reviewPrompt,
                reports: review.personaReports,
                reviewPlan: review.reviewPlan,
                deepDiveReports: (review.deepDiveReports ?? []).map((report) => ({
                  focus: report.focus,
                  summary: report.summary,
                  sourceFindingIds: report.sourceFindingIds,
                  observations: report.observations,
                  specificChecks: report.specificChecks,
                  recommendedChanges: report.recommendedChanges,
                  confidence: report.confidence,
                })),
              }),
              completion: {
                label: "synthesis JSON",
                isComplete: (childThread) =>
                  assistantOutputIsReady(childThread, synthesisOutputIsReady),
              },
              createdAt: updatedAt,
            })
          : null;
      const synthesisText = synthesisChild?.ok
        ? assistantText(synthesisChild.childThread.messages)
        : "";
      yield* failIfReviewStopped(thread.id, review.id);
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
        deepDiveReports: review.deepDiveReports ?? [],
        synthesisText,
      });
      const failedReports = review.personaReports.filter((report) => report.status === "failed");
      updatedAt = yield* nowIso;
      Object.assign(review, {
        status:
          completedReports.length === 0
            ? "failed"
            : failedReports.length > 0
              ? "partial"
              : "completed",
        activePersona: undefined,
        commonThemes: synthesized.commonThemes,
        positiveSignals: synthesized.positiveSignals,
        mergedActionItems: synthesized.actionItems,
        evidenceArtifacts: [...review.evidenceArtifacts, ...synthesisArtifacts],
        toolCallsByReviewer: {
          ...review.toolCallsByReviewer,
          synthesis: [...review.toolCallsByReviewer.synthesis, ...synthesisToolCalls],
        },
        ...(synthesisChild?.ok
          ? withChildOutputTokens(review, "synthesizing", synthesisChild.childThread)
          : {}),
        updatedAt,
      });
      yield* appendActivity({
        threadId: thread.id,
        tone: "info",
        kind:
          synthesisChild?.ok === false
            ? "cad-review.synthesis.fallback"
            : "cad-review.synthesis.completed",
        summary:
          synthesisChild?.ok === false
            ? "CAD review synthesis agent failed; server fallback completed"
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
        Effect.logWarning("cad review generation failed", { cause: Cause.pretty(cause) }).pipe(
          Effect.flatMap(() =>
            isReviewStopped(event.payload.threadId, event.payload.reviewRunId)
              ? Effect.void
              : isCadReviewActive(activeReviewForFailure?.status ?? "failed")
                ? failActiveReview(cause).pipe(
                    Effect.catchCause((upsertCause) =>
                      Effect.logWarning("failed to mark interrupted CAD review as failed", {
                        cause: Cause.pretty(upsertCause),
                      }),
                    ),
                  )
                : Effect.void,
          ),
        ),
      ),
      Effect.ensuring(
        Effect.sync(() =>
          activeReviews.delete(reviewKey(event.payload.threadId, event.payload.reviewRunId)),
        ),
      ),
    );
  };

  const stopReview: CadReviewServiceShape["stopReview"] = (event) =>
    Effect.gen(function* () {
      const { threadId, reviewRunId, createdAt } = event.payload;
      const activeReview = getActiveReview(threadId, reviewRunId);
      activeReview.stopped = true;
      const interruptedScreenshotCount = rejectCadScreenshotPendingForThread(
        threadId,
        "CAD review stopped by user.",
      );
      const threadOption = yield* projectionSnapshotQuery
        .getThreadDetailById(threadId)
        .pipe(Effect.catch(() => Effect.succeed(Option.none())));
      if (Option.isSome(threadOption)) {
        const review = (threadOption.value.reviews ?? []).find((entry) => entry.id === reviewRunId);
        if (review && isCadReviewActive(review.status)) {
          yield* upsertReview(threadId, {
            ...review,
            status: "failed",
            activePersona: undefined,
            error: "CAD review stopped by user.",
            updatedAt: createdAt,
          });
        }
      }
      let interruptedChildThreadCount = activeReview.childThreadIds.size;
      if (Option.isSome(threadOption)) {
        interruptedChildThreadCount = yield* stopChildSessionsForReview({
          thread: threadOption.value,
          reviewRunId,
          createdAt,
          activeChildThreadIds: activeReview.childThreadIds,
        });
      } else {
        yield* stopChildSessions({
          childThreadIds: activeReview.childThreadIds,
          reviewRunId,
          createdAt,
        });
      }
      if (Option.isNone(threadOption)) {
        return;
      }
      yield* appendActivity({
        threadId,
        tone: "error",
        kind: "cad-review.stopped",
        summary: "CAD review stopped",
        payload: {
          reviewRunId,
          interruptedScreenshotCount,
          interruptedChildThreadCount,
        },
        createdAt,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to stop CAD review", { cause: Cause.pretty(cause) }),
      ),
    );

  const recoverInterruptedReviews: CadReviewServiceShape["recoverInterruptedReviews"] = () =>
    Effect.gen(function* () {
      const snapshot = yield* projectionSnapshotQuery.getSnapshot();
      const threadById = new Map(snapshot.threads.map((thread) => [thread.id, thread]));
      const liveThreadIds = new Set(
        snapshot.threads
          .filter((thread) => thread.session && thread.session.status !== "stopped")
          .map((thread) => thread.id),
      );
      for (const thread of snapshot.threads) {
        for (const review of thread.reviews ?? []) {
          if (!isCadReviewActive(review.status)) {
            if (review.status === "failed" || review.status === "partial") {
              const recoveredAt = yield* nowIso;
              const interruptedChildThreadCount = yield* stopLiveChildSessionsForInactiveReview({
                thread,
                reviewRunId: review.id,
                liveThreadIds,
                createdAt: recoveredAt,
              });
              if (interruptedChildThreadCount > 0) {
                yield* appendActivity({
                  threadId: thread.id,
                  tone: "error",
                  kind: "cad-review.child-sessions-recovered",
                  summary: "Interrupted CAD review child sessions stopped",
                  payload: {
                    reviewRunId: review.id,
                    status: review.status,
                    interruptedChildThreadCount,
                  },
                  createdAt: recoveredAt,
                });
              }
            }
            continue;
          }
          const failedAt = yield* nowIso;
          const threadOption = yield* projectionSnapshotQuery
            .getThreadDetailById(thread.id)
            .pipe(Effect.catch(() => Effect.succeed(Option.none())));
          const currentThread = Option.isSome(threadOption) ? threadOption.value : thread;
          const currentReview =
            (currentThread.reviews ?? []).find((entry) => entry.id === review.id) ?? review;
          const failedAtMs = Date.parse(failedAt);
          const childThreadIds = reviewChildThreadIdsFromActivities(currentThread, review.id);
          const hasChildThreads = childThreadIds.length > 0;
          const hasFreshLiveChildSession = hasFreshLiveChildSessionForReview({
            thread: currentThread,
            reviewRunId: review.id,
            threadById,
            now: failedAt,
          });
          if (
            !isCadReviewActive(currentReview.status) ||
            hasInterruptedRecoveryActivity(currentThread, review.id) ||
            (Number.isFinite(failedAtMs) &&
              !hasChildThreads &&
              isFreshActiveReview(
                currentReview,
                failedAtMs,
                CHILD_TURN_STARTUP_NO_PROGRESS_TIMEOUT_MS,
              )) ||
            hasFreshLiveChildSession
          ) {
            continue;
          }
          const interruptedChildThreadCount = yield* stopChildSessionsForReview({
            thread: currentThread,
            reviewRunId: review.id,
            createdAt: failedAt,
          });
          const failedReview: CadReviewReport = {
            ...currentReview,
            status: "failed",
            activePersona: undefined,
            error:
              currentReview.error ??
              "CAD review was interrupted before it completed. Start a new CAD review to run it again.",
            updatedAt: failedAt,
          };
          yield* appendActivity({
            threadId: thread.id,
            tone: "error",
            kind: "cad-review.interrupted-recovered",
            summary: "Interrupted CAD review marked failed",
            payload: {
              reviewRunId: review.id,
              previousStatus: review.status,
              interruptedChildThreadCount,
            },
            createdAt: failedAt,
          });
          yield* upsertReview(thread.id, failedReview);
        }
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to recover interrupted CAD reviews", {
          cause: Cause.pretty(cause),
        }),
      ),
    );

  return { generateReview, stopReview, recoverInterruptedReviews } satisfies CadReviewServiceShape;
});

export const CadReviewServiceLive = Layer.effect(CadReviewService, make);
