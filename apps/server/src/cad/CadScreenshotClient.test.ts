import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

import { ThreadId } from "@cadsense/contracts";

import {
  cadScreenshotRequestStream,
  getCadScreenshotPendingExportRoot,
} from "./CadScreenshotCapture.ts";
import { captureCadScreenshot } from "./CadScreenshotClient.ts";

describe("CadScreenshotClient", () => {
  it("clears pending capture state when the caller is interrupted", async () => {
    const threadId = ThreadId.make("thread-interrupted-cad-screenshot");
    const request = await Effect.runPromise(
      Effect.gen(function* () {
        const captureFiber = yield* captureCadScreenshot({
          threadId,
          exportRoot: "C:\\tmp\\cad-screenshots",
          suggestedBaseName: "interrupted",
          view: undefined,
          fit: true,
        }).pipe(Effect.forkChild);
        const pending = yield* cadScreenshotRequestStream.pipe(
          Stream.filter((event) => event.threadId === threadId),
          Stream.runHead,
          Effect.timeout("1 second"),
        );
        yield* Fiber.interrupt(captureFiber);
        return Option.getOrThrow(pending);
      }),
    );

    expect(getCadScreenshotPendingExportRoot(request.requestId)).toBeUndefined();
  });
});
