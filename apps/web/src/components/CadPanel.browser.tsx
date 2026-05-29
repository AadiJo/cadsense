import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThreadId } from "@cadsense/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useUiStateStore } from "../uiStateStore";

const environmentId = "environment-cad-browser";
const threadId = ThreadId.make("thread-cad-browser");
const projectId = "project-cad-browser";
const activeReview = {
  id: "cad-review-browser",
  status: "reviewing",
} as const;

let cadFrameUrl = "";
const observedFrameRequests: unknown[] = [];
let threadReviews: Array<typeof activeReview> = [];
let cadViewCommandHandler:
  | ((command: {
      readonly threadId: string;
      readonly type: "set-exploded" | "set-view";
      readonly exploded?: boolean;
      readonly view?: "front";
      readonly fit?: boolean;
    }) => void)
  | null = null;
let cadHierarchyRequestHandler:
  | ((request: { readonly requestId: string; readonly threadId: string }) => void)
  | null = null;
const uploadedCadHierarchies: unknown[] = [];

const onshapeContext = {
  provider: "onshape" as const,
  onshape: {
    connectionId: "onshape-test",
    entityId: "entity-test",
    entityKind: "part" as const,
    name: "CAD Browser Test",
    breadcrumb: ["CAD Browser Test"],
    reference: {
      baseUrl: "https://cad.onshape.com",
      documentId: "doc",
      elementId: "element",
      url: "https://cad.onshape.com/documents/doc/w/workspace/e/element",
    },
    lastSyncedRelativePath: "onshape-sync/current.3mf",
    lastSyncedAt: "2026-05-20T00:00:00.000Z",
  },
};

vi.mock("@tanstack/react-router", () => ({
  useParams: (input: { select?: (params: Record<string, unknown>) => unknown }) => {
    const params = { environmentId, threadId };
    return input.select ? input.select(params) : params;
  },
}));

vi.mock("../environmentApi", () => ({
  readEnvironmentApi: () => ({
    onshape: {
      listSyncedCadFiles: vi.fn(async () => ({
        files: [
          {
            relativePath: "onshape-sync/current.3mf",
            url: "/api/onshape/cad-model/current.3mf?cwd=C%3A%5Ccad&path=onshape-sync%2Fcurrent.3mf",
            isPreferred: true,
            sizeBytes: 1024,
          },
        ],
      })),
      onCadViewCommand: vi.fn((handler) => {
        cadViewCommandHandler = handler;
        return () => {
          if (cadViewCommandHandler === handler) {
            cadViewCommandHandler = null;
          }
        };
      }),
      onCadHierarchyRequest: vi.fn((handler) => {
        cadHierarchyRequestHandler = handler;
        return () => {
          if (cadHierarchyRequestHandler === handler) {
            cadHierarchyRequestHandler = null;
          }
        };
      }),
      uploadCadHierarchy: vi.fn(async (input) => {
        uploadedCadHierarchies.push(input);
        return { components: [] };
      }),
      onCadScreenshotRequest: vi.fn(() => () => undefined),
      uploadCadScreenshot: vi.fn(async () => undefined),
    },
  }),
}));

vi.mock("../storeSelectors", () => ({
  createThreadSelectorByRef: () => () => ({
    id: threadId,
    environmentId,
    projectId,
    messages: [],
    latestTurn: null,
    session: null,
    externalContext: null,
    worktreePath: null,
    reviews: threadReviews,
  }),
}));

vi.mock("../store", () => ({
  selectProjectByRef: () => ({
    id: projectId,
    environmentId,
    cwd: "C:\\cad",
    externalContext: onshapeContext,
  }),
  useStore: (selector: (state: unknown) => unknown) => selector({}),
}));

vi.mock("../composerDraftStore", () => ({
  DraftId: { make: (value: string) => value },
  useComposerDraftStore: () => null,
}));

vi.mock("./CadPanel.logic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./CadPanel.logic")>();
  return {
    ...actual,
    CAD_MODEL_LOAD_TIMEOUT_MS: 750,
    cadViewerFrameUrl: () => cadFrameUrl,
  };
});

function delayedReadyFrameUrl(): string {
  const html = String.raw`
    <!doctype html>
    <html>
      <body>
        <script>
          setTimeout(() => {
            window.addEventListener("message", (event) => {
              if (event.data?.source !== "cadsense-cad-viewer-parent") return;
              parent.postMessage({
                source: "cad-test-frame-observation",
                request: event.data
              }, "*");
              if (!["load-file-urls", "set-exploded", "set-view", "set-camera"].includes(event.data?.type)) return;
              parent.postMessage({
                source: "cadsense-cad-viewer-frame",
                type: "response",
                requestId: event.data.requestId,
                ok: true,
                payload: {
                  loadStats: {
                    strategy: "three-3mf-direct-url",
                    bytes: 1024,
                    fetchMs: 0,
                    importMs: 1,
                    totalMs: 1
                  }
                }
              }, "*");
            });
            parent.postMessage({ source: "cadsense-cad-viewer-frame", type: "ready" }, "*");
          }, 75);
        </script>
      </body>
    </html>
  `;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function stalledAfterLoadFrameUrl(): string {
  const html = String.raw`
    <!doctype html>
    <html>
      <body>
        <script>
          window.addEventListener("message", (event) => {
            if (event.data?.source !== "cadsense-cad-viewer-parent") return;
            parent.postMessage({
              source: "cad-test-frame-observation",
              request: event.data
            }, "*");
            if (event.data?.type !== "load-file-urls") return;
            parent.postMessage({
              source: "cadsense-cad-viewer-frame",
              type: "response",
              requestId: event.data.requestId,
              ok: true,
              payload: {
                loadStats: {
                  strategy: "three-3mf-direct-url",
                  bytes: 1024,
                  fetchMs: 0,
                  importMs: 1,
                  totalMs: 1
                }
              }
            }, "*");
          });
          parent.postMessage({ source: "cadsense-cad-viewer-frame", type: "ready" }, "*");
        </script>
      </body>
    </html>
  `;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

describe("CadPanel browser behavior", () => {
  afterEach(() => {
    vi.clearAllMocks();
    observedFrameRequests.length = 0;
    cadViewCommandHandler = null;
    cadHierarchyRequestHandler = null;
    uploadedCadHierarchies.length = 0;
    threadReviews = [];
    useUiStateStore.setState({
      cadExplodedByThreadId: {},
      cadZoomToFitRequestByThreadId: {},
      cadAgentViewStateByThreadId: {},
    });
  });

  it("waits for the viewer frame protocol ready message before sending the model load request", async () => {
    cadFrameUrl = delayedReadyFrameUrl();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const CadPanel = (await import("./CadPanel")).default;

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <div style={{ width: "640px", height: "420px" }}>
          <CadPanel />
        </div>
      </QueryClientProvider>,
    );

    await expect.element(page.getByText("Drag to rotate, scroll to zoom")).toBeVisible();

    await screen.unmount();
    queryClient.clear();
  });

  it("resets stale project-scoped explode state before replaying viewer state after load", async () => {
    cadFrameUrl = delayedReadyFrameUrl();
    useUiStateStore.getState().setCadExploded(projectId, true);

    const onObservedRequest = (event: MessageEvent<unknown>) => {
      if (
        typeof event.data === "object" &&
        event.data !== null &&
        "source" in event.data &&
        event.data.source === "cad-test-frame-observation" &&
        "request" in event.data
      ) {
        observedFrameRequests.push(event.data.request);
      }
    };
    window.addEventListener("message", onObservedRequest);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const CadPanel = (await import("./CadPanel")).default;

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <div style={{ width: "640px", height: "420px" }}>
          <CadPanel />
        </div>
      </QueryClientProvider>,
    );

    await expect.element(page.getByText("Drag to rotate, scroll to zoom")).toBeVisible();
    await vi.waitFor(() => {
      expect(observedFrameRequests).toContainEqual(
        expect.objectContaining({ type: "set-exploded", enabled: false }),
      );
    });
    expect(useUiStateStore.getState().cadExplodedByThreadId[projectId]).toBe(false);

    window.removeEventListener("message", onObservedRequest);
    await screen.unmount();
    queryClient.clear();
  });

  it("syncs external exploded view commands into the header toggle state", async () => {
    cadFrameUrl = delayedReadyFrameUrl();
    const onObservedRequest = (event: MessageEvent<unknown>) => {
      if (
        typeof event.data === "object" &&
        event.data !== null &&
        "source" in event.data &&
        event.data.source === "cad-test-frame-observation" &&
        "request" in event.data
      ) {
        observedFrameRequests.push(event.data.request);
      }
    };
    window.addEventListener("message", onObservedRequest);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const CadPanel = (await import("./CadPanel")).default;

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <div style={{ width: "640px", height: "420px" }}>
          <CadPanel />
        </div>
      </QueryClientProvider>,
    );

    await expect.element(page.getByText("Drag to rotate, scroll to zoom")).toBeVisible();
    await vi.waitFor(() => expect(cadViewCommandHandler).toBeTypeOf("function"));
    await vi.waitFor(() => {
      expect(observedFrameRequests).toContainEqual(
        expect.objectContaining({ type: "set-exploded", enabled: false }),
      );
    });

    cadViewCommandHandler?.({ threadId, type: "set-exploded", exploded: true });

    await vi.waitFor(() => {
      expect(useUiStateStore.getState().cadExplodedByThreadId[projectId]).toBe(true);
    });

    window.removeEventListener("message", onObservedRequest);
    await screen.unmount();
    queryClient.clear();
  });

  it("answers CAD hierarchy requests from normal visible chats", async () => {
    cadFrameUrl = delayedReadyFrameUrl();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const CadPanel = (await import("./CadPanel")).default;

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <div style={{ width: "640px", height: "420px" }}>
          <CadPanel />
        </div>
      </QueryClientProvider>,
    );

    await expect.element(page.getByText("Drag to rotate, scroll to zoom")).toBeVisible();
    await vi.waitFor(() => expect(cadHierarchyRequestHandler).toBeTypeOf("function"));

    cadHierarchyRequestHandler?.({ requestId: "hierarchy-normal-chat", threadId });

    await vi.waitFor(() => {
      expect(uploadedCadHierarchies).toContainEqual({
        requestId: "hierarchy-normal-chat",
        components: [],
      });
    });

    await screen.unmount();
    queryClient.clear();
  });

  it("answers CAD hierarchy requests while the visible thread has an active CAD review", async () => {
    cadFrameUrl = delayedReadyFrameUrl();
    threadReviews = [activeReview];
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const CadPanel = (await import("./CadPanel")).default;

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <div style={{ width: "640px", height: "420px" }}>
          <CadPanel />
        </div>
      </QueryClientProvider>,
    );

    await expect.element(page.getByText("Drag to rotate, scroll to zoom")).toBeVisible();
    await vi.waitFor(() => expect(cadHierarchyRequestHandler).toBeTypeOf("function"));

    cadHierarchyRequestHandler?.({ requestId: "hierarchy-active-review", threadId });

    await vi.waitFor(() => {
      expect(uploadedCadHierarchies).toContainEqual({
        requestId: "hierarchy-active-review",
        components: [],
      });
    });

    await screen.unmount();
    queryClient.clear();
  });

  it("replays the composite agent-controlled CAD state after the viewer loads", async () => {
    cadFrameUrl = delayedReadyFrameUrl();
    threadReviews = [activeReview];
    useUiStateStore.getState().recordCadAgentViewCommand(threadId, {
      commandId: "agent-view-right",
      threadId,
      type: "set-view",
      view: "right",
      fit: true,
      createdAt: "2026-05-20T00:00:00.000Z",
    });
    useUiStateStore.getState().recordCadAgentViewCommand(threadId, {
      commandId: "agent-exploded",
      threadId,
      type: "set-exploded",
      exploded: true,
      createdAt: "2026-05-20T00:00:01.000Z",
    });

    const onObservedRequest = (event: MessageEvent<unknown>) => {
      if (
        typeof event.data === "object" &&
        event.data !== null &&
        "source" in event.data &&
        event.data.source === "cad-test-frame-observation" &&
        "request" in event.data
      ) {
        observedFrameRequests.push(event.data.request);
      }
    };
    window.addEventListener("message", onObservedRequest);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const CadPanel = (await import("./CadPanel")).default;

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <div style={{ width: "640px", height: "420px" }}>
          <CadPanel />
        </div>
      </QueryClientProvider>,
    );

    await expect.element(page.getByText("Drag to rotate, scroll to zoom")).toBeVisible();
    await vi.waitFor(() => {
      expect(observedFrameRequests).toContainEqual(
        expect.objectContaining({ type: "set-view", view: "right", fit: true }),
      );
      expect(observedFrameRequests).toContainEqual(
        expect.objectContaining({ type: "set-exploded", enabled: true }),
      );
    });

    window.removeEventListener("message", onObservedRequest);
    await screen.unmount();
    queryClient.clear();
  });

  it("recycles the viewer iframe after repeated post-load protocol stalls", async () => {
    cadFrameUrl = stalledAfterLoadFrameUrl();
    const onObservedRequest = (event: MessageEvent<unknown>) => {
      if (
        typeof event.data === "object" &&
        event.data !== null &&
        "source" in event.data &&
        event.data.source === "cad-test-frame-observation" &&
        "request" in event.data
      ) {
        observedFrameRequests.push(event.data.request);
      }
    };
    window.addEventListener("message", onObservedRequest);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const CadPanel = (await import("./CadPanel")).default;

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <div style={{ width: "640px", height: "420px" }}>
          <CadPanel />
        </div>
      </QueryClientProvider>,
    );

    await expect.element(page.getByText("Drag to rotate, scroll to zoom")).toBeVisible();
    await vi.waitFor(() => expect(cadViewCommandHandler).toBeTypeOf("function"));

    cadViewCommandHandler?.({ threadId, type: "set-view", view: "front", fit: true });
    cadViewCommandHandler?.({ threadId, type: "set-view", view: "front", fit: true });

    await vi.waitFor(
      () => {
        const loadRequests = observedFrameRequests.filter(
          (request) =>
            typeof request === "object" &&
            request !== null &&
            "type" in request &&
            request.type === "load-file-urls",
        );
        expect(loadRequests.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 8_000 },
    );

    window.removeEventListener("message", onObservedRequest);
    await screen.unmount();
    queryClient.clear();
  });

  it("covers fullscreen layout changes and keeps the control anchored during entry", async () => {
    cadFrameUrl = delayedReadyFrameUrl();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const CadPanel = (await import("./CadPanel")).default;

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <div style={{ width: "640px", height: "420px" }}>
          <CadPanel />
        </div>
      </QueryClientProvider>,
    );

    await expect.element(page.getByText("Drag to rotate, scroll to zoom")).toBeVisible();

    const expandButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Expand CAD view"]',
    );
    expect(expandButton).toBeTruthy();
    const initialRect = expandButton!.getBoundingClientRect();

    expandButton!.click();
    await new Promise((resolve) => setTimeout(resolve, 320));

    const anchoredButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Exit fullscreen CAD view"]',
    );
    expect(anchoredButton).toBeTruthy();
    const anchoredRect = anchoredButton!.getBoundingClientRect();
    expect(Math.abs(anchoredRect.left - initialRect.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(anchoredRect.top - initialRect.top)).toBeLessThanOrEqual(1);

    await vi.waitFor(() => {
      const releasedButton = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Exit fullscreen CAD view"]',
      );
      expect(releasedButton).toBeTruthy();
      const releasedRect = releasedButton!.getBoundingClientRect();
      expect(releasedRect.top).toBeGreaterThanOrEqual(48);
    });

    await page.getByRole("button", { name: "Exit fullscreen CAD view" }).click();
    await screen.unmount();
    queryClient.clear();
  });
});
