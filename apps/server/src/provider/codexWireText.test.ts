import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { normalizeCodexStreamDelta, normalizeCodexTranscriptSnippet } from "./codexWireText.ts";

describe("normalizeCodexStreamDelta", () => {
  it("passes plain strings through", () => {
    assert.equal(normalizeCodexStreamDelta("hello"), "hello");
  });

  it("extracts structured text deltas", () => {
    assert.equal(normalizeCodexStreamDelta({ text: "hi" }), "hi");
  });

  it("flatten arrays of deltas", () => {
    assert.equal(normalizeCodexStreamDelta([{ text: "a" }, { text: "b" }]), "ab");
  });
});

describe("normalizeCodexTranscriptSnippet", () => {
  it("delegates to stream normalization", () => {
    assert.equal(normalizeCodexTranscriptSnippet({ text: "done" }), "done");
  });
});
