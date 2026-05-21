import { ThreadId } from "@cadsense/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface CadViewSchedulerShape {
  readonly enqueue: <A, E = never, R = never>(
    threadId: ThreadId,
    operationId: string,
    operation: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

export class CadViewScheduler extends Context.Service<CadViewScheduler, CadViewSchedulerShape>()(
  "cadsense/cad/CadViewScheduler",
) {}

const make = Effect.sync(() => {
  const tails = new Map<string, Promise<void>>();

  const enqueue: CadViewSchedulerShape["enqueue"] = (threadId, operationId, operation) =>
    Effect.contextWith((context) =>
      Effect.promise(() => {
        const previous = tails.get(threadId) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => {
          release = resolve;
        });
        tails.set(
          threadId,
          previous.then(
            () => current,
            () => current,
          ),
        );
        return previous.then(async () => {
          try {
            return await Effect.runPromise(operation.pipe(Effect.provideContext(context)));
          } finally {
            release();
            if (tails.get(threadId) === current) {
              tails.delete(threadId);
            }
            void operationId;
          }
        });
      }),
    );

  return { enqueue } satisfies CadViewSchedulerShape;
});

export const CadViewSchedulerLive = Layer.effect(CadViewScheduler, make);
