import { describe, expect, it } from "vitest";

import {
  CAD_VIEWER_MODEL_SIZE_LIMIT_BYTES,
  applyCadComponentVisibility,
  cadComponentVisibilityCommandsForScopeChange,
  cadOnshapeModelQueryIdentity,
  cadViewerFileName,
  formatCadModelBytes,
  getCadModelViewerBlocker,
  shouldHandleCadAgentRequestForPanel,
} from "./CadPanel.logic";

describe("CadPanel logic", () => {
  it("blocks oversized CAD previews before the viewer imports them", () => {
    const blocker = getCadModelViewerBlocker([
      {
        relativePath: "onshape-sync/current.3mf",
        sizeBytes: CAD_VIEWER_MODEL_SIZE_LIMIT_BYTES + 1,
      },
    ]);

    expect(blocker).toContain("above the 80.0 MiB interactive viewer limit");
    expect(blocker).toContain("stays responsive");
  });

  it("blocks a large companion set even when each file is under the per-file cap", () => {
    const blocker = getCadModelViewerBlocker([
      { relativePath: "onshape-sync/current.obj", sizeBytes: 42 * 1024 * 1024 },
      { relativePath: "onshape-sync/current.mtl", sizeBytes: 1 * 1024 },
      { relativePath: "onshape-sync/texture.png", sizeBytes: 42 * 1024 * 1024 },
    ]);

    expect(blocker).toContain("assets total");
    expect(blocker).toContain("above the 80.0 MiB interactive viewer limit");
  });

  it("allows previews when size is unknown for backward compatibility", () => {
    expect(getCadModelViewerBlocker([{ relativePath: "onshape-sync/current.3mf" }])).toBeNull();
  });

  it("formats byte sizes for viewer copy", () => {
    expect(formatCadModelBytes(44_717_577)).toBe("42.6 MiB");
    expect(formatCadModelBytes(512)).toBe("1 KiB");
  });

  it("preserves the CAD file extension for the frame file payload", () => {
    expect(cadViewerFileName("onshape-sync/current.3mf")).toBe("current.3mf");
    expect(cadViewerFileName("onshape-sync\\bundle\\assembly.obj")).toBe("assembly.obj");
  });

  it("keys synced CAD queries by Onshape document identity", () => {
    const baseContext = {
      connectionId: "team-onshape",
      entityId: "assembly-a",
      entityKind: "assembly",
      reference: {
        baseUrl: "https://cad.onshape.com",
        documentId: "document-a",
        workspaceId: "workspace-a",
        elementId: "element-a",
      },
      lastSyncedRelativePath: "onshape-sync/current.3mf",
      lastSyncedAt: "2026-06-04T00:00:00.000Z",
    };

    expect(cadOnshapeModelQueryIdentity(baseContext)).not.toEqual(
      cadOnshapeModelQueryIdentity({
        ...baseContext,
        entityId: "assembly-b",
        reference: {
          ...baseContext.reference,
          documentId: "document-b",
          elementId: "element-b",
        },
      }),
    );
  });

  it("routes CAD agent requests exactly for active review panels", () => {
    expect(
      shouldHandleCadAgentRequestForPanel({
        requestThreadId: "thread-active",
        cadRoutingThreadId: "thread-active",
        sameProjectThreadIds: ["thread-active", "thread-other"],
        activeCadReviewThreadIds: ["thread-active", "thread-other"],
        agentControlHost: false,
        cadReviewInProgress: true,
      }),
    ).toBe(true);
    expect(
      shouldHandleCadAgentRequestForPanel({
        requestThreadId: "thread-active",
        cadRoutingThreadId: "thread-active",
        sameProjectThreadIds: ["thread-active", "thread-other"],
        activeCadReviewThreadIds: ["thread-active", "thread-other"],
        agentControlHost: true,
        cadReviewInProgress: true,
      }),
    ).toBe(true);
    expect(
      shouldHandleCadAgentRequestForPanel({
        requestThreadId: "thread-other",
        cadRoutingThreadId: "thread-active",
        sameProjectThreadIds: ["thread-active", "thread-other"],
        activeCadReviewThreadIds: ["thread-active", "thread-other"],
        agentControlHost: true,
        cadReviewInProgress: true,
      }),
    ).toBe(false);
  });

  it("routes active review child-thread CAD requests to the visible review panel", () => {
    expect(
      shouldHandleCadAgentRequestForPanel({
        requestThreadId: "thread-active:cad-review:run-1:systems_integration:child",
        cadRoutingThreadId: "thread-active",
        sameProjectThreadIds: ["thread-active"],
        activeCadReviewThreadIds: ["thread-active"],
        activeCadReviewChildThreadIds: ["thread-active:cad-review:run-1:systems_integration:child"],
        agentControlHost: false,
        cadReviewInProgress: true,
      }),
    ).toBe(true);
  });

  it("does not let inactive same-project panels answer active review requests", () => {
    expect(
      shouldHandleCadAgentRequestForPanel({
        requestThreadId: "thread-active-review",
        cadRoutingThreadId: "thread-inactive",
        sameProjectThreadIds: ["thread-inactive", "thread-active-review"],
        activeCadReviewThreadIds: ["thread-active-review"],
        agentControlHost: false,
        cadReviewInProgress: false,
      }),
    ).toBe(false);
  });

  it("keeps same-project fallback for non-review CAD requests", () => {
    expect(
      shouldHandleCadAgentRequestForPanel({
        requestThreadId: "thread-same-project",
        cadRoutingThreadId: "thread-visible",
        sameProjectThreadIds: ["thread-visible", "thread-same-project"],
        activeCadReviewThreadIds: [],
        agentControlHost: false,
        cadReviewInProgress: false,
      }),
    ).toBe(true);
  });

  it("applies saved CAD hierarchy visibility across component subtrees", () => {
    expect(
      applyCadComponentVisibility(
        [
          {
            id: "drive",
            name: "Drive",
            kind: "assembly",
            hasChildren: true,
            visible: true,
          },
          {
            id: "left-wheel",
            parentId: "drive",
            name: "Left Wheel",
            kind: "part",
            hasChildren: false,
            visible: true,
          },
          {
            id: "intake",
            name: "Intake",
            kind: "part",
            hasChildren: false,
            visible: false,
          },
        ],
        { drive: false, "left-wheel": true, unknown: false },
      ),
    ).toEqual([
      {
        id: "drive",
        name: "Drive",
        kind: "assembly",
        hasChildren: true,
        visible: false,
      },
      {
        id: "left-wheel",
        parentId: "drive",
        name: "Left Wheel",
        kind: "part",
        hasChildren: false,
        visible: false,
      },
      {
        id: "intake",
        name: "Intake",
        kind: "part",
        hasChildren: false,
        visible: false,
      },
    ]);
  });

  it("resets component visibility when switching to a thread without overrides", () => {
    expect(cadComponentVisibilityCommandsForScopeChange({ drive: false }, {})).toEqual([
      { componentId: "drive", visible: true },
    ]);
  });

  it("only emits visibility commands that changed between thread scopes", () => {
    expect(
      cadComponentVisibilityCommandsForScopeChange(
        { drive: false, intake: false },
        { drive: false, elevator: false },
      ),
    ).toEqual([
      { componentId: "intake", visible: true },
      { componentId: "elevator", visible: false },
    ]);
  });

  it("reports parent assemblies hidden when all child subtrees are hidden", () => {
    expect(
      applyCadComponentVisibility(
        [
          {
            id: "drive",
            name: "Drive",
            kind: "assembly",
            hasChildren: true,
            visible: true,
          },
          {
            id: "left-module",
            parentId: "drive",
            name: "Left Module",
            kind: "assembly",
            hasChildren: true,
            visible: true,
          },
          {
            id: "left-wheel",
            parentId: "left-module",
            name: "Left Wheel",
            kind: "part",
            hasChildren: false,
            visible: true,
          },
          {
            id: "right-module",
            parentId: "drive",
            name: "Right Module",
            kind: "assembly",
            hasChildren: true,
            visible: true,
          },
          {
            id: "right-wheel",
            parentId: "right-module",
            name: "Right Wheel",
            kind: "part",
            hasChildren: false,
            visible: true,
          },
        ],
        { "left-wheel": false, "right-wheel": false },
      ),
    ).toEqual([
      {
        id: "drive",
        name: "Drive",
        kind: "assembly",
        hasChildren: true,
        visible: false,
      },
      {
        id: "left-module",
        parentId: "drive",
        name: "Left Module",
        kind: "assembly",
        hasChildren: true,
        visible: false,
      },
      {
        id: "left-wheel",
        parentId: "left-module",
        name: "Left Wheel",
        kind: "part",
        hasChildren: false,
        visible: false,
      },
      {
        id: "right-module",
        parentId: "drive",
        name: "Right Module",
        kind: "assembly",
        hasChildren: true,
        visible: false,
      },
      {
        id: "right-wheel",
        parentId: "right-module",
        name: "Right Wheel",
        kind: "part",
        hasChildren: false,
        visible: false,
      },
    ]);
  });
});
