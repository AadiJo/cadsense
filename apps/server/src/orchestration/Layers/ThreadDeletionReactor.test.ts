import { ThreadId } from "@cadsense/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { afterEach, describe, expect, it } from "vitest";

import {
  clearCadProviderThreadAliasesForTests,
  registerCadProviderThreadAlias,
  resolveCadRequestThreadId,
} from "../../cad/CadThreadAliases.ts";
import { cleanupDeletedThread, logCleanupCauseUnlessInterrupted } from "./ThreadDeletionReactor.ts";

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});

describe("cleanupDeletedThread", () => {
  afterEach(() => {
    clearCadProviderThreadAliasesForTests();
  });

  it("releases CAD aliases even when provider cleanup fails", async () => {
    const threadId = ThreadId.make("deleted-thread");
    registerCadProviderThreadAlias({
      cadThreadId: threadId,
      ownerThreadId: threadId,
      resumeCursor: { threadId: "provider-thread" },
    });

    await Effect.runPromise(
      cleanupDeletedThread({
        stopProviderSession: Effect.fail("cleanup failed"),
        threadId,
      }),
    );

    expect(resolveCadRequestThreadId(ThreadId.make("provider-thread"))).toBe("provider-thread");
  });

  it("releases CAD aliases before provider cleanup settles", async () => {
    const threadId = ThreadId.make("deleted-thread");
    registerCadProviderThreadAlias({
      cadThreadId: threadId,
      ownerThreadId: threadId,
      resumeCursor: { threadId: "provider-thread" },
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const cleanupStarted = yield* Deferred.make<void>();
        const releaseCleanup = yield* Deferred.make<void>();
        const cleanupFiber = yield* cleanupDeletedThread({
          stopProviderSession: Deferred.succeed(cleanupStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseCleanup)),
          ),
          threadId,
        }).pipe(Effect.forkChild);

        yield* Deferred.await(cleanupStarted);
        expect(resolveCadRequestThreadId(ThreadId.make("provider-thread"))).toBe("provider-thread");
        yield* Deferred.succeed(releaseCleanup, undefined);
        yield* Fiber.join(cleanupFiber);
      }),
    );
  });
});
