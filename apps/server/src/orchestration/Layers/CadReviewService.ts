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
  type CadReviewStatus,
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
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { captureCadScreenshot } from "../../cad/CadScreenshotClient.ts";
import { resolveCadViewExportRootForInstance } from "../../cad/CadViewExportRoot.ts";
import { CadViewScheduler } from "../../cad/CadViewScheduler.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { CadReviewService, type CadReviewServiceShape } from "../Services/CadReviewService.ts";
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
const REVIEWER_TURN_TIMEOUT = Duration.minutes(10);
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
  | { readonly ok: false; readonly error: string };

interface BaselineCaptureRecord {
  readonly result: CadScreenshotCaptureHttpResult;
  readonly view: CadView;
  readonly createdAt: string;
  readonly activity: OrchestrationThreadActivity;
}

function isCadReviewActive(status: CadReviewStatus): boolean {
  return CAD_REVIEW_ACTIVE_STATUSES.has(status);
}

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

function buildMechanismPlan(text: string): CadReviewMechanismPlan | undefined {
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
    mechanisms,
    reviewPriorities: stringArrayFromUnknown(parsed.reviewPriorities),
    missingContext: stringArrayFromUnknown(parsed.missingContext),
    calculatorNeeds: stringArrayFromUnknown(parsed.calculatorNeeds),
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
              fallback: evidenceArtifactIds,
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
  const parsedConfidence = confidenceValue(parsed?.confidence);

  return {
    persona: input.persona,
    status: "completed",
    summary: trimText(parsed?.summary) ?? truncate(input.text || "Reviewer completed."),
    topConcerns,
    repeatedPatterns: stringArray(parsed?.repeatedPatterns),
    likelyFailureModes: stringArray(parsed?.likelyFailureModes),
    recommendedChanges: stringArray(parsed?.recommendedChanges),
    confidence:
      parsedConfidence ??
      (topConcerns.some((finding) => finding.confidence === "low") ? "low" : "medium"),
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
          const actionItem: CadReviewActionItem = {
            id: `${input.reviewRunId}:action:${index + 1}`,
            title: trimText(entry.title) ?? `Action item ${index + 1}`,
            description:
              trimText(entry.description) ??
              trimText(entry.detail) ??
              "Follow up on the linked CAD review findings.",
            priority: priorityValue(entry.priority) ?? "medium",
            sourceFindingIds: stringArray(entry.sourceFindingIds),
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
  return { commonThemes, actionItems };
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const cadViewScheduler = yield* CadViewScheduler;
  const pathService = yield* Path.Path;
  const serverSettingsService = yield* ServerSettingsService;

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
  }) =>
    cadViewScheduler.enqueue(
      input.thread.id,
      `${input.reviewRunId}:baseline-capture`,
      Effect.gen(function* () {
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
          if (Exit.isFailure(captureExit)) {
            const detail = Cause.pretty(captureExit.cause);
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
      }).pipe(
        Effect.matchCauseEffect({
          onFailure: (cause) =>
            Effect.succeed({
              ok: false,
              error: Cause.pretty(cause),
            } satisfies { readonly ok: false; readonly error: string }),
          onSuccess: (result) =>
            Effect.succeed({
              ok: true,
              ...result,
            } satisfies {
              readonly ok: true;
              readonly artifacts: CadReviewEvidenceArtifact[];
              readonly toolCalls: CadReviewToolCall[];
            }),
        }),
      ),
    );

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

  const generateReview: CadReviewServiceShape["generateReview"] = (event) => {
    let activeThreadForFailure: OrchestrationThread | undefined;
    let activeReviewForFailure: CadReviewReport | undefined;

    const failActiveReview = (cause: Cause.Cause<unknown>) =>
      Effect.gen(function* () {
        if (!activeThreadForFailure || !activeReviewForFailure) {
          return;
        }
        const detail = Cause.pretty(cause);
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
      const thread = threadOption.value;
      activeThreadForFailure = thread;
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
        deepDiveReports: [],
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
      activeReviewForFailure = review;

      yield* appendActivity({
        threadId: thread.id,
        tone: "info",
        kind: "cad-review.requested",
        summary: `CAD review requested for ${subject}`,
        payload: { reviewRunId: review.id, phase: "requested" },
        createdAt,
      });
      yield* upsertReview(thread.id, review);

      const baselineCapture = yield* captureBaselineEvidence({
        thread,
        reviewRunId: review.id,
      });
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
        yield* appendActivity({
          threadId: thread.id,
          tone: "info",
          kind: "cad-review.baseline.completed",
          summary:
            baselineCapture.artifacts.length > 0
              ? "Baseline CAD views captured"
              : "Baseline capture completed without screenshot artifacts",
          payload: {
            reviewRunId: review.id,
            phase: "baseline",
            agent: "Server baseline capture",
            artifactCount: baselineCapture.artifacts.length,
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

      updatedAt = yield* nowIso;
      Object.assign(review, { status: "planning", activePersona: "synthesis", updatedAt });
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
        title: `${review.title} - mechanism planning`,
        prompt: buildMechanismPlanningPrompt({
          subject,
          baselineArtifacts,
        }),
        createdAt: updatedAt,
      });
      const planningAt = yield* nowIso;
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

      updatedAt = yield* nowIso;
      Object.assign(review, { status: "reviewing", activePersona: undefined, updatedAt });
      yield* upsertReview(thread.id, review);
      const reviewerStarts = [];
      for (const persona of PERSONAS) {
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
            title: `${review.title} - ${personaLabel(persona)}`,
            prompt: buildReviewerPrompt({
              persona,
              subject,
              baselineArtifacts: reviewerBaselineArtifacts,
              reviewPlan: review.reviewPlan,
            }),
            createdAt: startedAt,
          }).pipe(Effect.map((personaChild) => ({ persona, personaChild }))),
        { concurrency: Math.min(CAD_REVIEW_REVIEWER_CONCURRENCY, reviewerStarts.length) },
      );

      for (const { persona, personaChild } of personaRuns) {
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
          title: `${review.title} - focused deep dive`,
          prompt: buildDeepDivePrompt({
            subject,
            reviewPlan: review.reviewPlan,
            findings: deepDiveFindings,
            baselineArtifacts: review.evidenceArtifacts.filter(
              (artifact) => artifact.scope === "baseline",
            ),
          }),
          createdAt: updatedAt,
        });
        const deepDiveAt = yield* nowIso;
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
              prompt: buildSynthesisPrompt({
                subject,
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
        deepDiveReports: review.deepDiveReports ?? [],
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
        Effect.logWarning("cad review generation failed", { cause: Cause.pretty(cause) }).pipe(
          Effect.flatMap(() =>
            isCadReviewActive(activeReviewForFailure?.status ?? "failed")
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
    );
  };

  const recoverInterruptedReviews: CadReviewServiceShape["recoverInterruptedReviews"] = () =>
    Effect.gen(function* () {
      const snapshot = yield* projectionSnapshotQuery.getSnapshot();
      for (const thread of snapshot.threads) {
        for (const review of thread.reviews ?? []) {
          if (!isCadReviewActive(review.status)) {
            continue;
          }
          const failedAt = yield* nowIso;
          const failedReview: CadReviewReport = {
            ...review,
            status: "failed",
            activePersona: undefined,
            error:
              review.error ??
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

  return { generateReview, recoverInterruptedReviews } satisfies CadReviewServiceShape;
});

export const CadReviewServiceLive = Layer.effect(CadReviewService, make);
