import {
  type CadReviewEvidenceArtifact,
  type CadReviewPersona,
  type CadReviewReport,
  type CadReviewToolCall,
  type EnvironmentId,
  type MessageId,
  type ServerProviderSkill,
  type TurnId,
} from "@cadsense/contracts";
import {
  createContext,
  memo,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { deriveTimelineEntries, formatElapsed } from "../../session-logic";
import { type TurnDiffSummary } from "../../types";
import { summarizeTurnDiffStats } from "../../lib/turnDiffTree";
import ChatMarkdown from "../ChatMarkdown";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  EyeIcon,
  GlobeIcon,
  HammerIcon,
  ImageIcon,
  type LucideIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { ChangedFilesTree } from "./ChangedFilesTree";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { MessageCopyButton } from "./MessageCopyButton";
import {
  computeStableMessagesTimelineRows,
  MAX_VISIBLE_WORK_LOG_ENTRIES,
  deriveMessagesTimelineRows,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  type StableMessagesTimelineRowsState,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import { useUiStateStore } from "~/uiStateStore";
import { type TimestampFormat } from "@cadsense/contracts/settings";
import { formatTimestamp } from "../../timestampFormat";

import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "./userMessageTerminalContexts";
import { SkillInlineText } from "./SkillInlineText";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import type { CadReviewChildActivitySummary } from "../../lib/cadAgentViewState";

// ---------------------------------------------------------------------------
// Context — shared state consumed by every row component via Context.
// Propagates through LegendList's memo boundaries for shared callbacks and
// non-row-scoped state. `nowIso` is intentionally excluded — self-ticking
// components (WorkingTimer, LiveElapsed) handle it.
// ---------------------------------------------------------------------------

interface TimelineRowSharedState {
  timestampFormat: TimestampFormat;
  routeThreadKey: string;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  workspaceRoot: string | undefined;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  displayCadReviewWorkLog: boolean;
  cadReviewChildActivityByReviewId: Readonly<Record<string, CadReviewChildActivitySummary>>;
  animatedUserMessageId: MessageId | null;
  activeThreadEnvironmentId: EnvironmentId;
  onRevertUserMessage: (messageId: MessageId) => void;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}

interface TimelineRowActivityState {
  isWorking: boolean;
  isRevertingCheckpoint: boolean;
}

const TimelineRowCtx = createContext<TimelineRowSharedState>(null!);
const TimelineRowActivityCtx = createContext<TimelineRowActivityState>(null!);
const TIMELINE_LIST_HEADER = <div className="h-3 sm:h-4" />;
const TIMELINE_LIST_FOOTER = <div className="h-44 sm:h-48" />;
const EMPTY_TIMELINE_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];

interface TimelineScrollMetricsTarget {
  readonly scrollHeight: number;
  readonly scrollTop: number;
  readonly clientHeight: number;
}

// ---------------------------------------------------------------------------
// Props (public API)
// ---------------------------------------------------------------------------

interface MessagesTimelineProps {
  isWorking: boolean;
  activeTurnInProgress: boolean;
  activeTurnId?: TurnId | null;
  activeTurnStartedAt: string | null;
  listRef: React.RefObject<LegendListRef | null>;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  routeThreadKey: string;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  activeThreadEnvironmentId: EnvironmentId;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  displayCadReviewWorkLog?: boolean;
  cadReviewChildActivityByReviewId?: Readonly<Record<string, CadReviewChildActivitySummary>>;
  animatedUserMessageId?: MessageId | null;
  onIsAtEndChange: (isAtEnd: boolean) => void;
}

// ---------------------------------------------------------------------------
// MessagesTimeline — list owner
// ---------------------------------------------------------------------------

export const MessagesTimeline = memo(function MessagesTimeline({
  isWorking,
  activeTurnInProgress,
  activeTurnId,
  activeTurnStartedAt,
  listRef,
  timelineEntries,
  completionDividerBeforeEntryId,
  completionSummary,
  turnDiffSummaryByAssistantMessageId,
  routeThreadKey,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  isRevertingCheckpoint,
  onImageExpand,
  activeThreadEnvironmentId,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  skills = EMPTY_TIMELINE_SKILLS,
  displayCadReviewWorkLog = false,
  cadReviewChildActivityByReviewId = {},
  animatedUserMessageId = null,
  onIsAtEndChange,
}: MessagesTimelineProps) {
  const rawRows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries,
        completionDividerBeforeEntryId,
        completionSummary,
        isWorking,
        activeTurnInProgress,
        activeTurnId: activeTurnId ?? null,
        activeTurnStartedAt,
        turnDiffSummaryByAssistantMessageId,
        revertTurnCountByUserMessageId,
      }),
    [
      timelineEntries,
      completionDividerBeforeEntryId,
      completionSummary,
      isWorking,
      activeTurnInProgress,
      activeTurnId,
      activeTurnStartedAt,
      turnDiffSummaryByAssistantMessageId,
      revertTurnCountByUserMessageId,
    ],
  );
  const rows = useStableRows(rawRows);

  const handleScroll = useCallback(
    (event?: unknown) => {
      const state = listRef.current?.getState?.();
      const scrollElement = resolveTimelineScrollMetricsTarget(event);
      if (hasTimelineScrollMetrics(scrollElement)) {
        const distanceFromBottom =
          scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight;
        onIsAtEndChange(distanceFromBottom <= 4 ? true : (state?.isAtEnd ?? false));
        return;
      }
      if (state) {
        onIsAtEndChange(state.isAtEnd);
      }
    },
    [listRef, onIsAtEndChange],
  );

  const previousRowCountRef = useRef(0);
  useEffect(() => {
    const previousRowCount = previousRowCountRef.current;
    previousRowCountRef.current = rows.length;

    if (previousRowCount > 0 || rows.length === 0) {
      return;
    }

    onIsAtEndChange(true);
    const frameId = window.requestAnimationFrame(() => {
      void listRef.current?.scrollToEnd?.({ animated: false });
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [listRef, onIsAtEndChange, rows.length]);

  const sharedState = useMemo<TimelineRowSharedState>(
    () => ({
      timestampFormat,
      routeThreadKey,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      skills,
      displayCadReviewWorkLog,
      cadReviewChildActivityByReviewId,
      animatedUserMessageId,
      activeThreadEnvironmentId,
      onRevertUserMessage,
      onImageExpand,
      onOpenTurnDiff,
    }),
    [
      timestampFormat,
      routeThreadKey,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      skills,
      displayCadReviewWorkLog,
      cadReviewChildActivityByReviewId,
      animatedUserMessageId,
      activeThreadEnvironmentId,
      onRevertUserMessage,
      onImageExpand,
      onOpenTurnDiff,
    ],
  );
  const activityState = useMemo<TimelineRowActivityState>(
    () => ({
      isWorking,
      isRevertingCheckpoint,
    }),
    [isRevertingCheckpoint, isWorking],
  );

  // Stable renderItem — no closure deps. Row components read shared state
  // from TimelineRowCtx, which propagates through LegendList's memo.
  const renderItem = useCallback(
    ({ item }: { item: MessagesTimelineRow }) => (
      <div className="mx-auto w-full min-w-0 max-w-3xl overflow-x-clip" data-timeline-root="true">
        <TimelineRowContent row={item} />
      </div>
    ),
    [],
  );

  if (rows.length === 0 && !isWorking) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground/30">
          Send a message to start the conversation.
        </p>
      </div>
    );
  }

  return (
    <TimelineRowCtx value={sharedState}>
      <TimelineRowActivityCtx value={activityState}>
        <LegendList<MessagesTimelineRow>
          ref={listRef}
          data={rows}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          estimatedItemSize={90}
          initialScrollAtEnd
          maintainScrollAtEnd
          maintainScrollAtEndThreshold={0.1}
          maintainVisibleContentPosition={{ data: true, size: false }}
          onScroll={handleScroll}
          className="timeline-scrollport h-full overflow-x-hidden overscroll-y-contain px-3 sm:px-5"
          ListHeaderComponent={TIMELINE_LIST_HEADER}
          ListFooterComponent={TIMELINE_LIST_FOOTER}
        />
      </TimelineRowActivityCtx>
    </TimelineRowCtx>
  );
});

function hasTimelineScrollMetrics(value: unknown): value is TimelineScrollMetricsTarget {
  return (
    typeof value === "object" &&
    value !== null &&
    "scrollHeight" in value &&
    "scrollTop" in value &&
    "clientHeight" in value &&
    typeof value.scrollHeight === "number" &&
    typeof value.scrollTop === "number" &&
    typeof value.clientHeight === "number"
  );
}

function resolveTimelineScrollMetricsTarget(event: unknown): unknown {
  const eventRecord =
    typeof event === "object" && event !== null ? (event as Record<string, unknown>) : null;
  const currentTarget = eventRecord?.currentTarget;
  if (hasTimelineScrollMetrics(currentTarget)) {
    return currentTarget;
  }
  const target = eventRecord?.target;
  if (hasTimelineScrollMetrics(target)) {
    return target;
  }
  const nativeEvent = eventRecord?.nativeEvent;
  if (typeof nativeEvent === "object" && nativeEvent !== null) {
    const nativeRecord = nativeEvent as Record<string, unknown>;
    if (hasTimelineScrollMetrics(nativeRecord.target)) {
      return nativeRecord.target;
    }
  }
  if (typeof document === "undefined") {
    return null;
  }
  return document.querySelector(".timeline-scrollport");
}

function keyExtractor(item: MessagesTimelineRow) {
  return item.id;
}

// ---------------------------------------------------------------------------
// TimelineRowContent — the actual row component
// ---------------------------------------------------------------------------

type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];
type TimelineMessage = Extract<TimelineEntry, { kind: "message" }>["message"];
type TimelineWorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];
type TimelineRow = MessagesTimelineRow;

function isCadReviewTimelineWorkEntry(entry: TimelineWorkEntry): boolean {
  if (entry.activityKind?.startsWith("cad-review.") === true) {
    return true;
  }
  const text = `${entry.label} ${entry.detail ?? ""} ${entry.toolTitle ?? ""}`.toLowerCase();
  return (
    text.includes("cad review") ||
    text.includes("baseline cad screenshot") ||
    text.includes("baseline cad view") ||
    text.includes("captured cad screenshot") ||
    text.includes("export_cad_screenshot") ||
    text.includes("systems_integration reviewer") ||
    text.includes("program_readiness reviewer") ||
    text.includes("mechanical_robustness reviewer") ||
    text.includes("synthesis reviewer")
  );
}

const TimelineRowContent = memo(function TimelineRowContent({ row }: { row: TimelineRow }) {
  return (
    <div
      className={cn(
        "pb-4",
        row.kind === "message" && row.message.role === "assistant" ? "group/assistant" : null,
      )}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === "message" ? row.message.id : undefined}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {row.kind === "work" ? <WorkGroupSection groupedEntries={row.groupedEntries} /> : null}
      {row.kind === "message" && row.message.role === "user" ? <UserTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "assistant" ? (
        <AssistantTimelineRow row={row} />
      ) : null}
      {row.kind === "proposed-plan" ? <ProposedPlanTimelineRow row={row} /> : null}
      {row.kind === "cad-review" ? <CadReviewTimelineRow row={row} /> : null}
      {row.kind === "working" ? <WorkingTimelineRow row={row} /> : null}
    </div>
  );
});

function UserTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const userImages = row.message.attachments ?? [];
  const displayedUserMessage = deriveDisplayedUserMessageState(row.message.text);
  const terminalContexts = displayedUserMessage.contexts;
  const canRevertAgentWork = typeof row.revertTurnCount === "number";
  const shouldAnimate = row.message.id === ctx.animatedUserMessageId;

  return (
    <div className="flex justify-end">
      <div className="group flex max-w-[80%] flex-col items-end">
        <div
          className={cn(
            "relative rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3",
            shouldAnimate && "user-message-bubble-in",
          )}
        >
          {userImages.length > 0 && (
            <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
              {userImages.map((image: NonNullable<TimelineMessage["attachments"]>[number]) => (
                <div
                  key={image.id}
                  className="overflow-hidden rounded-lg border border-border/80 bg-background/70"
                >
                  {image.previewUrl ? (
                    <button
                      type="button"
                      className="h-full w-full cursor-zoom-in"
                      aria-label={`Preview ${image.name}`}
                      onClick={() => {
                        const preview = buildExpandedImagePreview(userImages, image.id);
                        if (!preview) return;
                        ctx.onImageExpand(preview);
                      }}
                    >
                      <img
                        src={image.previewUrl}
                        alt={image.name}
                        className="block h-auto max-h-[220px] w-full object-cover"
                      />
                    </button>
                  ) : (
                    <div className="flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground/70">
                      {image.name}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          <CollapsibleUserMessageBody
            text={displayedUserMessage.visibleText}
            terminalContexts={terminalContexts}
            skills={ctx.skills}
            footer={
              canRevertAgentWork ? (
                <RevertUserMessageButton messageId={row.message.id} />
              ) : undefined
            }
          />
        </div>
        <div className="mt-1.5 flex items-center justify-end gap-2">
          {displayedUserMessage.copyText ? (
            <div className="flex items-center opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
              <MessageCopyButton
                text={displayedUserMessage.copyText}
                size="icon-xs"
                variant="outline"
                className="border-border/50 bg-background/35 text-muted-foreground/45 shadow-none hover:border-border/70 hover:bg-background/55 hover:text-muted-foreground/70"
              />
            </div>
          ) : null}
          <p className="text-[10px] text-muted-foreground/30">
            {formatTimestamp(row.message.createdAt, ctx.timestampFormat)}
          </p>
        </div>
      </div>
    </div>
  );
}

function RevertUserMessageButton({ messageId }: { messageId: MessageId }) {
  const ctx = use(TimelineRowCtx);
  const activity = use(TimelineRowActivityCtx);

  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={activity.isRevertingCheckpoint || activity.isWorking}
      onClick={() => ctx.onRevertUserMessage(messageId)}
      title="Revert to this message"
    >
      <Undo2Icon className="size-3" />
    </Button>
  );
}

function AssistantTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");

  return (
    <>
      {row.showCompletionDivider && (
        <AssistantCompletionDivider completionSummary={row.completionSummary} />
      )}
      <div className="min-w-0 px-1 py-0.5">
        <ChatMarkdown
          text={messageText}
          cwd={ctx.markdownCwd}
          isStreaming={Boolean(row.message.streaming)}
          skills={ctx.skills}
          onImageExpand={ctx.onImageExpand}
        />
        <AssistantChangedFilesSection
          turnSummary={row.assistantTurnDiffSummary}
          routeThreadKey={ctx.routeThreadKey}
          resolvedTheme={ctx.resolvedTheme}
          onOpenTurnDiff={ctx.onOpenTurnDiff}
        />
        <div className="mt-1.5 flex items-center gap-2">
          <p className="text-[10px] text-muted-foreground/30">
            {row.message.streaming ? (
              <LiveMessageMeta
                createdAt={row.message.createdAt}
                durationStart={row.durationStart}
                timestampFormat={ctx.timestampFormat}
              />
            ) : (
              formatMessageMeta(
                row.message.createdAt,
                formatElapsed(row.durationStart, row.message.completedAt),
                ctx.timestampFormat,
              )
            )}
          </p>
          <AssistantCopyButton row={row} />
        </div>
      </div>
    </>
  );
}

function AssistantCompletionDivider({ completionSummary }: { completionSummary: string | null }) {
  return (
    <div className="my-3 flex items-center gap-3">
      <span className="h-px flex-1 bg-border" />
      <span className="rounded-full border border-border bg-background px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80">
        {completionSummary ? `Response • ${completionSummary}` : "Response"}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function AssistantCopyButton({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const assistantCopyState = resolveAssistantMessageCopyState({
    text: row.message.text ?? null,
    showCopyButton: row.showAssistantCopyButton,
    streaming: row.assistantCopyStreaming,
  });

  if (!assistantCopyState.visible) {
    return null;
  }

  return (
    <div className="flex items-center opacity-0 transition-opacity duration-200  group-hover/assistant:opacity-100">
      <MessageCopyButton
        text={assistantCopyState.text ?? ""}
        size="icon-xs"
        variant="outline"
        className="border-border/50 bg-background/35 text-muted-foreground/45 shadow-none hover:border-border/70 hover:bg-background/55 hover:text-muted-foreground/70"
      />
    </div>
  );
}

function ProposedPlanTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "proposed-plan" }>;
}) {
  const ctx = use(TimelineRowCtx);

  return (
    <div className="min-w-0 px-1 py-0.5">
      <ProposedPlanCard
        planMarkdown={row.proposedPlan.planMarkdown}
        environmentId={ctx.activeThreadEnvironmentId}
        cwd={ctx.markdownCwd}
        workspaceRoot={ctx.workspaceRoot}
      />
    </div>
  );
}

function CadReviewTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "cad-review" }> }) {
  const review = row.review;
  const ctx = use(TimelineRowCtx);
  const childActivity = ctx.cadReviewChildActivityByReviewId[review.id] ?? null;
  const activeAgent =
    review.status === "completed" || review.status === "partial" || review.status === "failed"
      ? null
      : review.status === "capturing-baseline"
        ? "Baseline capture"
        : review.status === "planning"
          ? "Mechanism planning"
          : review.status === "deep-diving"
            ? "Focused deep dive"
            : review.activePersona
              ? `${formatCadReviewPersona(review.activePersona)} reviewer`
              : null;
  const allToolCalls = Object.values(review.toolCallsByReviewer).flat();
  const baselineArtifacts = review.evidenceArtifacts.filter(
    (artifact) => artifact.scope === "baseline",
  );
  const personaArtifacts = review.evidenceArtifacts.filter(
    (artifact) => artifact.scope === "persona",
  );

  return (
    <div className="min-w-0 px-1 py-0.5">
      <div className="rounded-lg border border-border bg-card/70 p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <BotIcon className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">{review.title}</h3>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span
                className={cn(
                  "rounded-sm border px-1.5 py-0.5",
                  cadReviewStatusClass(review.status),
                )}
              >
                {review.status}
              </span>
              {activeAgent ? <span>Active: {activeAgent}</span> : null}
              {childActivity ? (
                <span>
                  Child updated <LiveSince createdAt={childActivity.updatedAt} /> ago
                </span>
              ) : null}
              <span>{formatTimestamp(review.updatedAt, ctx.timestampFormat)}</span>
            </div>
          </div>
          <span className="rounded-sm border border-border px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            CAD Review
          </span>
        </div>

        {review.whatIsBeingReviewed ? (
          <section className="mt-4">
            <h4 className="text-xs font-medium text-muted-foreground">What’s being reviewed</h4>
            <p className="mt-1 text-sm">{review.whatIsBeingReviewed}</p>
          </section>
        ) : null}

        {review.reviewPrompt ? (
          <section className="mt-4">
            <h4 className="text-xs font-medium text-muted-foreground">Review prompt</h4>
            <p className="mt-1 text-sm">{review.reviewPrompt}</p>
          </section>
        ) : null}

        {childActivity ? <CadReviewLiveChildActivity summary={childActivity} /> : null}

        {review.positiveSignals.length > 0 || review.mergedActionItems.length > 0 ? (
          <CadReviewActionSummary review={review} />
        ) : null}

        {review.commonThemes.length > 0 ? <CadReviewCommonThemes review={review} /> : null}

        {review.reviewPlan ? (
          <CadReviewCollapsibleSection
            className="mt-4"
            count={review.reviewPlan.mechanisms.length}
            icon={HammerIcon}
            title="Mechanism plan"
          >
            <p className="mt-1 text-sm text-muted-foreground">{review.reviewPlan.summary}</p>
            {review.reviewPlan.mechanisms.length > 0 ? (
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {review.reviewPlan.mechanisms.map((mechanism) => (
                  <div key={mechanism.name} className="rounded-md border border-border/70 p-2.5">
                    <p className="text-sm font-medium">{mechanism.name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{mechanism.role}</p>
                    {mechanism.specificChecks.length > 0 ? (
                      <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                        {mechanism.specificChecks.slice(0, 3).map((check) => (
                          <li key={check}>- {check}</li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
            {review.reviewPlan.calculatorNeeds.length > 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Calculator needs: {review.reviewPlan.calculatorNeeds.join("; ")}
              </p>
            ) : null}
            {review.reviewPlan.baselineReason ? (
              <p className="mt-3 text-xs text-muted-foreground">
                Baseline capture: {review.reviewPlan.baselineRequired ? "requested" : "skipped"} -{" "}
                {review.reviewPlan.baselineReason}
              </p>
            ) : null}
            {review.reviewPlan.reviewerSelection.length > 0 ? (
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                {review.reviewPlan.reviewerSelection.map((selection) => (
                  <div key={selection.persona} className="rounded-md border border-border/70 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium">
                        {formatCadReviewPersona(selection.persona)}
                      </span>
                      <span
                        className={cn(
                          "rounded-sm border px-1.5 py-0.5 text-[10px] uppercase",
                          selection.enabled
                            ? "border-success/30 text-success-foreground"
                            : "border-border text-muted-foreground",
                        )}
                      >
                        {selection.enabled ? "enabled" : "skipped"}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{selection.reason}</p>
                  </div>
                ))}
              </div>
            ) : null}
          </CadReviewCollapsibleSection>
        ) : null}

        {review.personaReports.length > 0 ? (
          <CadReviewCollapsibleSection
            className="mt-4"
            count={review.personaReports.length}
            icon={EyeIcon}
            title="Reviewer personas"
          >
            <div className="mt-2 space-y-3">
              {review.personaReports.map((report) => (
                <div key={report.persona} className="rounded-lg border border-border/70 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">{report.persona}</p>
                    <span className="text-xs text-muted-foreground">{report.status}</span>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{report.summary}</p>
                  {report.topConcerns.length > 0 ? (
                    <ul className="mt-2 space-y-1 text-sm">
                      {report.topConcerns.map((finding) => (
                        <li key={finding.id} className="rounded-md bg-muted/30 p-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{finding.title}</span>
                            {finding.severity ? (
                              <span className="rounded-sm border border-border px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                                {finding.severity}
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-1">{finding.description}</p>
                          {finding.observedGeometry ? (
                            <p className="mt-1 text-xs text-muted-foreground">
                              Geometry: {finding.observedGeometry}
                            </p>
                          ) : null}
                          {finding.specificCheck ? (
                            <p className="mt-1 text-xs text-muted-foreground">
                              Check: {finding.specificCheck}
                            </p>
                          ) : null}
                          {finding.recommendedFix ? (
                            <p className="mt-1 text-xs text-muted-foreground">
                              Fix: {finding.recommendedFix}
                            </p>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))}
            </div>
          </CadReviewCollapsibleSection>
        ) : null}

        {review.deepDiveReports && review.deepDiveReports.length > 0 ? (
          <CadReviewCollapsibleSection
            className="mt-4"
            count={review.deepDiveReports.length}
            icon={ZapIcon}
            title="Focused deep dives"
          >
            <div className="mt-2 space-y-2">
              {review.deepDiveReports.map((deepDive) => (
                <div key={deepDive.id} className="rounded-lg border border-border/70 p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{deepDive.focus}</span>
                    <span className="text-xs text-muted-foreground">
                      {deepDive.confidence} confidence
                    </span>
                  </div>
                  <p className="mt-1 text-muted-foreground">{deepDive.summary}</p>
                  {deepDive.specificChecks.length > 0 ? (
                    <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                      {deepDive.specificChecks.map((check) => (
                        <li key={check}>- {check}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))}
            </div>
          </CadReviewCollapsibleSection>
        ) : null}

        <section className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <h4 className="text-xs font-medium text-muted-foreground">Baseline views</h4>
            <p className="mt-1 text-sm text-muted-foreground">
              {review.evidenceArtifacts.filter((artifact) => artifact.scope === "baseline").length}{" "}
              captured
            </p>
          </div>
          <div>
            <h4 className="text-xs font-medium text-muted-foreground">Tool activity</h4>
            <p className="mt-1 text-sm text-muted-foreground">
              {allToolCalls.length} reviewer-attributed calls
            </p>
          </div>
        </section>

        {review.error ? (
          <section className="mt-4 border-t border-border/60 pt-3">
            <div className="flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/5 p-2.5 text-sm">
              <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
              <p className="min-w-0 wrap-break-word text-destructive-foreground">{review.error}</p>
            </div>
          </section>
        ) : null}

        <CadReviewCollapsibleSection
          className="mt-4"
          count={review.evidenceArtifacts.length}
          icon={ImageIcon}
          title="Evidence"
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <CadReviewEvidenceGroup title="Baseline" artifacts={baselineArtifacts} />
            <CadReviewEvidenceGroup title="Reviewer captures" artifacts={personaArtifacts} />
          </div>
        </CadReviewCollapsibleSection>

        <CadReviewCollapsibleSection
          className="mt-4"
          count={allToolCalls.length}
          icon={WrenchIcon}
          title="Tool activity detail"
        >
          <div className="space-y-2">
            {CAD_REVIEW_PERSONAS.map((persona) => (
              <CadReviewToolGroup
                key={persona}
                persona={persona}
                review={review}
                toolCalls={review.toolCallsByReviewer[persona] ?? []}
              />
            ))}
          </div>
        </CadReviewCollapsibleSection>
      </div>
    </div>
  );
}

function CadReviewLiveChildActivity({ summary }: { summary: CadReviewChildActivitySummary }) {
  const reviewer = summary.reviewer ? formatCadReviewReviewerName(summary.reviewer) : "Reviewer";
  const toolLabel = summary.latestToolTitle || summary.latestToolName;
  const activityLabel = toolLabel || summary.latestActivityLabel;

  return (
    <section className="mt-4 rounded-md border border-primary/20 bg-primary/5 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-xs font-medium text-muted-foreground">Live child-thread activity</h4>
          <p className="mt-1 truncate text-sm">
            {reviewer}: {activityLabel}
          </p>
        </div>
        <span className="rounded-sm border border-primary/25 px-2 py-1 text-[10px] uppercase tracking-wide text-primary">
          <LiveSince createdAt={summary.updatedAt} /> ago
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {summary.latestToolName ? <span>Tool: {summary.latestToolName}</span> : null}
        {summary.latestScreenshotAt ? (
          <span>
            Screenshot: <LiveSince createdAt={summary.latestScreenshotAt} /> ago
          </span>
        ) : null}
        {summary.latestRenderAt ? (
          <span>
            Render/view: <LiveSince createdAt={summary.latestRenderAt} /> ago
          </span>
        ) : null}
      </div>
    </section>
  );
}

const CAD_REVIEW_PERSONAS = [
  "systems_integration",
  "program_readiness",
  "mechanical_robustness",
  "synthesis",
] as const satisfies ReadonlyArray<CadReviewPersona>;

function formatCadReviewPersona(persona: CadReviewPersona): string {
  return persona
    .split("_")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function formatCadReviewReviewerName(reviewer: string): string {
  return reviewer
    .split("_")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function cadReviewStatusClass(status: CadReviewReport["status"]): string {
  if (status === "completed") return "border-success/30 bg-success/8 text-success-foreground";
  if (status === "partial") return "border-warning/30 bg-warning/8 text-warning-foreground";
  if (status === "failed")
    return "border-destructive/30 bg-destructive/8 text-destructive-foreground";
  return "border-border bg-muted/35 text-muted-foreground";
}

function cadReviewEvidenceLabel(review: CadReviewReport, artifactId: string): string {
  const artifact = review.evidenceArtifacts.find((entry) => entry.id === artifactId);
  if (!artifact) return artifactId;
  return artifact.persona
    ? `${formatCadReviewPersona(artifact.persona)} ${artifact.viewName}`
    : artifact.viewName;
}

function cadReviewFindingById(
  review: CadReviewReport,
): Map<string, CadReviewReport["personaReports"][number]["topConcerns"][number]> {
  return new Map(
    review.personaReports.flatMap((report) =>
      report.topConcerns.map((finding) => [finding.id, finding] as const),
    ),
  );
}

function evidenceArtifactIdsForActionItem(
  review: CadReviewReport,
  item: CadReviewReport["mergedActionItems"][number],
): ReadonlyArray<string> {
  if (item.evidenceArtifactIds.length > 0) {
    return item.evidenceArtifactIds;
  }
  const findingById = cadReviewFindingById(review);
  return [
    ...new Set(
      item.sourceFindingIds.flatMap(
        (findingId) => findingById.get(findingId)?.evidenceArtifactIds ?? [],
      ),
    ),
  ];
}

function cadReviewArtifactPreviewUrl(artifact: CadReviewEvidenceArtifact): string {
  if (/^https:\/\/api-frcrag-v2\.johari-dev\.com\//i.test(artifact.artifactUri)) {
    return `/api/mechbase/artifact?artifactUrl=${encodeURIComponent(artifact.artifactUri)}`;
  }
  return `/api/cad/review-artifact?artifactUri=${encodeURIComponent(artifact.artifactUri)}`;
}

function isPreviewableCadReviewArtifact(artifact: CadReviewEvidenceArtifact): boolean {
  if (artifact.status !== "captured") {
    return false;
  }
  if (artifact.mimeType?.toLowerCase().startsWith("image/")) {
    return true;
  }
  return /\.(?:gif|jpe?g|png|webp)$/i.test(artifact.artifactUri);
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  const match = /^(.*?[.!?])(?:\s|$)/.exec(trimmed);
  return match?.[1] ?? trimmed;
}

function cadReviewVerdict(review: CadReviewReport): string | null {
  const deepDiveSummary = review.deepDiveReports?.find(
    (report) => report.summary.trim().length > 0,
  )?.summary;
  if (deepDiveSummary) {
    return firstSentence(deepDiveSummary);
  }
  const personaSummary = review.personaReports.find(
    (report) => report.summary.trim().length > 0,
  )?.summary;
  if (personaSummary) {
    return firstSentence(personaSummary);
  }
  return review.commonThemes[0] ?? null;
}

function tokenizeCadReviewText(text: string): Set<string> {
  const stopWords = new Set([
    "about",
    "action",
    "after",
    "already",
    "also",
    "appear",
    "because",
    "before",
    "being",
    "both",
    "critical",
    "current",
    "design",
    "fixed",
    "geometry",
    "highest",
    "likely",
    "local",
    "main",
    "multiple",
    "review",
    "risk",
    "shooter",
    "stage",
    "still",
    "support",
    "that",
    "their",
    "there",
    "these",
    "through",
    "with",
  ]);
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 3 && !stopWords.has(token)),
  );
}

function actionText(item: CadReviewReport["mergedActionItems"][number]): string {
  return [
    item.title,
    item.description,
    item.subsystem,
    item.issueType,
    item.rationale,
    item.targetGeometry,
  ]
    .filter(Boolean)
    .join(" ");
}

function bestActionForTheme(
  review: CadReviewReport,
  theme: string,
): CadReviewReport["mergedActionItems"][number] | null {
  const themeTokens = tokenizeCadReviewText(theme);
  let best: CadReviewReport["mergedActionItems"][number] | null = null;
  let bestScore = 0;
  for (const item of review.mergedActionItems) {
    const actionTokens = tokenizeCadReviewText(actionText(item));
    const score = [...themeTokens].filter((token) => actionTokens.has(token)).length;
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

function cadReviewActionTags(item: CadReviewReport["mergedActionItems"][number]): string[] {
  const text = actionText(item).toLowerCase();
  const tags: string[] = [];
  if (/\b(service|access|belt|retainer|remove|replacement|pit)\b/.test(text)) {
    tags.push("serviceability");
  }
  if (/\b(handoff|transfer|throat|guide|jam|capture)\b/.test(text)) {
    tags.push("handoff");
  }
  if (/\b(shaft|bearing|span|double shear|wheel)\b/.test(text)) {
    tags.push("roller support");
  }
  if (/\b(stiffen|stiffness|plate|spread|racking|deflection|truss)\b/.test(text)) {
    tags.push("stiffness");
  }
  return tags.slice(0, 2);
}

function cadReviewMeasurementTargets(review: CadReviewReport): string[] {
  const candidates = review.mergedActionItems.flatMap((item) => [
    ...(item.targetGeometry ? [`Target geometry: ${item.targetGeometry}`] : []),
    ...(item.verificationSteps ?? []),
  ]);
  return [
    ...new Set(
      candidates.filter((step) =>
        /\b(measure|count|calculate|estimate|record|simulate|verify)\b/i.test(step),
      ),
    ),
  ].slice(0, 6);
}

function CadReviewActionSummary({ review }: { review: CadReviewReport }) {
  const ctx = use(TimelineRowCtx);
  const actionItems = review.mergedActionItems.slice(0, 6);
  const verdict = cadReviewVerdict(review);
  const measurementTargets = cadReviewMeasurementTargets(review);
  return (
    <section className="mt-4 border-t border-border/60 pt-3">
      {verdict ? (
        <div className="mb-3 rounded-md border border-primary/20 bg-primary/5 p-3">
          <p className="text-xs font-medium text-primary">One-line verdict</p>
          <p className="mt-1 text-sm text-foreground">{verdict}</p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-medium text-muted-foreground">Review summary</h4>
        {review.mergedActionItems.length > actionItems.length ? (
          <span className="text-[11px] text-muted-foreground">
            Showing {actionItems.length} of {review.mergedActionItems.length} action items
          </span>
        ) : null}
      </div>

      {actionItems.length > 0 ? (
        <div className="mt-2 space-y-2">
          {actionItems.map((item) => {
            const evidenceIds = evidenceArtifactIdsForActionItem(review, item);
            const tags = cadReviewActionTags(item);
            return (
              <article key={item.id} className="rounded-md border border-border/70 bg-muted/25 p-3">
                <div className="flex flex-wrap items-start gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          "rounded-sm border px-1.5 py-0.5 text-[10px] uppercase",
                          item.priority === "critical"
                            ? "border-destructive/35 bg-destructive/8 text-destructive-foreground"
                            : item.priority === "high"
                              ? "border-warning/35 bg-warning/8 text-warning-foreground"
                              : "border-border text-muted-foreground",
                        )}
                      >
                        {item.priority}
                      </span>
                      {item.subsystem ? (
                        <span className="text-[11px] text-muted-foreground">{item.subsystem}</span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-sm font-medium">{item.title}</p>
                    {tags.length > 0 ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {tags.map((tag) => (
                          <span
                            key={tag}
                            className="rounded-sm border border-border/70 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
                <CadReviewActionEvidenceCarousel
                  artifactIds={evidenceIds}
                  onImageExpand={ctx.onImageExpand}
                  review={review}
                />
                <p className="mt-1 text-sm text-muted-foreground">{item.description}</p>
                {item.targetGeometry ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground/80">Target:</span>{" "}
                    {item.targetGeometry}
                  </p>
                ) : null}
                {item.verificationSteps && item.verificationSteps.length > 0 ? (
                  <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                    {item.verificationSteps.slice(0, 3).map((step) => (
                      <li key={step} className="flex gap-1.5">
                        <CheckIcon className="mt-0.5 size-3 shrink-0 text-primary" />
                        <span>{step}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : null}

      {measurementTargets.length > 0 ? (
        <div className="mt-3 rounded-md border border-border/70 bg-background/40 p-3">
          <p className="text-xs font-medium text-muted-foreground">Measurement targets</p>
          <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {measurementTargets.map((target) => (
              <div key={target} className="flex gap-2 text-xs text-muted-foreground">
                <SquarePenIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{target}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {review.positiveSignals.length > 0 ? (
        <div className="mt-3 rounded-md border border-success/20 bg-success/5 p-3">
          <p className="text-xs font-medium text-success-foreground">Strengths to preserve</p>
          <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
            {review.positiveSignals.slice(0, 3).map((signal) => (
              <li key={signal} className="flex gap-2">
                <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-success-foreground" />
                <span>{signal}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function CadReviewActionEvidenceCarousel({
  artifactIds,
  onImageExpand,
  review,
}: {
  artifactIds: ReadonlyArray<string>;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  review: CadReviewReport;
}) {
  const artifacts = artifactIds
    .map((artifactId) => review.evidenceArtifacts.find((artifact) => artifact.id === artifactId))
    .filter(
      (artifact): artifact is CadReviewEvidenceArtifact =>
        artifact !== undefined && isPreviewableCadReviewArtifact(artifact),
    )
    .slice(0, 6);
  if (artifacts.length === 0) {
    return null;
  }

  const previewImages = artifacts.map((artifact) => ({
    src: cadReviewArtifactPreviewUrl(artifact),
    name: cadReviewEvidenceLabel(review, artifact.id),
  }));

  return (
    <div className="mt-2 rounded-md border border-border/70 bg-background/40 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">Evidence</p>
        <span className="text-[11px] text-muted-foreground">{artifacts.length} images</span>
      </div>
      <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
        {artifacts.map((artifact, index) => (
          <button
            key={artifact.id}
            type="button"
            className="group min-w-32 overflow-hidden rounded-md border border-border/70 bg-muted/25 text-left transition-colors hover:border-primary/40 hover:bg-muted/45"
            onClick={() => onImageExpand({ images: previewImages, index })}
          >
            <div className="aspect-video w-32 overflow-hidden bg-muted">
              <img
                src={cadReviewArtifactPreviewUrl(artifact)}
                alt={cadReviewEvidenceLabel(review, artifact.id)}
                className="h-full w-full object-cover transition-transform group-hover:scale-[1.02]"
                loading="lazy"
              />
            </div>
            <div className="p-2">
              <p className="truncate text-xs font-medium">
                {cadReviewEvidenceLabel(review, artifact.id)}
              </p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function CadReviewCommonThemes({ review }: { review: CadReviewReport }) {
  return (
    <section className="mt-4">
      <h4 className="text-xs font-medium text-muted-foreground">Common themes</h4>
      <ul className="mt-2 space-y-2 text-sm">
        {review.commonThemes.map((theme) => {
          const action = bestActionForTheme(review, theme);
          return (
            <li key={theme} className="rounded-md border border-border/70 bg-muted/20 p-2.5">
              <p>{theme}</p>
              {action ? (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground/80">Recommended fix:</span>{" "}
                  {action.title}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function CadReviewCollapsibleSection({
  children,
  className,
  count,
  icon: Icon,
  title,
}: {
  children: ReactNode;
  className?: string;
  count: number;
  icon: LucideIcon;
  title: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn("border-t border-border/60 pt-3", className)}
    >
      <CollapsibleTrigger
        render={
          <button
            type="button"
            data-scroll-anchor-ignore
            className="flex w-full items-center justify-between gap-3 rounded-md px-1 py-1 text-left transition-colors hover:bg-muted/35"
          >
            <span className="flex min-w-0 items-center gap-2">
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="text-xs font-medium text-muted-foreground">
                {title} ({count})
              </span>
            </span>
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform data-[panel-open]:rotate-180" />
          </button>
        }
      />
      <CollapsiblePanel data-scroll-anchor-ignore>
        <div className="pt-2">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function CadReviewEvidenceGroup({
  title,
  artifacts,
}: {
  title: string;
  artifacts: ReadonlyArray<CadReviewEvidenceArtifact>;
}) {
  return (
    <div className="rounded-md border border-border/70 p-2.5">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      {artifacts.length > 0 ? (
        <div className="mt-2 space-y-2">
          {artifacts.map((artifact) => (
            <div key={artifact.id} className="min-w-0 rounded-md bg-muted/30 p-2">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-medium">{artifact.viewName}</span>
                <span
                  className={cn(
                    "rounded-sm border px-1.5 py-0.5",
                    artifact.status === "failed"
                      ? "border-destructive/30 text-destructive-foreground"
                      : "border-border text-muted-foreground",
                  )}
                >
                  {artifact.status}
                </span>
              </div>
              {artifact.persona ? (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {formatCadReviewPersona(artifact.persona)}
                </p>
              ) : null}
              <p
                className="mt-1 truncate font-mono text-[10px] text-muted-foreground/75"
                title={artifact.artifactUri}
              >
                {artifact.artifactUri}
              </p>
              {artifact.error ? (
                <p className="mt-1 text-[11px] text-destructive-foreground">{artifact.error}</p>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground/70">No artifacts captured.</p>
      )}
    </div>
  );
}

function CadReviewToolGroup({
  persona,
  review,
  toolCalls,
}: {
  persona: CadReviewPersona;
  review: CadReviewReport;
  toolCalls: ReadonlyArray<CadReviewToolCall>;
}) {
  if (toolCalls.length === 0) {
    return null;
  }
  return (
    <div className="rounded-md border border-border/70 p-2.5">
      <p className="text-xs font-medium text-muted-foreground">{formatCadReviewPersona(persona)}</p>
      <div className="mt-2 space-y-1.5">
        {toolCalls.map((toolCall) => (
          <div key={toolCall.id} className="rounded-md bg-muted/30 p-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{toolCall.toolName}</span>
              <span
                className={cn(
                  "rounded-sm border px-1.5 py-0.5",
                  cadReviewStatusClass(
                    toolCall.status === "failed"
                      ? "failed"
                      : toolCall.status === "completed"
                        ? "completed"
                        : "reviewing",
                  ),
                )}
              >
                {toolCall.status}
              </span>
              <span className="text-muted-foreground">{toolCall.phase}</span>
            </div>
            {toolCall.argumentsSummary ? (
              <p className="mt-1 text-muted-foreground">Args: {toolCall.argumentsSummary}</p>
            ) : null}
            {toolCall.resultSummary ? (
              <p className="mt-1 text-muted-foreground">Result: {toolCall.resultSummary}</p>
            ) : null}
            {toolCall.evidenceArtifactIds.length > 0 ? (
              <p className="mt-1 text-muted-foreground/75">
                Evidence:{" "}
                {toolCall.evidenceArtifactIds
                  .map((artifactId) => cadReviewEvidenceLabel(review, artifactId))
                  .join(", ")}
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function WorkingTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "working" }> }) {
  return (
    <div className="py-0.5 pl-1.5">
      <div className="flex items-center gap-2 pt-1 text-[11px] text-muted-foreground/70">
        <span className="inline-flex items-center gap-[3px]">
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse" />
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:200ms]" />
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:400ms]" />
        </span>
        <span>
          {row.createdAt ? (
            <>
              Working for <WorkingTimer createdAt={row.createdAt} />
            </>
          ) : (
            "Working..."
          )}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-ticking labels — update their own text nodes so elapsed-time display
// does not create a React commit every second while a response is streaming.
// ---------------------------------------------------------------------------

/** Live "Working for Xs" label. */
function WorkingTimer({ createdAt }: { createdAt: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatWorkingTimerNow(createdAt);

  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        textRef.current.textContent = formatWorkingTimerNow(createdAt);
      }
    };
    updateText();
    const id = setInterval(updateText, 1000);
    return () => clearInterval(id);
  }, [createdAt]);

  return <span ref={textRef}>{initialText}</span>;
}

function LiveSince({ createdAt }: { createdAt: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatWorkingTimerNow(createdAt);

  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        textRef.current.textContent = formatWorkingTimerNow(createdAt);
      }
    };
    updateText();
    const id = setInterval(updateText, 1000);
    return () => clearInterval(id);
  }, [createdAt]);

  return <span ref={textRef}>{initialText}</span>;
}

/** Live timestamp + elapsed duration for a streaming assistant message. */
function LiveMessageMeta({
  createdAt,
  durationStart,
  timestampFormat,
}: {
  createdAt: string;
  durationStart: string | null | undefined;
  timestampFormat: TimestampFormat;
}) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatLiveMessageMetaNow(createdAt, durationStart, timestampFormat);

  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        textRef.current.textContent = formatLiveMessageMetaNow(
          createdAt,
          durationStart,
          timestampFormat,
        );
      }
    };
    updateText();
    if (!durationStart) {
      return;
    }
    const id = setInterval(updateText, 1000);
    return () => clearInterval(id);
  }, [createdAt, durationStart, timestampFormat]);

  return <span ref={textRef}>{initialText}</span>;
}

// ---------------------------------------------------------------------------
// Extracted row sections — own their state / store subscriptions so changes
// re-render only the affected row, not the entire list.
// ---------------------------------------------------------------------------

/** Owns its own expand/collapse state so toggling re-renders only this row.
 *  State resets on unmount which is fine — work groups start collapsed. */
const WorkGroupSection = memo(function WorkGroupSection({
  groupedEntries,
}: {
  groupedEntries: Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"];
}) {
  const { displayCadReviewWorkLog, workspaceRoot } = use(TimelineRowCtx);
  const [isExpanded, setIsExpanded] = useState(false);
  const isCadReviewWorkLog = groupedEntries.some(isCadReviewTimelineWorkEntry);
  if (isCadReviewWorkLog && !displayCadReviewWorkLog) {
    return null;
  }
  const hasOverflow = groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
  const visibleEntries =
    hasOverflow && !isExpanded
      ? groupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
      : groupedEntries;
  const hiddenCount = groupedEntries.length - visibleEntries.length;
  const onlyToolEntries = groupedEntries.every((entry) => entry.tone === "tool");
  const showHeader = isCadReviewWorkLog || hasOverflow || !onlyToolEntries;
  const groupLabel = isCadReviewWorkLog || !onlyToolEntries ? "Work log" : "Tool calls";

  return (
    <div className="rounded-xl border border-border/45 bg-card/25 px-2 py-1.5">
      {showHeader && (
        <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
          <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground/55">
            {groupLabel} ({groupedEntries.length})
          </p>
          {hasOverflow && (
            <button
              type="button"
              className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground/55 transition-colors duration-150 hover:text-foreground/75"
              onClick={() => setIsExpanded((v) => !v)}
            >
              {isExpanded ? "Show less" : `Show ${hiddenCount} more`}
            </button>
          )}
        </div>
      )}
      <div className="space-y-0.5">
        {visibleEntries.map((workEntry) => (
          <SimpleWorkEntryRow
            key={`work-row:${workEntry.id}`}
            workEntry={workEntry}
            workspaceRoot={workspaceRoot}
          />
        ))}
      </div>
    </div>
  );
});

/** Subscribes directly to the UI state store for expand/collapse state,
 *  so toggling re-renders only this component — not the entire list. */
const AssistantChangedFilesSection = memo(function AssistantChangedFilesSection({
  turnSummary,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary | undefined;
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  if (!turnSummary) return null;
  const checkpointFiles = turnSummary.files;
  if (checkpointFiles.length === 0) return null;

  return (
    <AssistantChangedFilesSectionInner
      turnSummary={turnSummary}
      checkpointFiles={checkpointFiles}
      routeThreadKey={routeThreadKey}
      resolvedTheme={resolvedTheme}
      onOpenTurnDiff={onOpenTurnDiff}
    />
  );
});

/** Inner component that only mounts when there are actual changed files,
 *  so the store subscription is unconditional (no hooks after early return). */
function AssistantChangedFilesSectionInner({
  turnSummary,
  checkpointFiles,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary;
  checkpointFiles: TurnDiffSummary["files"];
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  const allDirectoriesExpanded = useUiStateStore(
    (store) => store.threadChangedFilesExpandedById[routeThreadKey]?.[turnSummary.turnId] ?? true,
  );
  const setExpanded = useUiStateStore((store) => store.setThreadChangedFilesExpanded);
  const summaryStat = summarizeTurnDiffStats(checkpointFiles);
  const changedFileCountLabel = String(checkpointFiles.length);

  return (
    <div className="mt-2 rounded-lg border border-border/80 bg-card/45 p-2.5">
      <div className="sticky top-2 z-10 mb-1.5 flex items-center justify-between gap-2 bg-[color-mix(in_srgb,var(--card)_45%,var(--background))] before:absolute before:inset-x-0 before:-top-2 before:h-2 before:bg-[color-mix(in_srgb,var(--card)_45%,var(--background))] before:content-['']">
        <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/65">
          <span>Changed files ({changedFileCountLabel})</span>
          {hasNonZeroStat(summaryStat) && (
            <>
              <span className="mx-1">•</span>
              <DiffStatLabel additions={summaryStat.additions} deletions={summaryStat.deletions} />
            </>
          )}
        </p>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            variant="outline"
            data-scroll-anchor-ignore
            onClick={() => setExpanded(routeThreadKey, turnSummary.turnId, !allDirectoriesExpanded)}
          >
            {allDirectoriesExpanded ? "Collapse all" : "Expand all"}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => onOpenTurnDiff(turnSummary.turnId, checkpointFiles[0]?.path)}
          >
            View diff
          </Button>
        </div>
      </div>
      <ChangedFilesTree
        key={`changed-files-tree:${turnSummary.turnId}`}
        turnId={turnSummary.turnId}
        files={checkpointFiles}
        allDirectoriesExpanded={allDirectoriesExpanded}
        resolvedTheme={resolvedTheme}
        onOpenTurnDiff={onOpenTurnDiff}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Leaf components
// ---------------------------------------------------------------------------

const UserMessageTerminalContextInlineLabel = memo(
  function UserMessageTerminalContextInlineLabel(props: { context: ParsedTerminalContextEntry }) {
    const tooltipText =
      props.context.body.length > 0
        ? `${props.context.header}\n${props.context.body}`
        : props.context.header;

    return <TerminalContextInlineChip label={props.context.header} tooltipText={tooltipText} />;
  },
);

const MAX_COLLAPSED_USER_MESSAGE_LINES = 8;
const MAX_COLLAPSED_USER_MESSAGE_LENGTH = 600;
const COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM = 1.75;
const COLLAPSED_USER_MESSAGE_FADE_MASK = `linear-gradient(to bottom, black calc(100% - ${COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM}rem), transparent)`;

function shouldCollapseUserMessage(text: string): boolean {
  if (text.trim().length === 0) {
    return false;
  }

  return (
    text.length > MAX_COLLAPSED_USER_MESSAGE_LENGTH ||
    text.split("\n").length > MAX_COLLAPSED_USER_MESSAGE_LINES
  );
}

const CollapsibleUserMessageBody = memo(function CollapsibleUserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  footer?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasVisibleBody = props.text.trim().length > 0 || props.terminalContexts.length > 0;
  const canCollapse = hasVisibleBody && shouldCollapseUserMessage(props.text);
  const isCollapsed = canCollapse && !expanded;

  return (
    <div>
      {hasVisibleBody ? (
        <div
          className={cn("relative", isCollapsed && "max-h-44 overflow-hidden")}
          data-user-message-body="true"
          data-user-message-collapsed={isCollapsed ? "true" : "false"}
          data-user-message-collapsible={canCollapse ? "true" : "false"}
          data-user-message-fade={isCollapsed ? "true" : "false"}
          style={
            isCollapsed
              ? {
                  WebkitMaskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                  maskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                }
              : undefined
          }
        >
          <UserMessageBody
            text={props.text}
            terminalContexts={props.terminalContexts}
            skills={props.skills}
          />
        </div>
      ) : null}
      {canCollapse || props.footer ? (
        <div
          className={cn(
            "mt-1.5 flex items-center gap-2",
            canCollapse && props.footer ? "justify-between" : "justify-end",
          )}
          data-user-message-footer="true"
        >
          {canCollapse ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-expanded={expanded}
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
              className="-ml-1 h-6 rounded-md px-1.5 text-xs text-muted-foreground/72 hover:bg-muted/55 hover:text-foreground/85"
            >
              {expanded ? "Show less" : "Show full message"}
            </Button>
          ) : null}
          {props.footer ? (
            <div className="ml-auto flex items-center gap-2">{props.footer}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
}) {
  if (props.terminalContexts.length > 0) {
    const hasEmbeddedInlineLabels = textContainsInlineTerminalContextLabels(
      props.text,
      props.terminalContexts,
    );
    const inlinePrefix = buildInlineTerminalContextText(props.terminalContexts);
    const inlineNodes: ReactNode[] = [];

    if (hasEmbeddedInlineLabels) {
      let cursor = 0;

      for (const context of props.terminalContexts) {
        const label = formatInlineTerminalContextLabel(context.header);
        const matchIndex = props.text.indexOf(label, cursor);
        if (matchIndex === -1) {
          inlineNodes.length = 0;
          break;
        }
        if (matchIndex > cursor) {
          inlineNodes.push(
            <span key={`user-terminal-context-inline-before:${context.header}:${cursor}`}>
              <SkillInlineText text={props.text.slice(cursor, matchIndex)} skills={props.skills} />
            </span>,
          );
        }
        inlineNodes.push(
          <UserMessageTerminalContextInlineLabel
            key={`user-terminal-context-inline:${context.header}`}
            context={context}
          />,
        );
        cursor = matchIndex + label.length;
      }

      if (inlineNodes.length > 0) {
        if (cursor < props.text.length) {
          inlineNodes.push(
            <span key={`user-message-terminal-context-inline-rest:${cursor}`}>
              <SkillInlineText text={props.text.slice(cursor)} skills={props.skills} />
            </span>,
          );
        }

        return (
          <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
            {inlineNodes}
          </div>
        );
      }
    }

    for (const context of props.terminalContexts) {
      inlineNodes.push(
        <UserMessageTerminalContextInlineLabel
          key={`user-terminal-context-inline:${context.header}`}
          context={context}
        />,
      );
      inlineNodes.push(
        <span key={`user-terminal-context-inline-space:${context.header}`} aria-hidden="true">
          {" "}
        </span>,
      );
    }

    if (props.text.length > 0) {
      inlineNodes.push(
        <span key="user-message-terminal-context-inline-text">
          <SkillInlineText text={props.text} skills={props.skills} />
        </span>,
      );
    } else if (inlinePrefix.length === 0) {
      return null;
    }

    return (
      <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
        {inlineNodes}
      </div>
    );
  }

  if (props.text.length === 0) {
    return null;
  }

  return (
    <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
      <SkillInlineText text={props.text} skills={props.skills} />
    </div>
  );
});

// ---------------------------------------------------------------------------
// Structural sharing — reuse old row references when data hasn't changed
// so LegendList (and React) can skip re-rendering unchanged items.
// ---------------------------------------------------------------------------

/** Returns a structurally-shared copy of `rows`: for each row whose content
 *  hasn't changed since last call, the previous object reference is reused. */
function useStableRows(rows: MessagesTimelineRow[]): MessagesTimelineRow[] {
  const prevState = useRef<StableMessagesTimelineRowsState>({
    byId: new Map<string, MessagesTimelineRow>(),
    result: [],
  });

  return useMemo(() => {
    const nextState = computeStableMessagesTimelineRows(rows, prevState.current);
    prevState.current = nextState;
    return nextState.result;
  }, [rows]);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatWorkingTimerNow(startIso: string): string {
  return formatWorkingTimer(startIso, new Date().toISOString()) ?? "0s";
}

function formatLiveMessageMetaNow(
  createdAt: string,
  durationStart: string | null | undefined,
  timestampFormat: TimestampFormat,
): string {
  const elapsed = durationStart ? formatElapsed(durationStart, new Date().toISOString()) : null;
  return formatMessageMeta(createdAt, elapsed, timestampFormat);
}

function formatMessageMeta(
  createdAt: string,
  duration: string | null,
  timestampFormat: TimestampFormat,
): string {
  if (!duration) return formatTimestamp(createdAt, timestampFormat);
  return `${formatTimestamp(createdAt, timestampFormat)} • ${duration}`;
}

function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  icon: LucideIcon;
  className: string;
} {
  if (tone === "error") {
    return {
      icon: CircleAlertIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "thinking") {
    return {
      icon: BotIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "info") {
    return {
      icon: CheckIcon,
      className: "text-foreground/92",
    };
  }
  return {
    icon: ZapIcon,
    className: "text-foreground/92",
  };
}

function workToneClass(tone: "thinking" | "tool" | "info" | "error"): string {
  if (tone === "error") return "text-rose-300/50 dark:text-rose-300/50";
  if (tone === "tool") return "text-muted-foreground/70";
  if (tone === "thinking") return "text-muted-foreground/50";
  return "text-muted-foreground/40";
}

function workEntryPreview(
  workEntry: Pick<TimelineWorkEntry, "detail" | "command" | "changedFiles">,
  workspaceRoot: string | undefined,
) {
  if (workEntry.command) return workEntry.command;
  if (workEntry.detail) return workEntry.detail;
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = workEntry.changedFiles ?? [];
  if (!firstPath) return null;
  const displayPath = formatWorkspaceRelativePath(firstPath, workspaceRoot);
  return workEntry.changedFiles!.length === 1
    ? displayPath
    : `${displayPath} +${workEntry.changedFiles!.length - 1} more`;
}

function workEntryRawCommand(
  workEntry: Pick<TimelineWorkEntry, "command" | "rawCommand">,
): string | null {
  const rawCommand = workEntry.rawCommand?.trim();
  if (!rawCommand || !workEntry.command) {
    return null;
  }
  return rawCommand === workEntry.command.trim() ? null : rawCommand;
}

function workEntryIcon(workEntry: TimelineWorkEntry): LucideIcon {
  if (workEntry.requestKind === "command") return TerminalIcon;
  if (workEntry.requestKind === "file-read") return EyeIcon;
  if (workEntry.requestKind === "file-change") return SquarePenIcon;

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return TerminalIcon;
  }
  if (workEntry.itemType === "file_change" || (workEntry.changedFiles?.length ?? 0) > 0) {
    return SquarePenIcon;
  }
  if (workEntry.itemType === "web_search") return GlobeIcon;
  if (workEntry.itemType === "image_view") return EyeIcon;

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return WrenchIcon;
    case "dynamic_tool_call":
    case "collab_agent_tool_call":
      return HammerIcon;
  }

  return workToneIcon(workEntry.tone).icon;
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function toolWorkEntryHeading(workEntry: TimelineWorkEntry): string {
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
}) {
  const { workEntry, workspaceRoot } = props;
  const iconConfig = workToneIcon(workEntry.tone);
  const EntryIcon = workEntryIcon(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const rawPreview = workEntryPreview(workEntry, workspaceRoot);
  const preview =
    rawPreview &&
    normalizeCompactToolLabel(rawPreview).toLowerCase() ===
      normalizeCompactToolLabel(heading).toLowerCase()
      ? null
      : rawPreview;
  const rawCommand = workEntryRawCommand(workEntry);
  const displayText = preview ? `${heading} - ${preview}` : heading;
  const hasChangedFiles = (workEntry.changedFiles?.length ?? 0) > 0;
  const previewIsChangedFiles = hasChangedFiles && !workEntry.command && !workEntry.detail;

  return (
    <div className="rounded-lg px-1 py-1">
      <div className="flex items-center gap-2 transition-[opacity,translate] duration-200">
        <span
          className={cn("flex size-5 shrink-0 items-center justify-center", iconConfig.className)}
        >
          <EntryIcon className="size-3" />
        </span>
        <div className="min-w-0 flex-1 overflow-hidden">
          {rawCommand ? (
            <div className="max-w-full">
              <p
                className={cn(
                  "truncate text-xs leading-5",
                  workToneClass(workEntry.tone),
                  preview ? "text-muted-foreground/70" : "",
                )}
                title={displayText}
              >
                <span className={cn("text-foreground/80", workToneClass(workEntry.tone))}>
                  {heading}
                </span>
                {preview && (
                  <Tooltip>
                    <TooltipTrigger
                      closeDelay={0}
                      delay={75}
                      render={
                        <span className="max-w-full cursor-default text-muted-foreground/55 transition-colors hover:text-muted-foreground/75 focus-visible:text-muted-foreground/75">
                          {" "}
                          - {preview}
                        </span>
                      }
                    />
                    <TooltipPopup
                      align="start"
                      className="max-w-[min(56rem,calc(100vw-2rem))] px-0 py-0"
                      side="top"
                    >
                      <div className="max-w-[min(56rem,calc(100vw-2rem))] overflow-x-auto px-1.5 py-1 font-mono text-[11px] leading-4 whitespace-nowrap">
                        {rawCommand}
                      </div>
                    </TooltipPopup>
                  </Tooltip>
                )}
              </p>
            </div>
          ) : (
            <Tooltip>
              <TooltipTrigger
                className="block min-w-0 w-full text-left"
                title={displayText}
                aria-label={displayText}
              >
                <p
                  className={cn(
                    "truncate text-[11px] leading-5",
                    workToneClass(workEntry.tone),
                    preview ? "text-muted-foreground/70" : "",
                  )}
                >
                  <span className={cn("text-foreground/80", workToneClass(workEntry.tone))}>
                    {heading}
                  </span>
                  {preview && <span className="text-muted-foreground/55"> - {preview}</span>}
                </p>
              </TooltipTrigger>
              <TooltipPopup className="max-w-[min(720px,calc(100vw-2rem))]">
                <p className="whitespace-pre-wrap wrap-break-word text-xs leading-5">
                  {displayText}
                </p>
              </TooltipPopup>
            </Tooltip>
          )}
        </div>
      </div>
      {hasChangedFiles && !previewIsChangedFiles && (
        <div className="mt-1 flex flex-wrap gap-1 pl-6">
          {workEntry.changedFiles?.slice(0, 4).map((filePath) => {
            const displayPath = formatWorkspaceRelativePath(filePath, workspaceRoot);
            return (
              <span
                key={`${workEntry.id}:${filePath}`}
                className="rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/75"
                title={displayPath}
              >
                {displayPath}
              </span>
            );
          })}
          {(workEntry.changedFiles?.length ?? 0) > 4 && (
            <span className="px-1 text-[10px] text-muted-foreground/55">
              +{(workEntry.changedFiles?.length ?? 0) - 4}
            </span>
          )}
        </div>
      )}
    </div>
  );
});
