import { describe, expect, it } from "vitest";

import {
  CAD_VIEWER_MODEL_SIZE_LIMIT_BYTES,
  cadViewerFileName,
  formatCadModelBytes,
  getCadModelViewerBlocker,
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
});
