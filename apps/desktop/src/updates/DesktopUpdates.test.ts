import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { describe, expect } from "vitest";

import { tryAcquireUpdateAction } from "./DesktopUpdates.ts";

describe("tryAcquireUpdateAction", () => {
  it.effect("allows only one concurrent update action to acquire the guard", () =>
    Effect.gen(function* () {
      const actionRef = yield* Ref.make<Option.Option<"check" | "download" | "install">>(
        Option.none(),
      );
      const acquired = yield* Effect.all(
        Array.from({ length: 20 }, () => tryAcquireUpdateAction(actionRef, "check")),
        { concurrency: "unbounded" },
      );

      expect(acquired.filter(Boolean)).toHaveLength(1);
      expect(yield* Ref.get(actionRef)).toEqual(Option.some("check"));
    }),
  );
});
