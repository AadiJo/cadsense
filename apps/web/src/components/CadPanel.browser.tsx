import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useUiStateStore } from "../uiStateStore";

const environmentId = "environment-cad-browser";
const threadId = "thread-cad-browser";
const projectId = "project-cad-browser";

let cadFrameUrl = "";
const observedFrameRequests: unknown[] = [];

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
      onCadViewCommand: vi.fn(() => () => undefined),
      onCadHierarchyRequest: vi.fn(() => () => undefined),
      uploadCadHierarchy: vi.fn(async () => ({ components: [] })),
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
    externalContext: null,
    worktreePath: null,
    reviews: [],
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
              if (event.data?.type !== "load-file-urls" && event.data?.type !== "set-exploded") return;
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

describe("CadPanel browser behavior", () => {
  afterEach(() => {
    vi.clearAllMocks();
    observedFrameRequests.length = 0;
    useUiStateStore.setState({
      cadExplodedByThreadId: {},
      cadZoomToFitRequestByThreadId: {},
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
});
