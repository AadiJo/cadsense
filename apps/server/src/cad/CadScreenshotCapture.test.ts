import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

import { ThreadId } from "@cadsense/contracts";

import {
  cadScreenshotRequestStream,
  publishCadScreenshotRequest,
  rejectCadScreenshotPending,
  startCadScreenshotCaptureEffect,
} from "./CadScreenshotCapture.ts";

describe("CadScreenshotCapture", () => {
  it("replays pending screenshot requests to late subscribers", async () => {
    const capture = await Effect.runPromise(
      startCadScreenshotCaptureEffect({
        threadId: ThreadId.make("thread-late-cad-screenshot-subscriber"),
        exportRoot: "C:\\tmp\\cad-screenshots",
        suggestedBaseName: "late-subscriber",
        view: "isometric",
        fit: true,
      }),
    );

    await Effect.runPromise(publishCadScreenshotRequest(capture.browserRequest));

    try {
      const events = await Effect.runPromise(
        cadScreenshotRequestStream.pipe(Stream.take(1), Stream.runCollect),
      );

      expect(Array.from(events)).toEqual([capture.browserRequest]);
    } finally {
      rejectCadScreenshotPending(capture.requestId, "test cleanup");
    }
  });
});
