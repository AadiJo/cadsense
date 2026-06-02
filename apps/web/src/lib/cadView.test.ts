import { describe, expect, it } from "vitest";

import { cadInteractiveViewVector, cadViewVector } from "./cadView";

describe("cadViewVector", () => {
  it("uses a Z-up top view for robot/CAD models", () => {
    expect(cadViewVector("top")).toEqual({ direction: [0, 0, 1], up: [0, 1, 0] });
  });

  it("uses an angled isometric view", () => {
    expect(cadViewVector("isometric").direction).toEqual([1, -1, 1]);
  });

  it("nudges interactive top view off the orbit pole while keeping CAD Z as the orbit up axis", () => {
    expect(cadInteractiveViewVector("top")).toEqual({
      direction: [0, -0.08, 1],
      up: [0, 0, 1],
    });
  });
});
