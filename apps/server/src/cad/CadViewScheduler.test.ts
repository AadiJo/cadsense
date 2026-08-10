import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { ThreadId } from "@cadsense/contracts";

import { makeCadViewScheduler } from "./CadViewScheduler.ts";

describe("CadViewScheduler", () => {
  it("releases a thread tail after its final operation completes", async () => {
    const pendingCounts: number[] = [];
    const scheduler = Effect.runSync(
      makeCadViewScheduler((count) => {
        pendingCounts.push(count);
      }),
    );

    await Effect.runPromise(
      scheduler.enqueue(ThreadId.make("thread-complete"), "operation-complete", Effect.void),
    );

    expect(pendingCounts).toEqual([1, 0]);
  });
});
