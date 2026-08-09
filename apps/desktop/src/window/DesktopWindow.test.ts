import { describe, expect, it } from "vitest";

import { isTrustedDesktopNavigation } from "./DesktopWindow.ts";

describe("isTrustedDesktopNavigation", () => {
  const applicationUrl = "http://127.0.0.1:43123/";

  it("allows routes on the desktop application's origin", () => {
    expect(isTrustedDesktopNavigation(applicationUrl, "http://127.0.0.1:43123/thread/123")).toBe(
      true,
    );
  });

  it("rejects external origins and malformed URLs", () => {
    expect(isTrustedDesktopNavigation(applicationUrl, "https://example.com/phishing")).toBe(false);
    expect(isTrustedDesktopNavigation(applicationUrl, "not a url")).toBe(false);
  });

  it("treats a different local port as an untrusted origin", () => {
    expect(isTrustedDesktopNavigation(applicationUrl, "http://127.0.0.1:43124/")).toBe(false);
  });
});
