import { describe, assert, it } from "vitest";
import { formatCaughtErrorMessage, isWindowsPlatform } from "./utils";

describe("isWindowsPlatform", () => {
  it("matches Windows platform identifiers", () => {
    assert.isTrue(isWindowsPlatform("Win32"));
    assert.isTrue(isWindowsPlatform("Windows"));
    assert.isTrue(isWindowsPlatform("windows_nt"));
  });

  it("does not match darwin", () => {
    assert.isFalse(isWindowsPlatform("darwin"));
  });
});

describe("formatCaughtErrorMessage", () => {
  it("prefers Error.message when non-empty", () => {
    assert.equal(formatCaughtErrorMessage(new Error("boom"), "fallback"), "boom");
  });

  it("uses string rejections", () => {
    assert.equal(formatCaughtErrorMessage("rate limited", "fallback"), "rate limited");
  });

  it("reads message from plain objects", () => {
    assert.equal(formatCaughtErrorMessage({ message: "from object" }, "fallback"), "from object");
  });

  it("uses fallback for empty Error message and useless object string", () => {
    assert.equal(formatCaughtErrorMessage(new Error("   "), "fallback"), "fallback");
    assert.equal(formatCaughtErrorMessage({}, "fallback"), "fallback");
  });
});
