import { CadViewCommand, type CadSetViewInput } from "@cadsense/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Random from "effect/Random";
import * as Stream from "effect/Stream";

const cadViewCommandPubSub = Effect.runSync(PubSub.unbounded<CadViewCommand>());

export const cadViewCommandStream = Stream.fromPubSub(cadViewCommandPubSub);

export const publishCadViewCommand = (input: CadSetViewInput): Effect.Effect<CadViewCommand> =>
  Effect.gen(function* () {
    const command: CadViewCommand = {
      commandId: yield* Random.nextUUIDv4,
      threadId: input.threadId,
      view: input.view,
      fit: input.fit,
      createdAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
    };
    yield* PubSub.publish(cadViewCommandPubSub, command);
    return command;
  });
