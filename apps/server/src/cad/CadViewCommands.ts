import {
  CadViewCommand,
  type CadControlInput,
  type CadHierarchyBrowserRequest,
  type CadHierarchyResult,
  type CadSetCameraInput,
  type CadSetViewInput,
} from "@cadsense/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Random from "effect/Random";
import * as Stream from "effect/Stream";

const cadViewCommandPubSub = Effect.runSync(PubSub.unbounded<CadViewCommand>());
const cadHierarchyRequestPubSub = Effect.runSync(PubSub.unbounded<CadHierarchyBrowserRequest>());
const pendingHierarchyByRequestId = new Map<string, Deferred.Deferred<CadHierarchyResult, Error>>();

export const cadViewCommandStream = Stream.fromPubSub(cadViewCommandPubSub);
export const cadHierarchyRequestStream = Stream.fromPubSub(cadHierarchyRequestPubSub);

export const publishCadViewCommand = (input: CadSetViewInput): Effect.Effect<CadViewCommand> =>
  publishCadControlCommand({ type: "set-view", ...input });

export const publishCadCameraCommand = (input: CadSetCameraInput): Effect.Effect<CadViewCommand> =>
  publishCadControlCommand({ type: "set-camera", ...input });

export const publishCadControlCommand = (input: CadControlInput): Effect.Effect<CadViewCommand> =>
  Effect.gen(function* () {
    const base = {
      commandId: yield* Random.nextUUIDv4,
      threadId: input.threadId,
      createdAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
    };
    const command: CadViewCommand =
      input.type === "set-view"
        ? { ...base, type: input.type, view: input.view, fit: input.fit }
        : input.type === "set-camera"
          ? input.up === undefined
            ? {
                ...base,
                type: input.type,
                direction: input.direction,
                fit: input.fit,
                closeUp: input.closeUp,
              }
            : {
                ...base,
                type: input.type,
                direction: input.direction,
                up: input.up,
                fit: input.fit,
                closeUp: input.closeUp,
              }
          : input.type === "set-component-visibility"
            ? { ...base, type: input.type, componentId: input.componentId, visible: input.visible }
            : input.type === "set-exploded"
              ? { ...base, type: input.type, exploded: input.exploded }
              : { ...base, type: input.type };
    yield* PubSub.publish(cadViewCommandPubSub, command);
    return command;
  });

export const requestCadHierarchy = (
  threadId: CadHierarchyBrowserRequest["threadId"],
): Effect.Effect<CadHierarchyResult, Error> =>
  Effect.gen(function* () {
    const requestId = yield* Random.nextUUIDv4;
    const deferred = yield* Deferred.make<CadHierarchyResult, Error>();
    pendingHierarchyByRequestId.set(requestId, deferred);
    yield* PubSub.publish(cadHierarchyRequestPubSub, { requestId, threadId });
    return yield* Deferred.await(deferred).pipe(
      Effect.ensuring(Effect.sync(() => pendingHierarchyByRequestId.delete(requestId))),
    );
  });

export function completeCadHierarchyRequest(
  requestId: string,
  result: CadHierarchyResult,
): boolean {
  const deferred = pendingHierarchyByRequestId.get(requestId);
  if (!deferred) {
    return false;
  }
  pendingHierarchyByRequestId.delete(requestId);
  Effect.runFork(Deferred.succeed(deferred, result));
  return true;
}
