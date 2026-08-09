import { EnvironmentId, ThreadId, type CadReviewReport } from "@cadsense/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const visibleThreadId = ThreadId.make("thread-visible-review");
const backgroundThreadId = ThreadId.make("thread-background-review");
const secondBackgroundThreadId = ThreadId.make("thread-second-background-review");
const environmentId = EnvironmentId.make("environment-local");

vi.mock("@tanstack/react-router", () => ({
  useParams: (input: { select?: (params: Record<string, string>) => unknown }) => {
    const params = { environmentId, threadId: visibleThreadId };
    return input.select ? input.select(params) : params;
  },
}));

vi.mock("../environmentApi", () => ({
  readEnvironmentApi: () => undefined,
}));

vi.mock("./CadPanel", () => ({
  default: (props: { threadRef?: { threadId: string } }) => (
    <div data-testid="cad-panel">{props.threadRef?.threadId}</div>
  ),
}));

function review(status: CadReviewReport["status"]) {
  return {
    id: "review-1",
    status,
  } as CadReviewReport;
}

vi.mock("../store", () => ({
  useStore: (selector: (state: unknown) => unknown) =>
    selector({
      environmentStateById: {
        [environmentId]: {
          threadIds: [visibleThreadId, backgroundThreadId, secondBackgroundThreadId],
          threadShellById: {
            [visibleThreadId]: {
              id: visibleThreadId,
              environmentId,
              projectId: "project-1",
            },
            [backgroundThreadId]: {
              id: backgroundThreadId,
              environmentId,
              projectId: "project-1",
            },
            [secondBackgroundThreadId]: {
              id: secondBackgroundThreadId,
              environmentId,
              projectId: "project-2",
            },
          },
          threadSessionById: {},
          threadTurnStateById: {},
          messageIdsByThreadId: {},
          messageByThreadId: {},
          activityIdsByThreadId: {},
          activityByThreadId: {},
          proposedPlanIdsByThreadId: {},
          proposedPlanByThreadId: {},
          turnDiffIdsByThreadId: {},
          turnDiffSummaryByThreadId: {},
          reviewIdsByThreadId: {
            [visibleThreadId]: ["review-visible"],
            [backgroundThreadId]: ["review-background"],
            [secondBackgroundThreadId]: ["review-second-background"],
          },
          reviewByThreadId: {
            [visibleThreadId]: {
              "review-visible": review("reviewing"),
            },
            [backgroundThreadId]: {
              "review-background": review("reviewing"),
            },
            [secondBackgroundThreadId]: {
              "review-second-background": review("reviewing"),
            },
          },
        },
      },
    }),
}));

describe("CadReviewAgentControlHost", () => {
  it("does not mount a hidden CAD panel for the thread already visible in the route", async () => {
    const { CadReviewAgentControlHost } = await import("./CadReviewAgentControlHost");

    const markup = renderToStaticMarkup(<CadReviewAgentControlHost />);

    expect(markup).toContain(backgroundThreadId);
    expect(markup).not.toContain(visibleThreadId);
    expect(markup.match(/data-testid="cad-panel"/g)).toHaveLength(1);
    expect(markup).toContain('data-cad-review-host-candidate-count="2"');
  });
});
