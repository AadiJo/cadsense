import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  EnvironmentId,
  EventId,
  ThreadId,
  TurnId,
  type CadViewCommand,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
} from "@cadsense/contracts";
import { scopedThreadKey, scopeThreadRef } from "@cadsense/client-runtime";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useUiStateStore } from "../uiStateStore";

const environmentId = EnvironmentId.make("environment-cad-browser");
const threadId = ThreadId.make("thread-cad-browser");
const cadUiStateKey = scopedThreadKey(scopeThreadRef(environmentId, threadId));
const sameProjectThreadId = ThreadId.make("thread-cad-browser-same-project");
const projectThreadIds = [threadId, sameProjectThreadId] as const;
const projectId = "project-cad-browser";
const activeReview = {
  id: "cad-review-browser",
  status: "reviewing",
  createdAt: "2026-05-20T00:00:00.000Z",
  updatedAt: "2026-05-20T00:00:00.000Z",
} as const;
const streamingTurnId = TurnId.make("turn-cad-streaming");

let cadFrameUrl = "";
const observedFrameRequests: unknown[] = [];
let threadReviews: Array<typeof activeReview> = [];
let threadActivities: OrchestrationThreadActivity[] = [];
let threadMessages: Array<{ readonly streaming: boolean }> = [];
let latestTurn: OrchestrationLatestTurn | null = null;
let cadViewCommandHandler: ((command: CadViewCommand) => void) | null = null;
let cadHierarchyRequestHandler:
  | ((request: { readonly requestId: string; readonly threadId: string }) => void)
  | null = null;
const uploadedCadHierarchies: unknown[] = [];
let cadScreenshotRequestHandler:
  | ((request: {
      readonly requestId: string;
      readonly threadId: string;
      readonly view?: "front";
      readonly fit: boolean;
    }) => void)
  | null = null;
const uploadedCadScreenshots: unknown[] = [];
const mockActiveThread = {
  id: threadId,
  environmentId,
  projectId,
  get messages() {
    return threadMessages;
  },
  get activities() {
    return threadActivities;
  },
  get latestTurn() {
    return latestTurn;
  },
  session: null,
  externalContext: null,
  worktreePath: null,
  get reviews() {
    return threadReviews;
  },
};

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
        return { components: [], status: input.status ?? "loaded" };
      }),
      onCadScreenshotRequest: vi.fn((handler) => {
        cadScreenshotRequestHandler = handler;
        return () => {
          if (cadScreenshotRequestHandler === handler) {
            cadScreenshotRequestHandler = null;
          }
        };
      }),
      uploadCadScreenshot: vi.fn(async (input) => {
        uploadedCadScreenshots.push(input);
        return { absolutePath: "C:\\cad\\shot.png", relativePath: "shot.png" };
      }),
    },
  }),
}));

vi.mock("../storeSelectors", () => ({
  createThreadSelectorByRef: () => () => mockActiveThread,
}));

vi.mock("../store", () => ({
  selectProjectByRef: () => ({
    id: projectId,
    environmentId,
    cwd: "C:\\cad",
    externalContext: onshapeContext,
  }),
  useStore: (selector: (state: unknown) => unknown) =>
    selector({
      environmentStateById: {
        [environmentId]: {
          threadIds: projectThreadIds,
          threadIdsByProjectId: {
            [projectId]: projectThreadIds,
          },
        },
      },
    }),
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

function delayedReadyFrameUrl(readyDelayMs = 75): string {
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
              if (event.data?.type === "get-components") {
                parent.postMessage({
                  source: "cadsense-cad-viewer-frame",
                  type: "response",
                  requestId: event.data.requestId,
                  ok: true,
                  payload: { components: [] }
                }, "*");
                return;
              }
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
          }, ${readyDelayMs});
        </script>
      </body>
    </html>
  `;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function componentVisibilityFrameUrl(): string {
  const html = String.raw`
    <!doctype html>
    <html>
      <body>
        <script>
          let components = [
            {
              id: "model",
              name: "Model",
              kind: "assembly",
              hasChildren: true,
              visible: true
            },
            {
              id: "drive",
              parentId: "model",
              name: "Drivetrain",
              kind: "assembly",
              hasChildren: true,
              visible: true
            },
            {
              id: "left-wheel",
              parentId: "drive",
              name: "Left Wheel",
              kind: "part",
              hasChildren: false,
              visible: true
            }
          ];
          const subtreeIds = (componentId) => {
            const ids = new Set([componentId]);
            let changed = true;
            while (changed) {
              changed = false;
              for (const component of components) {
                if (component.parentId && ids.has(component.parentId) && !ids.has(component.id)) {
                  ids.add(component.id);
                  changed = true;
                }
              }
            }
            return ids;
          };
          const respond = (requestId, payload = {}) => {
            parent.postMessage({
              source: "cadsense-cad-viewer-frame",
              type: "response",
              requestId,
              ok: true,
              payload
            }, "*");
          };
          window.addEventListener("message", (event) => {
            if (event.data?.source !== "cadsense-cad-viewer-parent") return;
            parent.postMessage({
              source: "cad-test-frame-observation",
              request: event.data
            }, "*");
            if (event.data?.type === "load-file-urls") {
              respond(event.data.requestId, {
                loadStats: {
                  strategy: "three-3mf-direct-url",
                  bytes: 1024,
                  fetchMs: 0,
                  importMs: 1,
                  totalMs: 1
                }
              });
              return;
            }
            if (event.data?.type === "get-components") {
              respond(event.data.requestId, { components });
              return;
            }
            if (event.data?.type === "set-component-visibility") {
              const ids = subtreeIds(event.data.componentId);
              components = components.map((component) =>
                ids.has(component.id) ? { ...component, visible: event.data.visible } : component
              );
              respond(event.data.requestId, { components });
              return;
            }
            if (["set-exploded", "set-view", "set-camera"].includes(event.data?.type)) {
              respond(event.data.requestId);
            }
          });
          parent.postMessage({ source: "cadsense-cad-viewer-frame", type: "ready" }, "*");
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

function screenshotFrameUrl(): string {
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
            if (event.data?.type === "load-file-urls") {
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
              return;
            }
            if (event.data?.type === "set-view" || event.data?.type === "capture") {
              parent.postMessage({
                source: "cadsense-cad-viewer-frame",
                type: "response",
                requestId: event.data.requestId,
                ok: true,
                payload: event.data.type === "capture" ? { pngBase64: "cG5n" } : {}
              }, "*");
            }
          });
          parent.postMessage({ source: "cadsense-cad-viewer-frame", type: "ready" }, "*");
        </script>
      </body>
    </html>
  `;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function makeRunningLatestTurn(): OrchestrationLatestTurn {
  return {
    turnId: streamingTurnId,
    state: "running",
    requestedAt: "2026-05-20T00:00:00.000Z",
    startedAt: "2026-05-20T00:00:01.000Z",
    completedAt: null,
    assistantMessageId: null,
  };
}

function makeCadToolActivity(input: {
  readonly id: string;
  readonly createdAt: string;
  readonly detail?: string;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(input.id),
    tone: "tool",
    kind: "tool.completed",
    summary: "Used CAD view",
    payload: {
      detail: input.detail ?? "set_cad_view",
      title: "Set CAD view",
      data: {
        item: {
          arguments: { view: "front", fit: true },
          status: "completed",
        },
      },
    },
    turnId: streamingTurnId,
    createdAt: input.createdAt,
  };
}

async function waitForCadLoadState(state: "idle" | "loading" | "loaded" | "error") {
  await vi.waitFor(() => {
    expect(document.querySelector(`[data-cad-load-state="${state}"]`)).toBeTruthy();
  });
}

describe("CadPanel browser behavior", () => {
  afterEach(() => {
    vi.clearAllMocks();
    observedFrameRequests.length = 0;
    cadViewCommandHandler = null;
    cadHierarchyRequestHandler = null;
    uploadedCadHierarchies.length = 0;
    cadScreenshotRequestHandler = null;
    uploadedCadScreenshots.length = 0;
    threadReviews = [];
    threadActivities = [];
    threadMessages = [];
    latestTurn = null;
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

    await waitForCadLoadState("loaded");
    await waitForCadLoadState("loaded");
    await waitForCadLoadState("loaded");
    await expect.element(page.getByText("Drag to rotate, scroll to zoom")).toBeVisible();

    await screen.unmount();
    queryClient.clear();
  });

  it("blocks CAD interaction while a message is streaming", async () => {
    cadFrameUrl = delayedReadyFrameUrl();
    threadMessages = [{ streaming: true }];

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

    await waitForCadLoadState("loaded");
    await expect.element(page.getByText("Drag to rotate, scroll to zoom")).toBeVisible();
    expect(document.querySelector('[data-cad-interaction-blocker="true"]')).toBeTruthy();
    expect(
      document
        .querySelector<HTMLElement>('[aria-label="CAD viewer toolbar"]')
        ?.getAttribute("aria-disabled"),
    ).toBe("true");

    await screen.unmount();
    queryClient.clear();
  });

  it("keeps the CAD toolbar compact without horizontal scrolling", async () => {
    cadFrameUrl = delayedReadyFrameUrl();

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const CadPanel = (await import("./CadPanel")).default;

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <div style={{ width: "320px", height: "360px" }}>
          <CadPanel />
        </div>
      </QueryClientProvider>,
    );

    await waitForCadLoadState("loaded");
    const toolbar = document.querySelector<HTMLElement>('[aria-label="CAD viewer toolbar"]');
    expect(toolbar).toBeTruthy();
    expect(toolbar!.className).toContain("overflow-hidden");
    expect(toolbar!.className).not.toContain("overflow-x-auto");
    expect(toolbar!.scrollWidth).toBeLessThanOrEqual(toolbar!.clientWidth + 1);

    await screen.unmount();
    queryClient.clear();
  });

  it("shows agent control as soon as a CAD view command drives the viewer", async () => {
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
    await vi.waitFor(() => expect(cadViewCommandHandler).toBeTypeOf("function"));

    cadViewCommandHandler?.({
      commandId: "command-front-view",
      threadId,
      type: "set-view",
      view: "front",
      fit: true,
      createdAt: "2026-05-20T00:00:02.000Z",
    });

    await expect.element(page.getByText("Agent control")).toBeVisible();
    const viewerFrame = document.querySelector<HTMLIFrameElement>(
      'iframe[title="CAD model viewer"]',
    );
    const overlayRect = document
      .querySelector<HTMLElement>('[data-cad-agent-control-overlay="true"]')
      ?.getBoundingClientRect();
    const overlay = document.querySelector<HTMLElement>('[data-cad-agent-control-overlay="true"]');
    expect(viewerFrame).toBeTruthy();
    expect(overlay).toBeTruthy();
    expect(overlayRect).toBeTruthy();
    expect(overlay!.parentElement).toBe(viewerFrame!.parentElement);
    expect(overlay!.className).toContain("absolute");
    expect(overlay!.className).toContain("inset-0");
    expect(overlay!.className).not.toContain("fixed");

    await screen.unmount();
    queryClient.clear();
  });

  it("shows agent control for a CAD tool call before fading out", async () => {
    cadFrameUrl = delayedReadyFrameUrl();
    latestTurn = makeRunningLatestTurn();
    threadActivities = [
      makeCadToolActivity({
        id: "cad-tool-front-view",
        createdAt: "2026-05-20T00:00:02.000Z",
      }),
    ];

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
    await expect.element(page.getByText("Agent control")).toBeVisible();
    expect(document.querySelector(".cad-agent-control-pill")).toBeTruthy();

    await vi.waitFor(
      () => {
        expect(document.querySelector('.cad-agent-control-pill[data-ending="true"]')).toBeTruthy();
      },
      { timeout: 3_500 },
    );
    await vi.waitFor(
      () => {
        expect(document.querySelector(".cad-agent-control-pill")).toBeNull();
      },
      { timeout: 1_000 },
    );

    await screen.unmount();
    queryClient.clear();
  });

  it("ignores stale project-scoped explode state before replaying viewer state after load", async () => {
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
    expect(useUiStateStore.getState().cadExplodedByThreadId[projectId]).toBe(true);
    expect(useUiStateStore.getState().cadExplodedByThreadId[cadUiStateKey]).toBeUndefined();

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

    cadViewCommandHandler?.({
      commandId: "command-exploded",
      threadId,
      type: "set-exploded",
      exploded: true,
      createdAt: "2026-05-20T00:00:03.000Z",
    });

    await vi.waitFor(() => {
      expect(useUiStateStore.getState().cadExplodedByThreadId[cadUiStateKey]).toBe(true);
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

    await waitForCadLoadState("loaded");
    await expect.element(page.getByText("Drag to rotate, scroll to zoom")).toBeVisible();
    await vi.waitFor(() => expect(cadHierarchyRequestHandler).toBeTypeOf("function"));

    cadHierarchyRequestHandler?.({ requestId: "hierarchy-normal-chat", threadId });

    await vi.waitFor(() => {
      expect(uploadedCadHierarchies).toContainEqual({
        requestId: "hierarchy-normal-chat",
        components: [],
        status: "loaded",
      });
    });

    await screen.unmount();
    queryClient.clear();
  });

  it("applies CAD component visibility commands to the returned hierarchy subtree", async () => {
    cadFrameUrl = componentVisibilityFrameUrl();
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

    await waitForCadLoadState("loaded");
    await vi.waitFor(() => expect(cadViewCommandHandler).toBeTypeOf("function"));
    await vi.waitFor(() => expect(cadHierarchyRequestHandler).toBeTypeOf("function"));

    cadViewCommandHandler?.({
      commandId: "hide-drive",
      threadId,
      type: "set-component-visibility",
      componentId: "drive",
      visible: false,
      createdAt: "2026-05-20T00:00:04.000Z",
    });

    await vi.waitFor(() => {
      expect(observedFrameRequests).toContainEqual(
        expect.objectContaining({
          type: "set-component-visibility",
          componentId: "drive",
          visible: false,
        }),
      );
      expect(
        useUiStateStore.getState().cadAgentViewStateByThreadId[cadUiStateKey]
          ?.componentVisibilityById,
      ).toMatchObject({ drive: false });
    });

    cadHierarchyRequestHandler?.({ requestId: "hierarchy-after-hide-drive", threadId });

    await vi.waitFor(() => {
      expect(uploadedCadHierarchies).toContainEqual(
        expect.objectContaining({
          requestId: "hierarchy-after-hide-drive",
          status: "loaded",
          components: expect.arrayContaining([
            expect.objectContaining({ id: "drive", visible: false }),
            expect.objectContaining({ id: "left-wheel", visible: false }),
          ]),
        }),
      );
    });

    window.removeEventListener("message", onObservedRequest);
    await screen.unmount();
    queryClient.clear();
  });

  it("reports that CAD hierarchy is loading instead of returning an empty loaded hierarchy", async () => {
    cadFrameUrl = delayedReadyFrameUrl(5_000);
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

    await waitForCadLoadState("loading");
    await expect.element(page.getByText("Loading CAD model")).toBeVisible();
    await vi.waitFor(() => expect(cadHierarchyRequestHandler).toBeTypeOf("function"));

    cadHierarchyRequestHandler?.({ requestId: "hierarchy-loading", threadId });

    await vi.waitFor(() => {
      expect(uploadedCadHierarchies).toContainEqual({
        requestId: "hierarchy-loading",
        components: [],
        status: "loading",
        message: expect.stringContaining("still loading"),
      });
    });

    await screen.unmount();
    queryClient.clear();
  });

  it("answers CAD hierarchy requests from another thread in the same project", async () => {
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

    await waitForCadLoadState("loaded");
    await expect.element(page.getByText("Drag to rotate, scroll to zoom")).toBeVisible();
    await vi.waitFor(() => expect(cadHierarchyRequestHandler).toBeTypeOf("function"));

    cadHierarchyRequestHandler?.({
      requestId: "hierarchy-same-project-thread",
      threadId: sameProjectThreadId,
    });

    await vi.waitFor(() => {
      expect(uploadedCadHierarchies).toContainEqual({
        requestId: "hierarchy-same-project-thread",
        components: [],
        status: "loaded",
      });
    });

    await screen.unmount();
    queryClient.clear();
  });

  it("answers active review CAD hierarchy requests for the visible thread", async () => {
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

    await waitForCadLoadState("loaded");
    await expect.element(page.getByText("Drag to rotate, scroll to zoom")).toBeVisible();
    await vi.waitFor(() => expect(cadHierarchyRequestHandler).toBeTypeOf("function"));

    cadHierarchyRequestHandler?.({ requestId: "hierarchy-active-review", threadId });

    await vi.waitFor(() => {
      expect(uploadedCadHierarchies).toContainEqual({
        requestId: "hierarchy-active-review",
        components: [],
        status: "loaded",
      });
    });

    await screen.unmount();
    queryClient.clear();
  });

  it("applies requested screenshot views before capturing the current CAD canvas", async () => {
    cadFrameUrl = screenshotFrameUrl();
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

    await waitForCadLoadState("loaded");
    await expect.element(page.getByText("Drag to rotate, scroll to zoom")).toBeVisible();
    await vi.waitFor(() => expect(cadScreenshotRequestHandler).toBeTypeOf("function"));

    cadScreenshotRequestHandler?.({
      requestId: "screenshot-front",
      threadId,
      view: "front",
      fit: true,
    });

    await vi.waitFor(() => {
      const captureRequests = observedFrameRequests.filter(
        (request): request is { readonly type: string; readonly view?: string } =>
          typeof request === "object" &&
          request !== null &&
          "type" in request &&
          request.type === "capture",
      );
      expect(observedFrameRequests).toContainEqual(
        expect.objectContaining({ type: "set-view", view: "front", fit: true }),
      );
      expect(uploadedCadScreenshots).toContainEqual({
        requestId: "screenshot-front",
        pngBase64: "cG5n",
      });
      expect(captureRequests).toContainEqual(
        expect.objectContaining({ type: "capture", fit: true }),
      );
      expect(captureRequests).not.toContainEqual(expect.objectContaining({ view: "front" }));
      expect(
        useUiStateStore.getState().cadAgentViewStateByThreadId[cadUiStateKey]?.viewCommand,
      ).toMatchObject({ type: "set-view", view: "front", fit: true });
    });

    window.removeEventListener("message", onObservedRequest);
    await screen.unmount();
    queryClient.clear();
  });

  it("replays the composite agent-controlled CAD state after the viewer loads", async () => {
    cadFrameUrl = delayedReadyFrameUrl();
    threadReviews = [activeReview];
    useUiStateStore.getState().recordCadAgentViewCommand(cadUiStateKey, {
      commandId: "agent-view-right",
      threadId,
      type: "set-view",
      view: "right",
      fit: true,
      createdAt: "2026-05-20T00:00:00.000Z",
    });
    useUiStateStore.getState().recordCadAgentViewCommand(cadUiStateKey, {
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

    cadViewCommandHandler?.({
      commandId: "stalled-command-front-1",
      threadId,
      type: "set-view",
      view: "front",
      fit: true,
      createdAt: "2026-05-20T00:00:04.000Z",
    });
    cadViewCommandHandler?.({
      commandId: "stalled-command-front-2",
      threadId,
      type: "set-view",
      view: "front",
      fit: true,
      createdAt: "2026-05-20T00:00:05.000Z",
    });

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
      expect(releasedRect.top).toBeGreaterThanOrEqual(47);
      expect(releasedRect.right).toBeGreaterThanOrEqual(window.innerWidth - 17);
    });

    await page.getByRole("button", { name: "Exit fullscreen CAD view" }).click();
    await screen.unmount();
    queryClient.clear();
  });
});
