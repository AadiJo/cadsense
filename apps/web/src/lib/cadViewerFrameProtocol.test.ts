import { describe, expect, it } from "vitest";

import { isTrustedCadViewerFrameMessage } from "./cadViewerFrameProtocol";

describe("CAD viewer frame message trust", () => {
  const frameWindow = {} as Window;

  it("accepts only the expected source window and origin", () => {
    expect(
      isTrustedCadViewerFrameMessage(
        { source: frameWindow, origin: "https://app.example.test" },
        frameWindow,
        "https://app.example.test",
      ),
    ).toBe(true);
  });

  it("rejects matching protocol data from another window", () => {
    expect(
      isTrustedCadViewerFrameMessage(
        { source: {} as Window, origin: "https://app.example.test" },
        frameWindow,
        "https://app.example.test",
      ),
    ).toBe(false);
  });

  it("rejects the expected window when its origin differs", () => {
    expect(
      isTrustedCadViewerFrameMessage(
        { source: frameWindow, origin: "https://attacker.example.test" },
        frameWindow,
        "https://app.example.test",
      ),
    ).toBe(false);
  });

  it("rejects messages while the expected frame is unavailable", () => {
    expect(
      isTrustedCadViewerFrameMessage(
        { source: frameWindow, origin: "https://app.example.test" },
        null,
        "https://app.example.test",
      ),
    ).toBe(false);
  });
});
