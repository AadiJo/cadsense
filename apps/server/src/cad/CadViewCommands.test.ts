import { ThreadId } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

import {
  cadHierarchyRequestStream,
  completeCadHierarchyRequest,
  requestCadHierarchy,
} from "./CadViewCommands.ts";

describe("CadViewCommands", () => {
  it("replays pending hierarchy requests to late subscribers", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const requestFiber = yield* requestCadHierarchy(
            ThreadId.make("thread-late-cad-hierarchy-subscriber"),
          ).pipe(Effect.forkScoped);
          yield* Effect.sleep("10 millis");

          const events = yield* cadHierarchyRequestStream.pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.timeout("1 second"),
          );
          const requests = Array.from(events);
          const request = requests[0];

          expect(requests).toHaveLength(1);
          expect(request?.threadId).toBe("thread-late-cad-hierarchy-subscriber");

          expect(
            completeCadHierarchyRequest(request!.requestId, {
              components: [
                {
                  id: "component-1",
                  name: "Arm",
                  kind: "assembly",
                  hasChildren: false,
                  visible: true,
                },
              ],
            }),
          ).toBe(true);

          const result = yield* Fiber.join(requestFiber);
          expect(result.components.map((component) => component.id)).toEqual(["component-1"]);
        }),
      ),
    );
  });
});
