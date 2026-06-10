import {
  CadViewCommand,
  type CadControlInput,
  type CadHierarchyBrowserRequest,
  type CadHierarchyResult,
  type CadSetCameraInput,
  type CadSetViewInput,
} from "@cadsense/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Random from "effect/Random";
import * as Stream from "effect/Stream";

const CAD_BROWSER_PUBSUB_CAPACITY = 256;
const RECENT_CAD_VIEW_COMMAND_LIMIT = 128;
const RECENT_CAD_VIEW_COMMAND_REPLAY_WINDOW_MS = 60_000;

const cadViewCommandPubSub = Effect.runSync(
  PubSub.bounded<CadViewCommand>(CAD_BROWSER_PUBSUB_CAPACITY),
);
const cadHierarchyRequestPubSub = Effect.runSync(
  PubSub.bounded<CadHierarchyBrowserRequest>(CAD_BROWSER_PUBSUB_CAPACITY),
);

interface PendingCadHierarchyRequest {
  readonly deferred: Deferred.Deferred<CadHierarchyResult, Error>;
  readonly browserRequest: CadHierarchyBrowserRequest;
}

const pendingHierarchyByRequestId = new Map<string, PendingCadHierarchyRequest>();
const recentCadViewCommands: CadViewCommand[] = [];

function pruneRecentCadViewCommands(nowMs: number): void {
  while (recentCadViewCommands.length > RECENT_CAD_VIEW_COMMAND_LIMIT) {
    recentCadViewCommands.shift();
  }
  const firstFreshIndex = recentCadViewCommands.findIndex((command) => {
    const createdAtMs = Date.parse(command.createdAt);
    return (
      Number.isNaN(createdAtMs) || nowMs - createdAtMs <= RECENT_CAD_VIEW_COMMAND_REPLAY_WINDOW_MS
    );
  });
  if (firstFreshIndex > 0) {
    recentCadViewCommands.splice(0, firstFreshIndex);
  } else if (firstFreshIndex === -1) {
    recentCadViewCommands.length = 0;
  }
}

function rememberCadViewCommand(command: CadViewCommand, nowMs: number): void {
  recentCadViewCommands.push(command);
  pruneRecentCadViewCommands(nowMs);
}

export const cadViewCommandStream = Stream.unwrap(
  Effect.gen(function* () {
    const subscription = yield* PubSub.subscribe(cadViewCommandPubSub);
    pruneRecentCadViewCommands(yield* Clock.currentTimeMillis);
    return Stream.concat(
      Stream.fromIterable([...recentCadViewCommands]),
      Stream.fromSubscription(subscription),
    );
  }),
);
export const cadHierarchyRequestStream = Stream.unwrap(
  Effect.gen(function* () {
    const subscription = yield* PubSub.subscribe(cadHierarchyRequestPubSub);
    const pendingRequests = [...pendingHierarchyByRequestId.values()].map(
      (entry) => entry.browserRequest,
    );
    return Stream.concat(
      Stream.fromIterable(pendingRequests),
      Stream.fromSubscription(subscription),
    );
  }),
);

export const publishCadViewCommand = (input: CadSetViewInput): Effect.Effect<CadViewCommand> =>
  publishCadControlCommand({ type: "set-view", ...input });

export const publishCadCameraCommand = (input: CadSetCameraInput): Effect.Effect<CadViewCommand> =>
  publishCadControlCommand({ type: "set-camera", ...input });

export const publishCadControlCommand = (input: CadControlInput): Effect.Effect<CadViewCommand> =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const base = {
      commandId: yield* Random.nextUUIDv4,
      threadId: input.threadId,
      createdAt: DateTime.formatIso(now),
    };
    const command: CadViewCommand =
      input.type === "set-view"
        ? { ...base, type: input.type, view: input.view, fit: input.fit }
        : input.type === "set-camera"
          ? {
              ...base,
              type: input.type,
              direction: input.direction,
              ...(input.up === undefined ? {} : { up: input.up }),
              ...(input.distance === undefined ? {} : { distance: input.distance }),
              fit: input.fit,
              closeUp: input.closeUp,
            }
          : input.type === "set-component-visibility"
            ? { ...base, type: input.type, componentId: input.componentId, visible: input.visible }
            : input.type === "set-exploded"
              ? { ...base, type: input.type, exploded: input.exploded }
              : { ...base, type: input.type };
    rememberCadViewCommand(command, yield* Clock.currentTimeMillis);
    yield* PubSub.publish(cadViewCommandPubSub, command);
    return command;
  });

export const requestCadHierarchy = (
  threadId: CadHierarchyBrowserRequest["threadId"],
): Effect.Effect<CadHierarchyResult, Error> =>
  Effect.gen(function* () {
    const requestId = yield* Random.nextUUIDv4;
    const deferred = yield* Deferred.make<CadHierarchyResult, Error>();
    const browserRequest: CadHierarchyBrowserRequest = { requestId, threadId };
    pendingHierarchyByRequestId.set(requestId, { deferred, browserRequest });
    yield* PubSub.publish(cadHierarchyRequestPubSub, browserRequest);
    return yield* Deferred.await(deferred).pipe(
      Effect.ensuring(Effect.sync(() => pendingHierarchyByRequestId.delete(requestId))),
    );
  });

export function completeCadHierarchyRequest(
  requestId: string,
  result: CadHierarchyResult,
): boolean {
  const entry = pendingHierarchyByRequestId.get(requestId);
  if (!entry) {
    return false;
  }
  pendingHierarchyByRequestId.delete(requestId);
  Effect.runFork(Deferred.succeed(entry.deferred, result));
  return true;
}
