import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type { CadScreenshotCaptureHttpResult, CadView, ThreadId } from "@cadsense/contracts";

import {
  CAPTURE_TIMEOUT,
  publishCadScreenshotRequest,
  rejectCadScreenshotPending,
  startCadScreenshotCaptureEffect,
} from "./CadScreenshotCapture.ts";

export class CadScreenshotClientError extends Data.TaggedError("CadScreenshotClientError")<{
  readonly message: string;
}> {}

export const captureCadScreenshot = Effect.fn("captureCadScreenshot")(function* (input: {
  readonly threadId: ThreadId;
  readonly exportRoot: string;
  readonly suggestedBaseName: string | undefined;
  readonly view: CadView | undefined;
  readonly fit: boolean;
}): Effect.fn.Return<CadScreenshotCaptureHttpResult, CadScreenshotClientError> {
  const capture = yield* startCadScreenshotCaptureEffect(input);
  yield* publishCadScreenshotRequest(capture.browserRequest);
  return yield* Effect.race(
    capture.awaitResult,
    Effect.sleep(CAPTURE_TIMEOUT).pipe(
      Effect.tap(() =>
        Effect.sync(() =>
          rejectCadScreenshotPending(capture.requestId, "CAD screenshot capture timed out."),
        ),
      ),
      Effect.flatMap(() =>
        Effect.fail(
          new CadScreenshotClientError({
            message: "CAD screenshot capture timed out.",
          }),
        ),
      ),
    ),
  ).pipe(
    Effect.mapError(
      (error) =>
        new CadScreenshotClientError({
          message: error instanceof Error ? error.message : "CAD screenshot capture failed.",
        }),
    ),
  );
});
