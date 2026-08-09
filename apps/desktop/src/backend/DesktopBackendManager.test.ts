import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { describe, expect } from "vitest";

import { BackendTimeoutError, superviseBackendReadiness } from "./DesktopBackendManager.ts";

describe("superviseBackendReadiness", () => {
  it.effect("terminates a backend that never becomes ready", () =>
    Effect.gen(function* () {
      const terminated = yield* Ref.make(false);
      const failureReported = yield* Ref.make(false);
      const error = new BackendTimeoutError({ url: new URL("http://127.0.0.1:43123/") });

      yield* superviseBackendReadiness({
        readiness: Effect.fail(error),
        terminate: Ref.set(terminated, true),
        onReadinessFailure: () => Ref.set(failureReported, true),
      });

      expect(yield* Ref.get(failureReported)).toBe(true);
      expect(yield* Ref.get(terminated)).toBe(true);
    }),
  );

  it.effect("leaves a ready backend running", () =>
    Effect.gen(function* () {
      const terminated = yield* Ref.make(false);
      const ready = yield* Ref.make(false);

      yield* superviseBackendReadiness({
        readiness: Effect.void,
        terminate: Ref.set(terminated, true),
        onReady: () => Ref.set(ready, true),
      });

      expect(yield* Ref.get(ready)).toBe(true);
      expect(yield* Ref.get(terminated)).toBe(false);
    }),
  );
});
