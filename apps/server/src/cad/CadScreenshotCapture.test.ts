import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

import { ThreadId } from "@cadsense/contracts";

import {
  cadScreenshotRequestStream,
  CAPTURE_TIMEOUT,
  claimCadScreenshotPending,
  completeCadScreenshotPending,
  failCadScreenshotPending,
  getCadScreenshotPendingExportRoot,
  getCadScreenshotPendingThreadId,
  getCadScreenshotPendingSuggestedBaseName,
  makeCadScreenshotFilename,
  publishCadScreenshotRequest,
  rejectCadScreenshotPending,
  rejectCadScreenshotPendingForThread,
  startCadScreenshotCaptureEffect,
} from "./CadScreenshotCapture.ts";
import { CAD_REQUEST_LEASE_MS } from "./CadRequestLease.ts";

describe("CadScreenshotCapture", () => {
  it("expires a dead viewer lease with time to reclaim before capture timeout", () => {
    expect(CAD_REQUEST_LEASE_MS).toBe(30_000);
    expect(CAD_REQUEST_LEASE_MS).toBeLessThan(Duration.toMillis(CAPTURE_TIMEOUT));
  });

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

  it("replays only unclaimed work to late subscribers", async () => {
    const claimedCapture = await Effect.runPromise(
      startCadScreenshotCaptureEffect({
        threadId: ThreadId.make("thread-claimed-cad-screenshot"),
        exportRoot: "C:\\tmp\\cad-screenshots",
        suggestedBaseName: "claimed",
        view: undefined,
        fit: true,
      }),
    );
    const availableCapture = await Effect.runPromise(
      startCadScreenshotCaptureEffect({
        threadId: ThreadId.make("thread-available-cad-screenshot"),
        exportRoot: "C:\\tmp\\cad-screenshots",
        suggestedBaseName: "available",
        view: undefined,
        fit: true,
      }),
    );
    const claim = claimCadScreenshotPending({
      requestId: claimedCapture.requestId,
      responderId: "viewer-owner",
    });
    expect(claim.status).toBe("claimed");

    try {
      const events = await Effect.runPromise(
        cadScreenshotRequestStream.pipe(
          Stream.filter(
            (request) =>
              request.requestId === claimedCapture.requestId ||
              request.requestId === availableCapture.requestId,
          ),
          Stream.take(1),
          Stream.runCollect,
          Effect.timeout("1 second"),
        ),
      );
      expect(Array.from(events).map((request) => request.requestId)).toEqual([
        availableCapture.requestId,
      ]);
    } finally {
      rejectCadScreenshotPending(claimedCapture.requestId, "test cleanup");
      rejectCadScreenshotPending(availableCapture.requestId, "test cleanup");
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
    const claim = claimCadScreenshotPending(
      { requestId: capture.requestId, responderId: "viewer-complete" },
      1_000,
    );
    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed") throw new Error("Expected screenshot claim");
    const claimToken = { responderId: "viewer-complete", leaseId: claim.leaseId };
    expect(completeCadScreenshotPending(capture.requestId, claimToken, result, 1_001)).toBe(true);

    await expect(pendingResult).resolves.toEqual(result);
    expect(getCadScreenshotPendingExportRoot(capture.requestId)).toBeUndefined();
    expect(completeCadScreenshotPending(capture.requestId, claimToken, result, 1_002)).toBe(false);
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

  it("grants one responder, renews its lease, and rejects stale work after deterministic reclaim", async () => {
    const capture = await Effect.runPromise(
      startCadScreenshotCaptureEffect({
        threadId: ThreadId.make("thread-screenshot-lease"),
        exportRoot: "C:\\tmp\\cad-screenshots",
        suggestedBaseName: "lease",
        view: undefined,
        fit: true,
      }),
    );
    const result = {
      requestId: capture.requestId,
      absolutePath: "C:\\tmp\\cad-screenshots\\capture.png",
      relativePath: "capture.png",
    };
    const first = claimCadScreenshotPending(
      { requestId: capture.requestId, responderId: "viewer-first" },
      10_000,
    );
    expect(first.status).toBe("claimed");
    if (first.status !== "claimed") throw new Error("Expected first claim");

    expect(
      claimCadScreenshotPending(
        { requestId: capture.requestId, responderId: "viewer-loser" },
        10_001,
      ),
    ).toMatchObject({ status: "unavailable", reason: "already-claimed" });
    expect(
      claimCadScreenshotPending(
        { requestId: capture.requestId, responderId: "viewer-first" },
        20_000,
      ),
    ).toMatchObject({ status: "claimed", leaseId: first.leaseId, attempt: 1 });

    const reclaimedAt = 20_000 + CAD_REQUEST_LEASE_MS;
    const second = claimCadScreenshotPending(
      { requestId: capture.requestId, responderId: "viewer-second" },
      reclaimedAt,
    );
    expect(second.status).toBe("claimed");
    if (second.status !== "claimed") throw new Error("Expected reclaimed lease");
    expect(second).toMatchObject({ attempt: 2 });
    expect(second.leaseId).not.toBe(first.leaseId);

    expect(
      completeCadScreenshotPending(
        capture.requestId,
        { responderId: "viewer-first", leaseId: first.leaseId },
        result,
        reclaimedAt + 1,
      ),
    ).toBe(false);
    expect(
      completeCadScreenshotPending(
        capture.requestId,
        { responderId: "viewer-second", leaseId: second.leaseId },
        result,
        reclaimedAt + CAD_REQUEST_LEASE_MS - 1,
      ),
    ).toBe(true);
    await expect(Effect.runPromise(capture.awaitResult)).resolves.toEqual(result);
  });

  it("finalizes explicit browser failure immediately", async () => {
    const capture = await Effect.runPromise(
      startCadScreenshotCaptureEffect({
        threadId: ThreadId.make("thread-screenshot-failure"),
        exportRoot: "C:\\tmp\\cad-screenshots",
        suggestedBaseName: undefined,
        view: undefined,
        fit: true,
      }),
    );
    const pendingResult = Effect.runPromise(capture.awaitResult.pipe(Effect.timeout("1 second")));
    const claim = claimCadScreenshotPending({
      requestId: capture.requestId,
      responderId: "viewer-failed",
    });
    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed") throw new Error("Expected screenshot claim");

    expect(
      failCadScreenshotPending(
        capture.requestId,
        { responderId: "viewer-failed", leaseId: claim.leaseId },
        "Viewer could not capture a frame.",
      ),
    ).toBe(true);
    await expect(pendingResult).rejects.toThrow("Viewer could not capture a frame.");
    expect(getCadScreenshotPendingExportRoot(capture.requestId)).toBeUndefined();
  });
});
