import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";

import * as CodexError from "./errors.ts";
import * as CodexProtocol from "./protocol.ts";
import * as CodexSchema from "./schema.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";
const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

const encoder = new TextEncoder();

const encodeJsonl = (value: unknown) => encoder.encode(`${encodeUnknownJsonString(value)}\n`);

const decodeJson = Schema.decodeEffect(Schema.UnknownFromJsonString);
const decodeModelListResponse = Schema.decodeUnknownSync(CodexSchema.V2ModelListResponse);
const decodeTurnStartParams = Schema.decodeUnknownSync(CodexSchema.V2TurnStartParams);

it("accepts reasoning efforts added after the client was generated", () => {
  const modelList = decodeModelListResponse({
    data: [
      {
        defaultReasoningEffort: "ultra",
        description: "Future reasoning model",
        displayName: "GPT Test",
        hidden: false,
        id: "gpt-test",
        isDefault: true,
        model: "gpt-test",
        supportedReasoningEfforts: [
          {
            description: "A newly introduced reasoning mode",
            reasoningEffort: "ultra",
          },
        ],
      },
    ],
  });
  const turnStart = decodeTurnStartParams({
    effort: "ultra",
    input: [],
    threadId: "thread-1",
  });

  assert.equal(modelList.data[0]?.defaultReasoningEffort, "ultra");
  assert.equal(turnStart.effort, "ultra");
});

it.layer(NodeServices.layer)("effect-codex-app-server protocol", (it) => {
  it.effect("keeps callbacks responsive when mirrored streams are not consumed", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const notifications = yield* Ref.make<string[]>([]);
      const requests = yield* Ref.make<number[]>([]);
      const secondNotificationHandled = yield* Deferred.make<void>();
      const secondRequestHandled = yield* Deferred.make<void>();
      yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        incomingQueueCapacity: 1,
        onNotification: (notification) =>
          Ref.update(notifications, (current) => [...current, notification.method]).pipe(
            Effect.andThen(
              notification.method === "notification/two"
                ? Deferred.succeed(secondNotificationHandled, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ),
          ),
        onRequest: (request) =>
          Ref.update(requests, (current) => [...current, Number(request.id)]).pipe(
            Effect.andThen(
              request.id === 2
                ? Deferred.succeed(secondRequestHandled, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ),
            Effect.as({ ok: true }),
          ),
      });

      for (const message of [
        { method: "notification/one" },
        { method: "notification/two" },
        { id: 1, method: "request/one" },
        { id: 2, method: "request/two" },
      ]) {
        yield* Queue.offer(input, encodeJsonl(message));
      }

      yield* Deferred.await(secondNotificationHandled);
      yield* Deferred.await(secondRequestHandled);
      assert.deepEqual(yield* Ref.get(notifications), [
        "notification/one",
        "notification/two",
      ]);
      assert.deepEqual(yield* Ref.get(requests), [1, 2]);
    }),
  );

  it.effect(
    "encodes requests without a jsonrpc field and routes inbound requests and notifications",
    () =>
      Effect.gen(function* () {
        const { stdio, input, output } = yield* makeInMemoryStdio();
        const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio });

        const notificationDeferred =
          yield* Deferred.make<ReadonlyArray<CodexProtocol.CodexAppServerIncomingNotification>>();
        const requestDeferred =
          yield* Deferred.make<ReadonlyArray<CodexProtocol.CodexAppServerIncomingRequest>>();

        yield* transport.incomingNotifications.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.flatMap((notifications) => Deferred.succeed(notificationDeferred, notifications)),
          Effect.forkScoped,
        );

        yield* transport.incomingRequests.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.flatMap((requests) => Deferred.succeed(requestDeferred, requests)),
          Effect.forkScoped,
        );

        yield* transport.notify("initialized");
        assert.equal(yield* Queue.take(output), '{"method":"initialized"}\n');

        const initializeParams = {
          clientInfo: {
            name: "effect-codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        };

        const pendingInitialize = yield* transport
          .request("initialize", initializeParams)
          .pipe(Effect.forkScoped);
        assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
          id: 1,
          method: "initialize",
          params: initializeParams,
        });

        yield* Queue.offer(
          input,
          encodeJsonl({
            method: "item/agentMessage/delta",
            params: {
              delta: "Hello from the mock peer.",
              itemId: "item-1",
              threadId: "thread-1",
              turnId: "turn-1",
            },
          }),
        );
        yield* Queue.offer(
          input,
          encodeJsonl({
            id: 77,
            method: "item/tool/requestUserInput",
            params: {
              itemId: "item-approval-1",
              threadId: "thread-1",
              turnId: "turn-1",
              questions: [
                {
                  id: "approved",
                  header: "Approve",
                  question: "Continue?",
                },
              ],
            },
          }),
        );
        yield* Queue.offer(
          input,
          encodeJsonl({
            id: 1,
            result: {
              userAgent: "mock-codex-app-server",
              codexHome: "/tmp/codex-home",
              platformFamily: "unix",
              platformOs: "macos",
            },
          }),
        );

        assert.deepEqual(yield* Fiber.join(pendingInitialize), {
          userAgent: "mock-codex-app-server",
          codexHome: "/tmp/codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        });
        assert.deepEqual(yield* Deferred.await(notificationDeferred), [
          {
            method: "item/agentMessage/delta",
            params: {
              delta: "Hello from the mock peer.",
              itemId: "item-1",
              threadId: "thread-1",
              turnId: "turn-1",
            },
          },
        ]);
        assert.deepEqual(yield* Deferred.await(requestDeferred), [
          {
            id: 77,
            method: "item/tool/requestUserInput",
            params: {
              itemId: "item-approval-1",
              threadId: "thread-1",
              turnId: "turn-1",
              questions: [
                {
                  id: "approved",
                  header: "Approve",
                  question: "Continue?",
                },
              ],
            },
          },
        ]);

        yield* transport.respond(77, {
          answers: {
            approved: {
              answers: ["yes"],
            },
          },
        });
        assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
          id: 77,
          result: {
            answers: {
              approved: {
                answers: ["yes"],
              },
            },
          },
        });

        yield* transport.respondError(
          78,
          CodexError.CodexAppServerRequestError.methodNotFound("x/test"),
        );
        assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
          id: 78,
          error: {
            code: -32601,
            message: "Method not found: x/test",
          },
        });
      }),
  );

  it.effect("surfaces JSON encoding failures as protocol parse errors", () =>
    Effect.gen(function* () {
      const { stdio } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio });

      const bigintError = yield* transport.notify("x/test", 1n).pipe(Effect.flip);
      assert.instanceOf(bigintError, CodexError.CodexAppServerProtocolParseError);
      assert.equal(bigintError.detail, "Failed to encode Codex App Server message");

      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const circularError = yield* transport.notify("x/test", circular).pipe(Effect.flip);
      assert.instanceOf(circularError, CodexError.CodexAppServerProtocolParseError);
      assert.equal(circularError.detail, "Failed to encode Codex App Server message");
    }),
  );

  it.effect("fails pending requests when the peer does not respond before the timeout", () =>
    Effect.gen(function* () {
      const { stdio, output } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        requestTimeout: 0,
        stdio,
      });

      const pendingRequest = yield* transport.request("initialize", {}).pipe(
        Effect.match({
          onFailure: (error) => ({ _tag: "Failure" as const, error }),
          onSuccess: (value) => ({ _tag: "Success" as const, value }),
        }),
        Effect.forkScoped,
      );

      assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
        id: 1,
        method: "initialize",
        params: {},
      });
      const timeoutResult = yield* Fiber.join(pendingRequest);
      if (timeoutResult._tag !== "Failure") {
        assert.fail("Expected request to time out");
      }
      const timeoutError = timeoutResult.error;
      assert.instanceOf(timeoutError, CodexError.CodexAppServerTransportError);
      assert.equal(timeoutError.detail, "Codex App Server request timed out: initialize");
    }),
  );
});
