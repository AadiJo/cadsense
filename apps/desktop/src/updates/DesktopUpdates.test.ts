import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { describe, expect } from "vitest";

import { releaseUpdateAction, tryAcquireUpdateAction } from "./DesktopUpdates.ts";

describe("tryAcquireUpdateAction", () => {
  it.effect("allows only one concurrent update action to acquire the guard", () =>
    Effect.gen(function* () {
      const actionRef = yield* Ref.make<
        Option.Option<{ readonly action: "check" | "download" | "install" }>
      >(Option.none());
      const acquired = yield* Effect.all(
        Array.from({ length: 20 }, () => tryAcquireUpdateAction(actionRef, "check")),
        { concurrency: "unbounded" },
      );

      expect(acquired.filter(Option.isSome)).toHaveLength(1);
      expect(Option.map(yield* Ref.get(actionRef), (owner) => owner.action)).toEqual(
        Option.some("check"),
      );
    }),
  );

  it.effect("does not let a stale owner release a newer action", () =>
    Effect.gen(function* () {
      const actionRef = yield* Ref.make<
        Option.Option<{ readonly action: "check" | "download" | "install" }>
      >(Option.none());
      const first = Option.getOrThrow(yield* tryAcquireUpdateAction(actionRef, "install"));
      expect(yield* releaseUpdateAction(actionRef, first)).toBe(true);

      const second = Option.getOrThrow(yield* tryAcquireUpdateAction(actionRef, "install"));
      expect(yield* releaseUpdateAction(actionRef, first)).toBe(false);
      expect(yield* Ref.get(actionRef)).toEqual(Option.some(second));
    }),
  );
});
