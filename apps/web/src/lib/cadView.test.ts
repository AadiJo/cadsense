import { describe, expect, it } from "vitest";

import { cadViewVector } from "./cadView";

describe("cadViewVector", () => {
  it("uses a Z-up top view for robot/CAD models", () => {
    expect(cadViewVector("top")).toEqual({ direction: [0, 0, 1], up: [0, 1, 0] });
  });

  it("uses an angled isometric view", () => {
    expect(cadViewVector("isometric").direction).toEqual([1, -1, 1]);
  });
});
