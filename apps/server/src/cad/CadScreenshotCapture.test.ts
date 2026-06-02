import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

import { ThreadId } from "@cadsense/contracts";

import {
  cadScreenshotRequestStream,
  completeCadScreenshotPending,
  getCadScreenshotPendingExportRoot,
  getCadScreenshotPendingThreadId,
  getCadScreenshotPendingSuggestedBaseName,
  makeCadScreenshotFilename,
  publishCadScreenshotRequest,
  rejectCadScreenshotPending,
  rejectCadScreenshotPendingForThread,
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

  it("resolves completed screenshot captures and clears pending metadata", async () => {
    const capture = await Effect.runPromise(
      startCadScreenshotCaptureEffect({
        threadId: ThreadId.make("thread-complete-cad-screenshot"),
        exportRoot: "C:\\tmp\\cad-screenshots",
        suggestedBaseName: "Drive Base",
        view: "front",
        fit: false,
      }),
    );
    const result = {
      requestId: capture.requestId,
      absolutePath: "C:\\tmp\\cad-screenshots\\capture.png",
      relativePath: "capture.png",
    };
    const pendingResult = Effect.runPromise(capture.awaitResult.pipe(Effect.timeout("1 second")));

    expect(getCadScreenshotPendingExportRoot(capture.requestId)).toBe("C:\\tmp\\cad-screenshots");
    expect(getCadScreenshotPendingThreadId(capture.requestId)).toBe(
      "thread-complete-cad-screenshot",
    );
    expect(getCadScreenshotPendingSuggestedBaseName(capture.requestId)).toBe("Drive Base");
    expect(completeCadScreenshotPending(capture.requestId, result)).toBe(true);

    await expect(pendingResult).resolves.toEqual(result);
    expect(getCadScreenshotPendingExportRoot(capture.requestId)).toBeUndefined();
    expect(completeCadScreenshotPending(capture.requestId, result)).toBe(false);
  });

  it("rejects pending screenshot captures by thread without touching other threads", async () => {
    const first = await Effect.runPromise(
      startCadScreenshotCaptureEffect({
        threadId: ThreadId.make("thread-reject-cad-screenshot"),
        exportRoot: "C:\\tmp\\cad-screenshots",
        suggestedBaseName: "first",
        view: undefined,
        fit: true,
      }),
    );
    const second = await Effect.runPromise(
      startCadScreenshotCaptureEffect({
        threadId: ThreadId.make("thread-keep-cad-screenshot"),
        exportRoot: "C:\\tmp\\cad-screenshots",
        suggestedBaseName: "second",
        view: undefined,
        fit: true,
      }),
    );
    const firstResult = Effect.runPromise(first.awaitResult.pipe(Effect.timeout("1 second")));

    try {
      expect(
        rejectCadScreenshotPendingForThread(
          ThreadId.make("thread-reject-cad-screenshot"),
          "browser disconnected",
        ),
      ).toBe(1);

      await expect(firstResult).rejects.toThrow("browser disconnected");
      expect(getCadScreenshotPendingExportRoot(first.requestId)).toBeUndefined();
      expect(getCadScreenshotPendingExportRoot(second.requestId)).toBe("C:\\tmp\\cad-screenshots");
    } finally {
      rejectCadScreenshotPending(second.requestId, "test cleanup");
    }
  });

  it("sanitizes suggested screenshot filenames", () => {
    expect(makeCadScreenshotFilename("2026-06-01T12-00-00Z", " Drive Base / Front View ")).toBe(
      "2026-06-01T12-00-00Z_drive-base-front-view.png",
    );
    expect(makeCadScreenshotFilename("2026-06-01T12-00-00Z", "###")).toBe(
      "2026-06-01T12-00-00Z_cad-view.png",
    );
  });
});
