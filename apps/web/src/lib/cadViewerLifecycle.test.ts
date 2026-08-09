import { describe, expect, it } from "vitest";

import {
  advanceCadViewerLifecycle,
  initialCadViewerLifecycle,
  rebindCadViewerLifecycleToThread,
  startCadViewerLifecycle,
} from "./cadViewerLifecycle";

describe("CAD viewer lifecycle", () => {
  it("does not invalidate an in-flight asset load when the panel changes threads", () => {
    const loading = startCadViewerLifecycle(initialCadViewerLifecycle(1), "asset-revision-a", 2);

    const rebound = rebindCadViewerLifecycleToThread(loading, "thread-b");
    const ready = advanceCadViewerLifecycle(rebound, loading.generation, { status: "ready" }, 3);

    expect(rebound).toBe(loading);
    expect(ready).toMatchObject({
      status: "ready",
      generation: loading.generation,
      assetKey: "asset-revision-a",
    });
  });

  it("ignores completion events from a stale viewer generation", () => {
    const first = startCadViewerLifecycle(initialCadViewerLifecycle(1), "asset-a", 2);
    const second = startCadViewerLifecycle(first, "asset-b", 3);

    expect(advanceCadViewerLifecycle(second, first.generation, { status: "ready" }, 4)).toBe(
      second,
    );
  });
});
