import { describe, expect, it } from "vitest";

import { buildCadWebGlFailureUserMessage } from "./cadViewerWebGl";

describe("buildCadWebGlFailureUserMessage", () => {
  it("treats Error creating WebGL context as a WebGL / GPU issue", () => {
    const message = buildCadWebGlFailureUserMessage("Error creating WebGL context.");
    expect(message).toContain("WebGL");
    expect(message).toContain("blocklist");
  });

  it("maps empty and null to the default WebGL guidance", () => {
    expect(buildCadWebGlFailureUserMessage("")).toContain("WebGL");
    expect(buildCadWebGlFailureUserMessage(null)).toContain("WebGL");
    expect(buildCadWebGlFailureUserMessage(undefined)).toContain("WebGL");
  });

  it("maps blocklisted GPU log snippets", () => {
    expect(buildCadWebGlFailureUserMessage("WebGL1 blocklisted")).toContain("WebGL");
  });

  it("passes through unrelated viewer errors unchanged", () => {
    expect(buildCadWebGlFailureUserMessage("STEP parse failed")).toBe("STEP parse failed");
  });
});
