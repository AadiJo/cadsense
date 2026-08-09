import { ThreadId } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

import {
  cadViewCommandStream,
  cadHierarchyRequestStream,
  claimCadHierarchyRequest,
  completeCadHierarchyRequest,
  publishCadControlCommand,
  requestCadHierarchy,
} from "./CadViewCommands.ts";
import { CAD_REQUEST_LEASE_MS } from "./CadRequestLease.ts";

describe("CadViewCommands", () => {
  it("replays recent CAD view commands to late subscribers", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const command = yield* publishCadControlCommand({
            type: "set-component-visibility",
            threadId: ThreadId.make("thread-late-cad-command-subscriber"),
            componentId: "drive",
            visible: false,
          });

          const events = yield* cadViewCommandStream.pipe(
            Stream.filter((event) => event.threadId === command.threadId),
            Stream.take(1),
            Stream.runCollect,
            Effect.timeout("1 second"),
          );
          const commands = Array.from(events);

          expect(commands).toHaveLength(1);
          expect(commands[0]).toMatchObject({
            commandId: command.commandId,
            threadId: "thread-late-cad-command-subscriber",
            type: "set-component-visibility",
            componentId: "drive",
            visible: false,
          });
        }),
      ),
    );
  });

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

          const claim = claimCadHierarchyRequest({
            requestId: request!.requestId,
            responderId: "viewer-hierarchy",
          });
          expect(claim.status).toBe("claimed");
          if (claim.status !== "claimed") return;

          expect(
            completeCadHierarchyRequest(
              request!.requestId,
              { responderId: "viewer-hierarchy", leaseId: claim.leaseId },
              {
                components: [
                  {
                    id: "component-1",
                    name: "Arm",
                    kind: "assembly",
                    hasChildren: false,
                    visible: true,
                  },
                ],
              },
            ),
          ).toBe(true);

          const result = yield* Fiber.join(requestFiber);
          expect(result.components.map((component) => component.id)).toEqual(["component-1"]);
        }),
      ),
    );
  });

  it("rejects competing and stale hierarchy responders after lease reclaim", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const requestFiber = yield* requestCadHierarchy(
            ThreadId.make("thread-hierarchy-lease"),
          ).pipe(Effect.forkScoped);
          yield* Effect.sleep("10 millis");
          const requests = yield* cadHierarchyRequestStream.pipe(
            Stream.filter((request) => request.threadId === "thread-hierarchy-lease"),
            Stream.take(1),
            Stream.runCollect,
            Effect.timeout("1 second"),
          );
          const request = Array.from(requests)[0]!;
          const first = claimCadHierarchyRequest(
            { requestId: request.requestId, responderId: "viewer-first" },
            5_000,
          );
          expect(first.status).toBe("claimed");
          if (first.status !== "claimed") return;
          expect(
            claimCadHierarchyRequest(
              { requestId: request.requestId, responderId: "viewer-loser" },
              5_001,
            ),
          ).toMatchObject({ status: "unavailable", reason: "already-claimed" });

          const second = claimCadHierarchyRequest(
            { requestId: request.requestId, responderId: "viewer-second" },
            5_000 + CAD_REQUEST_LEASE_MS,
          );
          expect(second.status).toBe("claimed");
          if (second.status !== "claimed") return;
          expect(second).toMatchObject({ attempt: 2 });
          expect(
            completeCadHierarchyRequest(
              request.requestId,
              { responderId: "viewer-first", leaseId: first.leaseId },
              { components: [] },
              5_000 + CAD_REQUEST_LEASE_MS + 1,
            ),
          ).toBe(false);
          expect(
            completeCadHierarchyRequest(
              request.requestId,
              { responderId: "viewer-second", leaseId: second.leaseId },
              { components: [], status: "loaded" },
              5_000 + CAD_REQUEST_LEASE_MS * 2 - 1,
            ),
          ).toBe(true);
          expect((yield* Fiber.join(requestFiber)).status).toBe("loaded");
        }),
      ),
    );
  });
});
