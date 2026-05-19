# CAD Review System With Three Reviewer Personas

`codex resume 019e338e-0bf8-7103-9822-c5ba9ba9b9f6`

## Summary

Use the transcript analysis as the rubric for a new live CAD review workflow that runs three explicit reviewer
agents against thread CAD context, then synthesizes their outputs into a thread-native review artifact.

The core review philosophy to encode:

- prioritize integration risk, buildability, robustness, and iteration speed over concept elegance
- treat CAD as implementation evidence, not concept art
- predict failure modes before they happen
- reduce scope to the highest-leverage subsystem when schedule is tight

Reviewer personas to hard-code from this meeting:

- systems_integration: James-style reviewer; coupling, interfaces, mounting, materials, dependency reduction,
  precedent-based fixes
- program_readiness: Landon-style reviewer; schedule, team coordination, electronics/programming/manufacturing
  impact, what can realistically ship
- mechanical_robustness: John-style reviewer; contact geometry, snagging, flex, impact, field interaction, subtle
  physical hazards

## Implementation Changes

### Server workflow

- Add a new orchestration command for thread reviews, e.g. thread.review.generate.
- Persist review generation as orchestration events rather than an ad hoc API so the workflow survives reconnects/
  restarts and remains inspectable.
- Add a server-side CadReviewService that:
  - resolves the thread’s CAD context
  - captures a baseline evidence set before any reviewer runs: standard/common CAD views plus screenshots for each
  - makes that baseline evidence available to every reviewer run
  - runs three isolated reviewer passes with persona-specific prompts
  - allows each reviewer to capture additional views during its own pass if needed
  - runs a fourth synthesis pass that merges overlap and emits final action items
- Reuse the existing server text-generation path for the reviewer runs in v1, using one model selection for all four
  passes. Default to ServerSettings.textGenerationModelSelection to keep reviews stable and decoupled from chat-
  model drift.
- Record intermediate lifecycle activity in thread activities:
  - review requested
  - baseline view capture started/completed/failed
  - reviewer pass started/completed/failed per persona
  - synthesis started/completed/failed
- On partial failure, still publish a report marked partial rather than dropping the whole review.

### MCP and reviewer execution

- Every reviewer run must execute with MCP access enabled, including the CAD MCP surface used to inspect and capture
  additional views.
- The pre-captured common views must be attached as first-class review evidence, not just described in text.
- Reviewer prompts must explicitly instruct:
  - first inspect the shared baseline views
  - then use MCP to request more targeted views only where needed to validate risks
  - cite which captured views support each major finding
- The synthesis pass should also have MCP access, but it should primarily consume the persona outputs and the shared
  evidence rather than re-reviewing the CAD from scratch.

### Contracts and persistence

- Extend packages/contracts/src/orchestration.ts with:
  - CadReviewPersona
  - CadReviewStatus
  - CadReviewFinding
  - CadReviewActionItem
  - CadReviewPersonaReport
  - CadReviewReport
  - CadReviewEvidenceArtifact
  - CadReviewToolCall
  - ThreadReviewGenerateCommand
  - ThreadReviewUpsertedPayload
- Add a thread-level persisted review collection in the orchestration read model, parallel to proposed plans rather
  than overloading message text.
- Shape the synthesized report as:
  - whatIsBeingReviewed
  - commonThemes
  - reviewerTraits
  - personaReports
  - mergedActionItems
  - evidenceArtifacts
  - toolCallsByReviewer
  - status
  - createdAt/updatedAt

### Review logic

- Evidence gathering for v1: CAD only.
- Baseline evidence capture must include the common review views needed to orient any reviewer, such as:
  - isometric overall
  - front/back
  - left/right
  - top/bottom where meaningful
  - any default assembly/context view needed to understand packaging
  - (Make sure the views are decently high res)
- Feed each reviewer the same baseline CAD evidence plus a different rubric:
  - systems_integration: interfaces, subsystem coupling, mounting strategy, implementation completeness,
    manufacturability, compatibility with existing robot/workflow
  - program_readiness: scope control, build timeline, owner dependencies, testability, spare/iteration burden,
    rollout feasibility
  - mechanical_robustness: flex points, impact behavior, snagging/collision risk, unsupported spans, jam paths,
    wear/fatigue risk
- Require structured output from each reviewer:
  - top concerns
  - repeated patterns noticed
  - likely failure modes
  - recommended changes
  - confidence and missing evidence
  - which baseline or additional captured views support each finding
- Synthesis pass must:
  - identify what all is being looked at
  - identify what is commonly brought up across reviewers
  - summarize general reviewer traits
  - deduplicate action items by subsystem + issue type
  - assign priority (critical, high, medium, low)
  - preserve disagreement where reviewers diverge

### Web UI

- Add a thread timeline artifact card for reviews in apps/web/src/components/chat/MessagesTimeline.tsx or its
  timeline-entry logic, not the plan sidebar.
- Render a structured review card with:
  - summary header
  - “What’s being reviewed”
  - “Common themes”
  - “Reviewer personas”
  - per-persona findings
  - merged action items
  - baseline captured views
- Add a thread action to trigger review when CAD context is present.
- Show in-progress and partial-failure states using existing thread activity/pending-work patterns instead of
  inventing a separate status model.
- The UI must reflect which reviewer is making which MCP/tool calls:
  - show reviewer identity on activity rows and tool-call entries
  - distinguish shared baseline capture from persona-specific captures
  - preserve ordering so users can see how each reviewer gathered evidence
- If a reviewer captures extra views, surface those under that reviewer’s section and in the activity timeline.

## Public APIs / Types

- New orchestration command: thread.review.generate
- New thread artifact type: CadReviewReport
- New thread event payload: thread.review-upserted
- New read-model field on thread detail: reviews: CadReviewReport[]
- New evidence/tool-call subtypes to associate screenshots and MCP activity with a specific reviewer persona
- No dedicated review panel in v1
- No transcript/notes ingestion in v1

## Test Plan

- Contract tests for new command/event/report/evidence/tool-call schemas.
- Server tests for:
  - baseline common-view capture before reviewer execution
  - persona prompt selection
  - MCP access availability for every reviewer run
  - reviewer-specific additional view capture recording
  - evidence packaging from CAD context
  - partial reviewer failure handling
  - synthesis deduping of repeated findings/action items
  - review card rendering
  - reviewer-labeled tool-call/activity rendering
  - baseline vs reviewer-specific evidence presentation
  - loading/error/partial states
  - timeline ordering with messages, plans, reviews, and activities
- End-to-end scenario coverage:
  - thread with CAD context generates baseline views, then three reviewer reports, then a synthesis report
  - one reviewer captures extra views and the UI attributes them correctly
  - one reviewer fails and synthesis still produces a partial artifact
  - reconnect/replay restores review artifacts and reviewer tool-call attribution correctly
  - thread without CAD context blocks review with a clear error

## Assumptions

- V1 is for live CAD review only; transcript and action-item documents are out of scope.
- “Three subagents” is implemented as three explicit server-managed reviewer runs plus one synthesis run, not
  provider-native spawn_agent delegation.
- Review output lives as a thread artifact inside the existing orchestration/timeline flow.
- Every reviewer and the synthesis run have MCP access.
- The meeting transcript above is the source for the initial persona definitions and synthesis rubric.
- Codex support first, will worry about other harnesses later.

## Action Item List example (Ignore timestamps and @ mentions, look only at the actual content... full review will probably be longer also):

- modify intake design by adding stiffening plates to prevent belt flex [38:16].
- add a "roof" to the hopper to increase structural rigidity [26:56]
- create an assembly of the design with the Everybot shooter and share to electricians for electronics placement planning [31:56].
- Team to review transfer roller spacing and potentially adjust to ensure consistent fuel movement [36:42].
- @Derek Wei to consider implementing bungee loading for the hopper mechanism [25:57].
- Square off end of intake plate to act as a hard stop for the hopper.
- Model in fasteners to ensure there aren't any surprise interferences. \* Potentially increase ramp angle of roller floor
- Make roller floor have even spacing between rollers and make the spacing as small as possible
- Add chain tensioner to intake pivot chain (turnbuckle)
- Start with aluminum for jackshaft, potentially upgrade to steel if more rigidity is needed
