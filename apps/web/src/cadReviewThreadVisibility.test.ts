import { describe, expect, it } from "vitest";

import { isCadReviewChildThread } from "./cadReviewThreadVisibility";

describe("CAD review thread visibility", () => {
  it("uses explicit thread purpose before retaining the legacy id fallback", () => {
    expect(isCadReviewChildThread({ id: "opaque-child-id", purpose: "cad-review" })).toBe(true);
    expect(isCadReviewChildThread({ id: "parent:cad-review:legacy:child" })).toBe(true);
    expect(isCadReviewChildThread({ id: "ordinary-thread", purpose: "general" })).toBe(false);
  });
});
